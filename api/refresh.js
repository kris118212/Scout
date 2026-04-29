const LEAGUES = [
  {id:"PL", name:"Premier League", flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿"},
  {id:"ELC",name:"Championship",   flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿"},
  {id:"PD", name:"La Liga",        flag:"🇪🇸"},
  {id:"BL1",name:"Bundesliga",     flag:"🇩🇪"},
  {id:"FL1",name:"Ligue 1",        flag:"🇫🇷"},
  {id:"SA", name:"Serie A",        flag:"🇮🇹"},
  {id:"DED",name:"Eredivisie",     flag:"🇳🇱"},
  {id:"PPL",name:"Primeira Liga",  flag:"🇵🇹"}
];

async function fdFetch(path) {
  const r = await fetch("https://api.football-data.org/v4" + path, {
    headers: { "X-Auth-Token": process.env.FD_KEY }
  });
  return r.json();
}

async function callClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await r.json();
  return data.content?.[0]?.text || "";
}

async function kvSet(key, value) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(value)
  });
  return r.json();
}

function parseLeagues(raw) {
  const txt = raw.replace(/```json|```/g, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s === -1 || e === -1) return [];
  try {
    const fixed = txt.slice(s, e + 1).replace(/,(\s*)(}|])/g, "$1$2");
    return JSON.parse(fixed).leagues || [];
  } catch(err) {
    const leagues = [];
    let start = txt.indexOf('"league"');
    while (start > -1) {
      const objStart = txt.lastIndexOf("{", start);
      let depth = 0, i = objStart, found = false;
      for (; i < txt.length; i++) {
        if (txt[i] === "{") depth++;
        else if (txt[i] === "}") { depth--; if (depth === 0) { found = true; break; } }
      }
      if (found) {
        try {
          const lg = JSON.parse(txt.slice(objStart, i + 1));
          if (lg.league && lg.picks) leagues.push(lg);
        } catch(e2) {}
      }
      start = txt.indexOf('"league"', start + 1);
    }
    return leagues;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const authHeader = req.headers.authorization;
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const hasSecret = req.query.secret === process.env.CRON_SECRET;
  const hasBearerSecret = authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isVercelCron && !hasSecret && !hasBearerSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = new Date();
    const fmt = d => d.toISOString().split("T")[0];
    const end14 = new Date(now); end14.setDate(now.getDate() + 14);

    let trendsMap = {};
    try {
      const tData = await fdFetch(`/trends/?dateFrom=${fmt(now)}&dateTo=${fmt(end14)}&window=5`);
      (tData.trends || []).forEach(t => {
        const hName = t.homeTeam?.shortName || t.homeTeam?.name || "";
        const aName = t.awayTeam?.shortName || t.awayTeam?.name || "";
        if (hName && aName) trendsMap[`${hName}|${aName}`] = t.trend;
      });
    } catch(e) {}

    const leagueData = await Promise.all(LEAGUES.map(async lg => {
      const [fixturesData, standingsData] = await Promise.all([
        fdFetch(`/competitions/${lg.id}/matches?dateFrom=${fmt(now)}&dateTo=${fmt(end14)}`).catch(() => ({})),
        fdFetch(`/competitions/${lg.id}/standings`).catch(() => ({}))
      ]);

      const finished = ["FINISHED","IN_PLAY","PAUSED","SUSPENDED","CANCELLED","POSTPONED"];
      const fixtures = (fixturesData.matches || [])
        .filter(m => !finished.includes(m.status))
        .map(m => ({
          home: m.homeTeam?.shortName || m.homeTeam?.name || "TBC",
          away: m.awayTeam?.shortName || m.awayTeam?.name || "TBC",
          date: new Date(m.utcDate).toLocaleDateString("en-GB", {weekday:"short",day:"numeric",month:"short"}),
          time: new Date(m.utcDate).toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit"}),
          utc: m.utcDate,
          status: m.status
        }));

      let standings = [];
      if (standingsData.standings) {
        for (const s of standingsData.standings) {
          if (s.type === "TOTAL") { standings = s.table || []; break; }
        }
      }

      return { ...lg, fixtures, standings, trendMap: trendsMap };
    }));

    const makePrompt = (batch) => {
      const today = now.toLocaleDateString("en-GB", {weekday:"long",day:"numeric",month:"long",year:"numeric"});
      const end14str = end14.toLocaleDateString("en-GB", {weekday:"short",day:"numeric",month:"long",year:"numeric"});

      const dataSummary = batch.map(lg => {
        const fxLines = lg.fixtures.slice(0, 10).map((f, i) => {
          const td = lg.trendMap?.[`${f.home}|${f.away}`];
          const trendStr = td
            ? ` [Home form:${td.home?.form||"?"} avg scored:${td.home?.avg_goals_scored?.toFixed(1)||"?"} BTTS:${td.home?.pct_bts!=null?Math.round(td.home.pct_bts*100)+"%":"?"} | Away form:${td.away?.form||"?"} avg scored:${td.away?.avg_goals_scored?.toFixed(1)||"?"} BTTS:${td.away?.pct_bts!=null?Math.round(td.away.pct_bts*100)+"%":"?"}]`
            : "";
          return `${i+1}. ${f.home} vs ${f.away} — ${f.date} ${f.time}${trendStr}`;
        }).join("\n");
        const tableLines = lg.standings.slice(0, 6).map(t =>
          `${t.position}. ${t.team?.shortName||t.team?.name} (${t.points}pts GD:${t.goalDifference})`
        ).join("\n");
        const botLines = lg.standings.slice(-3).map(t =>
          `${t.position}. ${t.team?.shortName||t.team?.name} (${t.points}pts - relegation)`
        ).join("\n");
        return `LEAGUE: ${lg.name} ${lg.flag}\nFIXTURES:\n${fxLines||"none"}\nTOP 6:\n${tableLines||"none"}\nBOTTOM 3:\n${botLines||"none"}`;
      }).join("\n\n---\n\n");

      return `Today is ${today}. Fixtures window: ${today} to ${end14str}.

You are an expert football betting analyst. Use the LIVE data and trend statistics below.

${dataSummary}

TASK: For each league, pick up to 5 fixtures and provide betting analysis.

Return ONLY raw JSON starting with {:
{"leagues":[{"league":"name","flag":"emoji","context":"one sentence","picks":[{"home":"team","away":"team","date":"date","time":"time","primary":{"pick":"[Team] to Score","xg":1.8,"odds":"1.55","confidence":"High","reason":"2 sentences","injuries":"key injuries or None"},"builders":[{"name":"[Team] Win","odds":"1.60","confidence":"High"},{"name":"Over 1.5 Goals","odds":"1.45","confidence":"High"},{"name":"BTTS","odds":"1.70","confidence":"Medium"}],"combo":{"name":"Win + Goals","picks":["[Team] Win","Over 1.5 Goals"],"odds":"2.35","reason":"brief reason"},"form":[{"result":"W","score":"2-0","xg":2.1,"actual":2},{"result":"D","score":"1-1","xg":1.3,"actual":1},{"result":"W","score":"3-1","xg":2.4,"actual":3},{"result":"L","score":"0-1","xg":0.9,"actual":0},{"result":"W","score":"2-1","xg":1.7,"actual":2}],"tags":["tag1","tag2"]}]}]}

RULES:
- primary.pick MUST always be "[Team] to Score" e.g. "Arsenal to Score"
- NEVER put to score or over 0.5 in builders — primary only
- NEVER suggest Over 2.5 Goals — maximum Over 1.5 Goals
- builders: 3 picks that combine well — Win/Double Chance, Over 1.5, BTTS, or HT/FT
- combo: ONE combination of 2-3 builder picks with a SINGLE combined odds value e.g. "2.80"
- form: 5 items most recent first
- No markdown fences`;
    };

    const [rawA, rawB, rawC] = await Promise.all([
      callClaude(makePrompt(leagueData.slice(0, 3))),
      callClaude(makePrompt(leagueData.slice(3, 6))),
      callClaude(makePrompt(leagueData.slice(6)))
    ]);

    const allLeagues = [
      ...parseLeagues(rawA),
      ...parseLeagues(rawB),
      ...parseLeagues(rawC)
    ];

    allLeagues.forEach(lg => {
      const live = leagueData.find(r => r.name === lg.league);
      if (live) { lg.standings = live.standings; lg.cfg = live; }
    });

    const payload = {
      leagues: allLeagues,
      leagueData: leagueData.map(lg => ({
        id: lg.id, name: lg.name, flag: lg.flag,
        fixtures: lg.fixtures, standings: lg.standings
      })),
      updatedAt: now.toISOString()
    };

    await kvSet("scout_data", JSON.stringify(payload));
    await kvSet("scout_updated", now.toISOString());

    res.status(200).json({ ok: true, leagues: allLeagues.length, updatedAt: now.toISOString() });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
