const LEAGUES = [
  {id:"PL",  name:"Premier League", flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", afId:39,  season:2025},
  {id:"ELC", name:"Championship",   flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", afId:180, season:2025},
  {id:"PD",  name:"La Liga",        flag:"🇪🇸",         afId:140, season:2025},
  {id:"BL1", name:"Bundesliga",     flag:"🇩🇪",         afId:78,  season:2025},
  {id:"FL1", name:"Ligue 1",        flag:"🇫🇷",         afId:61,  season:2025},
  {id:"SA",  name:"Serie A",        flag:"🇮🇹",         afId:135, season:2025},
  {id:"DED", name:"Eredivisie",     flag:"🇳🇱",         afId:88,  season:2025},
  {id:"PPL", name:"Primeira Liga",  flag:"🇵🇹",         afId:94,  season:2025}
];

async function fdFetch(path) {
  const r = await fetch("https://api.football-data.org/v4" + path, {
    headers: { "X-Auth-Token": process.env.FD_KEY }
  });
  return r.json();
}

async function afFetch(path) {
  const r = await fetch("https://v3.football.api-sports.io" + path, {
    headers: { "x-apisports-key": process.env.APIFOOTBALL_KEY }
  });
  return r.json();
}

async function callClaude(prompt, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Multi-turn loop to handle web_search tool_use blocks
      const messages = [{ role: "user", content: prompt }];
      let finalText = "";

      for (let turn = 0; turn < 8; turn++) {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 8000,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages
          })
        });
        const data = await r.json();

        if (data.error) {
          break;
        }

        const blocks = data.content || [];

        // Collect any text from this turn
        const textBlocks = blocks.filter(b => b.type === "text");
        if (textBlocks.length) {
          finalText = textBlocks.map(b => b.text).join("");
        }

        // If stop_reason is end_turn or no tool_use blocks, we're done
        const toolUseBlocks = blocks.filter(b => b.type === "tool_use");
        if (data.stop_reason === "end_turn" || !toolUseBlocks.length) break;

        // Otherwise, append assistant turn and send tool results back
        messages.push({ role: "assistant", content: blocks });
        const toolResults = toolUseBlocks.map(tu => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: tu.input?.query ? `Search results for: ${tu.input.query}` : "No results"
        }));
        messages.push({ role: "user", content: toolResults });
      }

      if (finalText.length > 100) return finalText;
      if (attempt < retries) continue;
      return finalText;
    } catch(e) {
      if (attempt === retries) throw e;
    }
  }
  return "";
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

function mapStandings(raw) {
  return (raw || []).map(t => ({
    pos: t.position,
    team: t.team?.shortName || t.team?.name || "",
    played: t.playedGames,
    won: t.won,
    drawn: t.draw,
    lost: t.lost,
    gf: t.goalsFor,
    ga: t.goalsAgainst,
    gd: t.goalDifference,
    pts: t.points,
    form: t.form || ""
  }));
}

// Normalise a team name to help fuzzy-match across data sources.
function normaliseTeam(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\bfc\b|\baf\b|\bsc\b|\bac\b|\bsv\b|\bfk\b|\bsk\b/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns true if two team name strings refer to the same club.
function teamsMatch(a, b) {
  if (!a || !b) return false;
  const na = normaliseTeam(a);
  const nb = normaliseTeam(b);
  if (na === nb) return true;
  if (na.length >= 4 && nb.includes(na)) return true;
  if (nb.length >= 4 && na.includes(nb)) return true;
  // Word-level overlap: share at least one meaningful word (>3 chars)
  const wa = na.split(" ").filter(w => w.length > 3);
  const wb = nb.split(" ").filter(w => w.length > 3);
  return wa.some(w => wb.includes(w));
}

// Use Claude with web search to fetch current injury & suspension news for a
// batch of teams. Returns a map of teamName -> ["Player (reason)", ...]
// Only includes players injured/suspended within 10 days of the fixture date.

// Search all bookmakers for a market, returning the first match found.
function extractMarket(bookmakers, marketName) {
  for (const bk of (bookmakers || [])) {
    const market = (bk.bets || []).find(b => b.name === marketName);
    if (market) return market;
  }
  return null;
}

async function getOdds(afId, season) {
  try {
    // Single call without bookmaker filter — returns all bookmakers,
    // we pick the best available odds per market from whatever is returned.
    const data = await afFetch(`/odds?league=${afId}&season=${season}`).catch(() => ({}));

    const oddsMap = {};
    (data.response || []).forEach(item => {
      const home = item.fixture?.teams?.home?.name || "";
      const away = item.fixture?.teams?.away?.name || "";
      if (!home || !away) return;

      const key = `${home}|${away}`;
      const allBookmakers = item.bookmakers || [];

      const getVal = (marketName, valueName) => {
        const market = extractMarket(allBookmakers, marketName);
        return market?.values?.find(v => v.value === valueName)?.odd || null;
      };

      const homeOdd = getVal("Match Winner", "Home");
      if (!homeOdd) return;

      oddsMap[key] = {
        home: homeOdd,
        draw: getVal("Match Winner", "Draw"),
        away: getVal("Match Winner", "Away"),
        btts: getVal("Both Teams Score", "Yes"),
        over05: getVal("Goals Over/Under", "Over 0.5"),
        over15: getVal("Goals Over/Under", "Over 1.5"),
        homeToScore: getVal("Team To Score", "Home"),
        awayToScore: getVal("Team To Score", "Away")
      };
    });

    return oddsMap;
  } catch(e) {
    return {};
  }
}

function parseLeagues(raw) {
  const txt = raw.replace(/```json[\s\S]*?```/g, m => m.replace(/```json|```/g,"")).replace(/```json|```/g, "").trim();
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

// Multiply individual decimal odds together and apply a 5% bookmaker margin.
function calcComboOdds(oddsStrings) {
  if (!oddsStrings || !oddsStrings.length) return null;
  let combined = 1;
  for (const odd of oddsStrings) {
    const o = parseFloat(odd);
    if (!o || o <= 1) return null;
    combined *= o;
  }
  return (combined * 0.95).toFixed(2);
}

// After Claude returns picks, replace every combo.odds with a server-calculated
// value derived from the real builder odds so it is mathematically accurate.
function recalculateComboOdds(leagues) {
  for (const lg of leagues) {
    for (const pick of (lg.picks || [])) {
      if (!pick.combo || !pick.builders) continue;
      const comboPicks = pick.combo.picks || [];
      const odds = comboPicks.map(name => {
        const builder = (pick.builders || []).find(b =>
          (b.name || "").toLowerCase() === (name || "").toLowerCase()
        );
        return builder?.odds;
      }).filter(Boolean);
      if (odds.length === comboPicks.length && odds.length > 0) {
        const calculated = calcComboOdds(odds);
        if (calculated) pick.combo.odds = calculated;
      }
    }
  }
  return leagues;
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

    const leagueData = [];
    for (const lg of LEAGUES) {
      const [fixturesData, standingsData, oddsMap] = await Promise.all([
        fdFetch(`/competitions/${lg.id}/matches?dateFrom=${fmt(now)}&dateTo=${fmt(end14)}`).catch(() => ({})),
        fdFetch(`/competitions/${lg.id}/standings`).catch(() => ({})),
        getOdds(lg.afId, lg.season)
      ]);

      const finished = ["FINISHED","IN_PLAY","PAUSED","SUSPENDED","CANCELLED","POSTPONED"];
      const upcomingMatches = (fixturesData.matches || []).filter(m => !finished.includes(m.status));

      const fixtures = upcomingMatches.map(m => ({
        home: m.homeTeam?.shortName || m.homeTeam?.name || "TBC",
        away: m.awayTeam?.shortName || m.awayTeam?.name || "TBC",
        date: new Date(m.utcDate).toLocaleDateString("en-GB", {weekday:"short",day:"numeric",month:"short"}),
        time: new Date(m.utcDate).toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit"}),
        utc: m.utcDate,
        status: m.status
      }));

      let rawStandings = [];
      if (standingsData.standings) {
        for (const s of standingsData.standings) {
          if (s.type === "TOTAL") { rawStandings = s.table || []; break; }
        }
      }

      leagueData.push({ ...lg, fixtures, standings: mapStandings(rawStandings), oddsMap, trendMap: trendsMap });
    }

    const makePrompt = (batch) => {
      const today = now.toLocaleDateString("en-GB", {weekday:"long",day:"numeric",month:"long",year:"numeric"});
      const end14str = end14.toLocaleDateString("en-GB", {weekday:"short",day:"numeric",month:"long",year:"numeric"});

      const dataSummary = batch.map(lg => {
        const fxLines = lg.fixtures.slice(0, 10).map((f, i) => {
          const td = lg.trendMap?.[`${f.home}|${f.away}`];
          const trendStr = td
            ? ` [Home form:${td.home?.form||"?"} avg scored:${td.home?.avg_goals_scored?.toFixed(1)||"?"} BTTS:${td.home?.pct_bts!=null?Math.round(td.home.pct_bts*100)+"%":"?"} | Away form:${td.away?.form||"?"} avg scored:${td.away?.avg_goals_scored?.toFixed(1)||"?"} BTTS:${td.away?.pct_bts!=null?Math.round(td.away.pct_bts*100)+"%":"?"}]`
            : "";

          const odds = lg.oddsMap?.[`${f.home}|${f.away}`] || {};
          const oddsStr = odds.home
            ? ` [Odds: H:${odds.home} D:${odds.draw} A:${odds.away}${odds.btts ? " BTTS:"+odds.btts : ""}${odds.over05 ? " O0.5:"+odds.over05 : ""}${odds.over15 ? " O1.5:"+odds.over15 : ""}${odds.homeToScore ? " "+f.home+"ToScore:"+odds.homeToScore : ""}${odds.awayToScore ? " "+f.away+"ToScore:"+odds.awayToScore : ""}]`
            : " [Odds: NOT AVAILABLE for this fixture]";

          const injStr = `\n   Injuries/Suspensions: [USE WEB SEARCH to find current 2025/26 confirmed absences for ${f.home} and ${f.away}]`;

          return `${i+1}. ${f.home} vs ${f.away} — ${f.date} ${f.time}${trendStr}${oddsStr}${injStr}`;
        }).join("\n");

        const tableLines = lg.standings.slice(0, 6).map(t =>
          `${t.pos}. ${t.team} (${t.pts}pts GD:${t.gd})`
        ).join("\n");
        const botLines = lg.standings.slice(-3).map(t =>
          `${t.pos}. ${t.team} (${t.pts}pts - relegation)`
        ).join("\n");

        return `LEAGUE: ${lg.name} ${lg.flag}\nFIXTURES:\n${fxLines||"none"}\nTOP 6:\n${tableLines||"none"}\nBOTTOM 3:\n${botLines||"none"}`;
      }).join("\n\n---\n\n");

      return `Today is ${today}. Fixtures window: ${today} to ${end14str}.

You are an expert football betting analyst. Use the LIVE data, real bookmaker odds, and real injury/suspension data below.

${dataSummary}

TASK: For each league, pick up to 5 fixtures and provide betting analysis.

Return ONLY raw JSON starting with {:
{"leagues":[{"league":"name","flag":"emoji","context":"one sentence","picks":[{"home":"team","away":"team","date":"date","time":"time","primary":{"pick":"[Team] to Score","xg":1.8,"odds":"1.55","confidence":"High","reason":"3-4 sentences: explain why this team is likely to score — reference their recent scoring form, xG, key attackers, opponent defensive weaknesses, and any relevant injuries/suspensions","injuries":"list real injuries/suspensions from data above or None"},"builders":[{"name":"[Team] Win","odds":"1.60","confidence":"High","reason":"1-2 sentences"},{"name":"Over 0.5 Goals","odds":"1.15","confidence":"High","reason":"1-2 sentences"},{"name":"Over 1.5 Goals","odds":"1.45","confidence":"High","reason":"1-2 sentences"},{"name":"BTTS","odds":"1.70","confidence":"Medium","reason":"1-2 sentences"}],"combo":{"name":"Win + Goals","picks":["[Team] Win","Over 1.5 Goals"],"odds":"CALCULATE","reason":"2-3 sentences"},"form":[{"result":"W","score":"2-0","xg":2.1,"actual":2},{"result":"D","score":"1-1","xg":1.3,"actual":1},{"result":"W","score":"3-1","xg":2.4,"actual":3},{"result":"L","score":"0-1","xg":0.9,"actual":0},{"result":"W","score":"2-1","xg":1.7,"actual":2}],"tags":["tag1","tag2"]}]}]}

RULES:
- primary.pick MUST always be "[Team] to Score" e.g. "Arsenal to Score"
- primary.odds: use ONLY the real "[Team]ToScore" odds explicitly shown in the data above (e.g. HomeToScore or AwayToScore). If NO ToScore odd is shown for this fixture, write "N/A" — NEVER invent or estimate an odds value
- primary.reason: 3-4 sentences referencing scoring form, xG, key attackers, defensive weaknesses, injury impact
- injuries: use web search to find confirmed 2025/26 injuries and suspensions for both teams — max 4 key players each. Format: "Salah (hamstring), Bradley (knee)" or "None confirmed"
- builders: use real bookmaker odds from the data (H/D/A, BTTS, O0.5, O1.5)
- builders MAY include Over 0.5 Goals (use O0.5 odd) and/or Over 1.5 Goals (use O1.5 odd)
- NEVER suggest Over 2.5 Goals in builders or anywhere else
- NEVER put "[Team] to Score" or any "to score" pick in builders — primary only
- builders: 3-4 picks from Win/Double Chance, Over 0.5 Goals, Over 1.5 Goals, BTTS, or HT/FT
- combo.picks: choose 2-3 from your builder picks
- combo.odds: always write exactly "CALCULATE" — the server replaces this with mathematically accurate odds
- form: 5 items most recent first
- Return ONLY the raw JSON object — no markdown, no backticks, no ```json, no explanation text before or after the JSON`;
    };

    let rawA = "", rawB = "", rawC = "", rawD = "";
    [rawA, rawB, rawC, rawD] = await Promise.all([
      callClaude(makePrompt(leagueData.slice(0, 2))),
      callClaude(makePrompt(leagueData.slice(2, 4))),
      callClaude(makePrompt(leagueData.slice(4, 6))),
      callClaude(makePrompt(leagueData.slice(6)))
    ]);

    let allLeagues = [
      ...parseLeagues(rawA),
      ...parseLeagues(rawB),
      ...parseLeagues(rawC),
      ...parseLeagues(rawD)
    ];

    allLeagues.forEach(lg => {
      const live = leagueData.find(r => r.name === lg.league);
      if (live) {
        lg.standings = live.standings;
        lg.cfg = live;
      }
    });

    // Replace all combo.odds with mathematically calculated values
    allLeagues = recalculateComboOdds(allLeagues);

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
