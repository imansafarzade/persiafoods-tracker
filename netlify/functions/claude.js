exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }
  try {
    const req = JSON.parse(event.body);
    const apiKey = process.env.GEMINI_API_KEY;
    const contents = [];
    for (const msg of req.messages) {
      const parts = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image') {
            parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
          }
        }
      } else {
        parts.push({ text: msg.content });
      }
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
    }
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 8192 } })
      }
    );
    const geminiData = await geminiRes.json();
    if (geminiData.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: { message: geminiData.error.message } }) };
    }
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { statusCode: 200, headers, body: JSON.stringify({ content: [{ type: 'text', text }] }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
