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

    const headerStr = `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: ${mimeType || 'application/pdf'}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(headerStr, 'utf8');
    const fileBuf   = Buffer.from(imageBase64, 'base64');
    const footerBuf = Buffer.from(footer, 'utf8');
    const body      = Buffer.concat([headerBuf, fileBuf, footerBuf]);

    const mindeeRes = await fetch(
      `https://api.mindee.net/v2/inferences`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${mindeeKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'X-Mindee-Model-Id': modelId,
        },
        body,
      }
    );

    const text = await mindeeRes.text();
    let mindeeData;
    try { mindeeData = JSON.parse(text); } catch(_) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: { message: 'Mindee: ' + text.slice(0, 300) } }) };
    }

    if (!mindeeRes.ok) {
      return { statusCode: mindeeRes.status, headers, body: JSON.stringify({ error: { message: JSON.stringify(mindeeData) } }) };
    }

    const fields = mindeeData?.inference?.result?.fields || {};
    const items = [];
    
    if (fields.line_items) {
      for (const item of fields.line_items) {
        const name = item.description?.value || '';
        const price = parseFloat(item.unit_price?.value || 0);
        if (name && price > 0) {
          items.push({
            code: item.product_code?.value || '',
            name, price,
            unit: item.unit_measure?.value || 'each',
          });
        }
      }
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(items) }] })
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
