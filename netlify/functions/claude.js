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
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'No text extracted' } }) };
    }

    // Parse prices from raw text using pattern matching
    const items = [];
    const lines = rawText.split('\n');

    for (const line of lines) {
      // Skip header/footer lines
      if (!line.trim() || line.length < 5) continue;
      if (/invoice|total|subtotal|tax|gst|hst|date|terms|ship|bill|phone|fax|page|address/i.test(line)) continue;

      // Look for price patterns: number followed by /CS, /EA, /KG, /LB or standalone price
      const priceMatch = line.match(/\$?\s*(\d+\.?\d*)\s*\/?\s*(CS|EA|KG|LB|EACH|CASE|PC|BOX|BAG|PKG|TIN|JAR|BTL)?/i);
      if (!priceMatch) continue;

      const price = parseFloat(priceMatch[1]);
      if (price < 0.5 || price > 9999) continue; // filter out quantities and invalid prices

      // Extract product name — everything before the price
      const beforePrice = line.substring(0, line.indexOf(priceMatch[0])).trim();
      if (!beforePrice || beforePrice.length < 3) continue;

      // Clean up name
      const name = beforePrice
        .replace(/^\d+\s+/, '') // remove leading numbers (qty)
        .replace(/\s+/g, ' ')
        .trim();

      if (name.length < 3) continue;

      const unit = priceMatch[2] ? priceMatch[2].toUpperCase() : 'each';

      items.push({ code: '', name, price, unit });
    }

    // Deduplicate by name
    const seen = new Set();
    const unique = items.filter(i => {
      if (seen.has(i.name)) return false;
      seen.add(i.name);
      return true;
    });

    if (unique.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: { message: 'No prices found in: ' + rawText.slice(0, 200) } }) };
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(unique) }] })
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
