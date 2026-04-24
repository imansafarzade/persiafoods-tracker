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

    const binaryStr = Buffer.from(imageBase64, 'base64');
    const { FormData, Blob } = await import('node-fetch');
    const formData = new FormData();
    const blob = new Blob([binaryStr], { type: mimeType || 'application/pdf' });
    formData.append('document', blob, 'invoice.pdf');

    const mindeeRes = await fetch('https://api.mindee.net/v1/products/mindee/invoices/v4/predict', {
      method: 'POST',
      headers: { 'Authorization': `Token ${mindeeKey}` },
      body: formData,
    });

    const mindeeData = await mindeeRes.json();
    if (mindeeData.api_request?.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: { message: JSON.stringify(mindeeData.api_request.error) } }) };
    }

    const prediction = mindeeData?.document?.inference?.prediction;
    const items = (prediction?.line_items || []).map(item => ({
      code: item.product_code?.value || '',
      name: item.description?.value || '',
      price: parseFloat(item.unit_price?.value || 0),
      unit: item.unit_measure?.value || 'each',
    })).filter(i => i.name && i.price > 0);

    return { statusCode: 200, headers, body: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(items) }] }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
