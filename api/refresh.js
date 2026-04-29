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

async function callClaude(prompt) {
  // Single attempt — no retries to avoid hammering rate limits
  try {
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
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await r.json();
    if (data.error) return "ERROR:" + JSON.stringify(data.error);
    const blocks = data.content || [];
    return blocks.filter(b => b.type === "text").map(b => b.text).join("");
  } catch(e) {
    return "ERROR:" + e.message;
  }
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
        const fxLines = lg.fixtures.slice(0, 5).map((f, i) => {
          const td = lg.trendMap?.[`${f.home}|${f.away}`];
          const trendStr = td
            ? ` [Home form:${td.home?.form||"?"} avg scored:${td.home?.avg_goals_scored?.toFixed(1)||"?"} | Away form:${td.away?.form||"?"} avg scored:${td.away?.avg_goals_scored?.toFixed(1)||"?"}]`
            : "";

          // Fuzzy-match fixture names against API-Sports odds map keys
          const oddsKey = Object.keys(lg.oddsMap||{}).find(k => {
            const [kHome, kAway] = k.split("|");
            return teamsMatch(kHome, f.home) && teamsMatch(kAway, f.away);
          });
          const odds = (oddsKey && lg.oddsMap[oddsKey]) || {};
          const oddsStr = odds.home
            ? ` [Odds: H:${odds.home} D:${odds.draw} A:${odds.away}${odds.btts ? " BTTS:"+odds.btts : ""}${odds.over05 ? " O0.5:"+odds.over05 : ""}${odds.over15 ? " O1.5:"+odds.over15 : ""}${odds.homeToScore ? " "+f.home+"ToScore:"+odds.homeToScore : ""}${odds.awayToScore ? " "+f.away+"ToScore:"+odds.awayToScore : ""}]`
            : " [Odds: NOT AVAILABLE for this fixture]";



          return `${i+1}. ${f.home} vs ${f.away} — ${f.date} ${f.time}${trendStr}${oddsStr}`;
        }).join("\n");

        const tableLines = lg.standings.slice(0, 6).map(t =>
          `${t.pos}. ${t.team} (${t.pts}pts GD:${t.gd})`
        ).join("\n");
        const botLines = lg.standings.slice(-3).map(t =>
          `${t.pos}. ${t.team} (${t.pts}pts - relegation)`
        ).join("\n");

        return `LEAGUE: ${lg.name} ${lg.flag}\nFIXTURES:\n${fxLines||"none"}\nTOP 6:\n${tableLines||"none"}\nBOTTOM 3:\n${botLines||"none"}`;
      }).join("\n\n---\n\n");

      // Use the flag from the league config, not from Claude
      const lgName = batch[0]?.name || "";

      return `Today is ${today}. You are an expert football betting analyst with deep knowledge of European football.

${dataSummary}

TASK: Select the 3 BEST fixtures for betting from the league above. Prioritise fixtures where:
1. One team has clear scoring form (high avg goals scored, strong attack, weak opposition defence)
2. Bookmaker odds are available — skip fixtures marked "NOT AVAILABLE"
3. The pick team is likely to score based on league position, form, and matchup

Return ONLY this JSON (no markdown, no backticks, no explanation before or after):
{"leagues":[{"league":"${lgName}","flag":"PLACEHOLDER","context":"one sentence summarising the league situation right now","picks":[{"home":"TeamA","away":"TeamB","date":"Sat 2 May","time":"15:00","primary":{"pick":"TeamA to Score","xg":1.9,"odds":"1.45","confidence":"High","reason":"3 sentences: reference the team's recent scoring form from the data above, their key attackers, and why the opponent's defence is vulnerable. Be specific about goals scored in last 5 games.","injuries":"Not available"},"builders":[{"name":"TeamA Win","odds":"1.75","confidence":"High","reason":"2 sentences on why this team wins based on league position and form"},{"name":"Over 1.5 Goals","odds":"1.45","confidence":"High","reason":"2 sentences on why goals are expected in this fixture"},{"name":"BTTS","odds":"1.80","confidence":"Medium","reason":"2 sentences on why both teams score"}],"combo":{"name":"Win + Goals","picks":["TeamA Win","Over 1.5 Goals"],"odds":"CALCULATE","reason":"2 sentences on why these combine well"},"form":[{"result":"W","score":"2-0","xg":2.1,"actual":2},{"result":"W","score":"1-0","xg":1.4,"actual":1},{"result":"D","score":"1-1","xg":1.2,"actual":1},{"result":"L","score":"0-2","xg":0.8,"actual":0},{"result":"W","score":"3-1","xg":2.3,"actual":3}],"tags":["strong attack","home form"]}]}]}

STRICT RULES:
- Only pick fixtures where odds ARE available in the data — never pick a fixture marked "NOT AVAILABLE"
- league: always "${lgName}" — never change this
- flag: always "PLACEHOLDER" — never change this  
- primary.pick: always "[Team] to Score" e.g. "Arsenal to Score"
- primary.odds: use the real HomeToScore or AwayToScore odd from the data. Write "N/A" only if genuinely absent
- primary.xg: estimate based on avg goals scored from form data
- confidence: "High" only if avg goals scored > 1.5 and strong form. Otherwise "Medium"
- builders: use real H/D/A/BTTS/O0.5/O1.5 odds. Never suggest Over 2.5. Never put "to score" in builders
- builders MAY include Over 0.5 Goals and/or Over 1.5 Goals  
- combo.odds: always write "CALCULATE"
- form: 5 most recent results for the primary pick team, most recent first
- Raw JSON only — absolutely no text before or after the JSON object`;
    };

    // All 8 leagues in parallel — prompt is small enough (~500 tokens each) to fit well within rate limits
    const raws = await Promise.all(leagueData.map(lg => callClaude(makePrompt([lg]))));
    let rawA = raws[0]||"", rawB = raws[1]||"", rawC = raws[2]||"", rawD = raws[3]||"";
    const rawE = raws[4]||"", rawF = raws[5]||"", rawG = raws[6]||"", rawH = raws[7]||"";

    let allLeagues = [
      ...parseLeagues(rawA),
      ...parseLeagues(rawB),
      ...parseLeagues(rawC),
      ...parseLeagues(rawD),
      ...parseLeagues(rawE),
      ...parseLeagues(rawF),
      ...parseLeagues(rawG),
      ...parseLeagues(rawH)
    ];

    allLeagues.forEach(lg => {
      const live = leagueData.find(r => r.name === lg.league);
      if (live) {
        lg.standings = live.standings;
        lg.cfg = live;
        lg.flag = live.flag; // Always use config flag, never Claude-generated
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

    res.status(200).json({ 
      ok: true, 
      leagues: allLeagues.length, 
      updatedAt: now.toISOString(),
      debug: { 
        rawLengths: raws.map((r,i) => ({ league: leagueData[i]?.name, len: r?.length||0, preview: r?.slice(0,150)||"EMPTY" }))
      }
    });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
