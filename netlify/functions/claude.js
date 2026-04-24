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
    const geminiKey = process.env.GEMINI_API_KEY;
    const modelId = 'c794b456-716f-4e8a-b693-700489a3f3a9';

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const filename = (mimeType === 'application/pdf') ? 'invoice.pdf' : 'invoice.jpg';

    const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\n${modelId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="rag"\r\n\r\nfalse\r\n--${boundary}\r\nContent-Disposition: form-data; name="raw_text"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType || 'application/pdf'}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(headerStr, 'utf8'),
      Buffer.from(imageBase64, 'base64'),
      Buffer.from(footer, 'utf8')
    ]);

    const enqueueRes = await fetch('https://api-v2.mindee.net/v2/inferences/enqueue', {
      method: 'POST',
      headers: {
        'Authorization': mindeeKey,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const enqueueData = await enqueueRes.json();
    if (!enqueueRes.ok) {
      return { statusCode: enqueueRes.status, headers, body: JSON.stringify({ error: { message: JSON.stringify(enqueueData) } }) };
    }

    const pollingUrl = enqueueData?.job?.polling_url;
    if (!pollingUrl) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'No polling URL' } }) };
    }

    let result = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(pollingUrl, { headers: { 'Authorization': mindeeKey } });
      const pollData = await pollRes.json();
      if (pollData?.inference || pollData?.job?.status === 'Processed') {
        result = pollData;
        break;
      }
    }

    if (!result) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Timeout' } }) };
    }

    const rawText = result?.inference?.result?.raw_text?.pages
      ?.map(p => p.content).join('\n') || '';

    if (!rawText) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'No text from document' } }) };
    }

    // Send to Gemini as text (free)
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: `Extract ALL product prices from this supplier invoice.
Return ONLY a valid JSON array, no markdown, no explanation.
Each item: {"code":"","name":"","price":0.00,"unit":""}
- price must be a number
- unit examples: each, kg, lb, case

Invoice text:
${rawText.slice(0, 10000)}` }]
          }],
          generationConfig: { maxOutputTokens: 4096 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    if (geminiData.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: { message: 'Gemini: ' + geminiData.error.message } }) };
    }

    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const clean = text.replace(/```json|```/g, '').trim();

    let items;
    try { items = JSON.parse(clean); } catch(_) {
      const m = clean.match(/\[[\s\S]*\]/);
      items = m ? JSON.parse(m[0]) : [];
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(items) }] })
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
