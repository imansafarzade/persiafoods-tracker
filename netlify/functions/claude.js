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
    const modelId = '16f85210-31f1-4f02-892b-ff650cdb8dd8';

    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const filename = (mimeType === 'application/pdf') ? 'invoice.pdf' : 'invoice.jpg';

    const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\n${modelId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="rag"\r\n\r\nfalse\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType || 'application/pdf'}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(headerStr, 'utf8');
    const fileBuf   = Buffer.from(imageBase64, 'base64');
    const footerBuf = Buffer.from(footer, 'utf8');
    const body      = Buffer.concat([headerBuf, fileBuf, footerBuf]);

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
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'No polling URL: ' + JSON.stringify(enqueueData) } }) };
    }

    let result = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(pollingUrl, {
        headers: { 'Authorization': mindeeKey }
      });
      const pollData = await pollRes.json();
      if (pollData?.job?.status === 'Processed' || pollData?.inference) {
        result = pollData;
        break;
      }
    }

    if (!result) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Timeout waiting for Mindee result' } }) };
    }

    // Log full result for debugging
    const rawResult = JSON.stringify(result).slice(0, 500);
    
    const fields = result?.inference?.result?.fields || 
                   result?.document?.inference?.prediction || 
                   result?.job?.result?.fields || {};
    
    const items = [];
    const lineItems = Array.isArray(fields.line_items) ? fields.line_items : 
                      Array.isArray(fields.lineItems) ? fields.lineItems : [];

    for (const item of lineItems) {
      const name  = item.description?.value || item.name?.value || '';
      const price = parseFloat(item.unit_price?.value || item.price?.value || 0);
      if (name && price > 0) {
        items.push({
          code:  item.product_code?.value || '',
          name, price,
          unit:  item.unit_measure?.value || 'each',
        });
      }
    }

    // If no items found, return raw for debugging
    if (items.length === 0) {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ error: { message: 'No items found. Raw: ' + rawResult } })
      };
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(items) }] })
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
