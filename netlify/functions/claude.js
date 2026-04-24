exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body);
    const mindeeKey = process.env.MINDEE_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const modelId = 'c794b456-716f-4e8a-b693-700489a3f3a9';

    // ── Step 1: Send to Mindee ──────────────────────────────────────────────
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const filename = mimeType === 'application/pdf' ? 'invoice.pdf' : 'invoice.jpg';

    const headerStr =
      `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\n${modelId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="rag"\r\n\r\nfalse\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="raw_text"\r\n\r\ntrue\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType || 'application/pdf'}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(headerStr, 'utf8'),
      Buffer.from(imageBase64, 'base64'),
      Buffer.from(footer, 'utf8'),
    ]);

    const enqueueRes = await fetch('https://api-v2.mindee.net/v2/inferences/enqueue', {
      method: 'POST',
      headers: {
        Authorization: mindeeKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const enqueueData = await enqueueRes.json();
    if (!enqueueRes.ok) {
      return {
        statusCode: enqueueRes.status,
        headers,
        body: JSON.stringify({ error: { message: JSON.stringify(enqueueData) } }),
      };
    }

    const pollingUrl = enqueueData?.job?.polling_url;
    if (!pollingUrl) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'No polling URL from Mindee' } }) };
    }

    // ── Step 2: Poll Mindee ─────────────────────────────────────────────────
    let mindeeResult = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(pollingUrl, { headers: { Authorization: mindeeKey } });
      const pollData = await pollRes.json();
      if (pollData?.inference || pollData?.job?.status === 'Processed') {
        mindeeResult = pollData;
        break;
      }
    }

    if (!mindeeResult) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Mindee timeout' } }) };
    }

    const rawText = mindeeResult?.inference?.result?.raw_text?.pages
      ?.map(p => p.content)
      .join('\n') || '';

    if (!rawText) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'No text extracted from Mindee' } }) };
    }

    // ── Step 3: Send to Groq ────────────────────────────────────────────────
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4000,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are a data extraction assistant. Extract ALL products from supplier invoices. Return ONLY a valid JSON array with no markdown, no backticks, no explanation.',
          },
          {
            role: 'user',
            content: `Extract ALL products from this supplier invoice text.

Return ONLY a JSON array. Each item must have exactly:
{ "code": "string", "name": "string", "price": number, "unit": "string" }

Rules:
- "price" must be a number (e.g. 39.99), the case or unit price
- "unit" is CS, EA, KG, LB, etc. Default "CS" if unclear
- "code" is the product/item code, or "" if not present
- "name" is the product description — keep it clean and recognizable
- Skip header rows, totals, subtotals, taxes, shipping lines
- Extract EVERY single product line — do not skip any

Invoice text:
${rawText}`,
          },
        ],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Groq API error: ' + errText } }) };
    }

    const groqData = await groqRes.json();
    const groqText = groqData?.choices?.[0]?.message?.content || '';

    if (!groqText) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Empty response from Groq' } }) };
    }

    // ── Step 4: Parse JSON ──────────────────────────────────────────────────
    let items = [];
    try {
      const clean = groqText.replace(/```json|```/g, '').trim();
      items = JSON.parse(clean);
    } catch (e) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: { message: 'Failed to parse Groq response: ' + groqText.slice(0, 300) } }),
      };
    }

    if (!Array.isArray(items) || items.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: { message: 'No products found in invoice' } }) };
    }

    // ── Step 5: Sanitize & deduplicate ──────────────────────────────────────
    const seen = new Set();
    const unique = items
      .filter(item => {
        if (!item.name || typeof item.price !== 'number') return false;
        const key = item.name.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(item => ({
        code: String(item.code || '').trim(),
        name: String(item.name).trim(),
        price: Math.round(item.price * 100) / 100,
        unit: String(item.unit || 'CS').toUpperCase().trim(),
      }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(unique) }] }),
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: { message: e.message } }),
    };
  }
};
