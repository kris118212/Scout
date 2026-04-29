async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
  });
  const data = await r.json();
  return data.result;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300");
  try {
    const raw = await kvGet("scout_data");
    if (!raw) return res.status(404).json({ error: "No data yet" });
    
    // Handle both string and object (Upstash may return either)
    let data;
    if (typeof raw === "string") {
      data = JSON.parse(raw);
    } else {
      data = raw;
    }
    
    // If still a string (double-encoded), parse again
    if (typeof data === "string") {
      data = JSON.parse(data);
    }
    
    res.status(200).json(data);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
}
