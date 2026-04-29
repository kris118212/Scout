export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  
  const path = req.url.replace('/api/football', '');
  
  try {
    const response = await fetch('https://api.football-data.org/v4' + path, {
      headers: { 'X-Auth-Token': process.env.FD_KEY }
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
