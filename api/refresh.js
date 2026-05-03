const LEAGUES = [
  {id:"PL",  name:"Premier League", flag:"", flagCode:"gb-eng", afId:39,  season:2025},
  {id:"ELC", name:"Championship",   flag:"", flagCode:"gb-eng", afId:180, season:2025},
  {id:"PD",  name:"La Liga",        flag:"", flagCode:"es",     afId:140, season:2025},
  {id:"BL1", name:"Bundesliga",     flag:"", flagCode:"de",     afId:78,  season:2025},
  {id:"FL1", name:"Ligue 1",        flag:"", flagCode:"fr",     afId:61,  season:2025},
  {id:"SA",  name:"Serie A",        flag:"", flagCode:"it",     afId:135, season:2025},
  {id:"DED", name:"Eredivisie",     flag:"", flagCode:"nl",     afId:88,  season:2025},
  {id:"PPL", name:"Primeira Liga",  flag:"", flagCode:"pt",     afId:94,  season:2025}
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
        home: m.homeTeam?.name || m.homeTeam?.shortName || "TBC",
        away: m.awayTeam?.name || m.awayTeam?.shortName || "TBC",
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

      // Fetch last 6 weeks of finished matches for real form data
      let recentResults = {};
      try {
        const past = new Date(now); past.setDate(now.getDate() - 42);
        const fmtDate = d => d.toISOString().split("T")[0];
        const recentData = await fdFetch(`/competitions/${lg.id}/matches?status=FINISHED&dateFrom=${fmtDate(past)}&dateTo=${fmtDate(now)}&limit=100`).catch(() => ({}));
        (recentData.matches || []).forEach(m => {
          const home = m.homeTeam?.name || m.homeTeam?.shortName || "";
          const away = m.awayTeam?.name || m.awayTeam?.shortName || "";
          const hg = m.score?.fullTime?.home ?? m.score?.fullTime?.homeTeam;
          const ag = m.score?.fullTime?.away ?? m.score?.fullTime?.awayTeam;
          if (hg === null || hg === undefined || ag === null || ag === undefined) return;
          const date = new Date(m.utcDate).toLocaleDateString("en-GB", {day:"numeric",month:"short"});
          if (home) {
            if (!recentResults[home]) recentResults[home] = [];
            recentResults[home].push({ r: hg>ag?"W":hg<ag?"L":"D", s:`${hg}-${ag}`, opp:away, date });
          }
          if (away) {
            if (!recentResults[away]) recentResults[away] = [];
            recentResults[away].push({ r: ag>hg?"W":ag<hg?"L":"D", s:`${ag}-${hg}`, opp:home, date });
          }
        });
      } catch(e) {}

      leagueData.push({ ...lg, fixtures, standings: mapStandings(rawStandings), oddsMap, trendMap: trendsMap, recentResults });
    }

    // ── Server-side fixture ranking with real xG ────────────────────────────
      // Fuzzy name match for recentResults lookup — used in both rankFixtures and makePrompt
      const findResults = (lg, name) => {
        if (lg.recentResults?.[name]) return lg.recentResults[name];
        const key = Object.keys(lg.recentResults||{}).find(k => teamsMatch(k, name));
        return key ? lg.recentResults[key] : [];
      };

    function rankFixtures(lg, topN) {
      // xG model — balanced approach:
      // - Use actual goals scored/conceded, capped at 4 per game (removes freakish outliers)
      // - Light 25% regression toward league mean (enough to prevent extremes, not so much it flattens everything)
      // - Separate home/away averages for more accuracy
      // - Hard cap at 2.5 — genuinely elite attacking performances can show higher xG
      const LEAGUE_AVG = 1.35;
      const REGRESSION = 0.25; // 25% pull toward league mean

      const calcAvg = (results, last, field, venue) => {
        let games = results.slice(-last);
        // Filter by venue if enough data exists
        const venueGames = games.filter(g => g.v === venue);
        if (venueGames.length >= 3) games = venueGames;
        if (!games.length) return LEAGUE_AVG;
        const vals = games.map(g => {
          const p = (g.s||"0-0").split("-");
          const raw = parseInt(field==="scored"?p[0]:p[1])||0;
          return Math.min(raw, 4); // cap at 4 — a 6-0 win counts as 4
        });
        // Recency weighted: most recent = weight 2x, oldest = 1x
        let wSum = 0, wTotal = 0;
        vals.forEach((v, i) => {
          const w = 1 + (i / vals.length);
          wSum += v * w; wTotal += w;
        });
        const raw = wSum / wTotal;
        // Light regression to mean
        return raw * (1 - REGRESSION) + LEAGUE_AVG * REGRESSION;
      };

      const ranked = lg.fixtures.map(f => {
        const hr = findResults(lg, f.home);
        const ar = findResults(lg, f.away);
        const hScored = calcAvg(hr, 8, "scored", "H");
        const aScored = calcAvg(ar, 8, "scored", "A");
        const hConc   = calcAvg(hr, 8, "conc",   "H");
        const aConc   = calcAvg(ar, 8, "conc",   "A");

        // xG: 60% own scoring rate + 40% opponent concede rate
        // Apply home advantage: away teams score ~15% less on average
        const HOME_BOOST = 1.08;  // home teams score slightly more
        const AWAY_DISC  = 0.88;  // away teams score ~12% less
        const hXGraw = hScored * 0.6 + aConc * 0.4;
        const aXGraw = aScored * 0.6 + hConc * 0.4;
        const hXG = Math.min(hXGraw * HOME_BOOST, 2.5);
        const aXG = Math.min(aXGraw * AWAY_DISC,  2.5);

        const bestXG = Math.max(hXG, aXG);
        const pickTeam = hXG >= aXG ? f.home : f.away;
        const pickXG = (pickTeam === f.home ? hXG : aXG).toFixed(2);

        // Confidence: spread across full realistic range
        const conf = bestXG >= 2.25 ? "High" : bestXG >= 1.8 ? "Medium" : "Low";
        return { ...f, hXG, aXG, hScored, aScored, hConc, aConc, bestXG, pickTeam, pickXG, conf };
      });

      const sorted = ranked.sort((a,b) => b.bestXG - a.bestXG);
      const qualified = sorted.filter(f => f.bestXG > 0.5);
      // Always return at least 3 if available
      const result = qualified.length >= 3 ? qualified : sorted;
      return result.slice(0, topN);
    }

    // Pre-build all pick data server-side — guarantees correct count regardless of Claude
    const buildLeaguePicks = (lg) => {
      const topFixtures = rankFixtures(lg, 5);
      if (!topFixtures.length) return null;
      return topFixtures.map(f => {
        const oddsKey = Object.keys(lg.oddsMap||{}).find(k => {
          const [kH, kA] = k.split("|");
          return teamsMatch(kH, f.home) && teamsMatch(kA, f.away);
        });
        const odds = (oddsKey && lg.oddsMap[oddsKey]) || {};
        const pickResults = (findResults(lg, f.pickTeam)||[]).slice(-5).reverse();
        const formArr = pickResults.map(r => {
          const parts = (r.s||"0-0").split("-");
          return { result: r.r, score: r.s, xg: parseFloat(f.pickXG)||1.35, actual: parseInt(parts[0])||0 };
        });
        while (formArr.length < 5 && formArr.length > 0) formArr.push({...formArr[formArr.length-1]});
        const isHomePick = f.pickTeam === f.home;
        const combinedXG = (f.hXG||1.35) + (f.aXG||1.35);
        // Builder logic: strong home fav gets Win, otherwise Double Chance
        // Goals: Over 1.5 if combined xG > 2.6, else Over 0.5
        // Win if pick team is clear favourite (home with xG >= 1.9, or very high xG)
        const builderWin = (isHomePick && f.hXG >= 1.9) || f.pickXG >= 2.2 ? "Win" : "Double Chance";
        // Goals market based on the picked team's own xG — team-specific not total game
        const builderGoals = parseFloat(f.pickXG) >= 1.5 ? "Over 1.5 Goals" : "Over 0.5 Goals";
        return { home: f.home, away: f.away, date: f.date, time: f.time, utc: f.utc,
          pick: f.pickTeam, xg: parseFloat(f.pickXG)||1.35, hXG: f.hXG, aXG: f.aXG,
          isHomePick, combinedXG, builderWin, builderGoals,
          confidence: f.conf, odds, form: formArr,
          tags: [f.conf.toLowerCase(), isHomePick?"home pick":"away pick"] };
      });
    };

    const makePrompt = (batch) => {
      const today = now.toLocaleDateString("en-GB", {weekday:"long",day:"numeric",month:"long",year:"numeric"});
      const lgName = batch[0]?.name || "";
      const lg = batch[0];
      const prePicks = buildLeaguePicks(lg);

      if (!prePicks) return `{"leagues":[{"league":"${lgName}","flag":"PLACEHOLDER","context":"Season complete.","picks":[]}]}`;

      const pickLines = prePicks.map((p, i) => {
        const oddsStr = p.odds.home
          ? `H:${p.odds.home} D:${p.odds.draw} A:${p.odds.away}${p.odds.homeToScore?" Scr:"+p.odds.homeToScore:""}`
          : "N/A";
        return `${i+1}. ${p.home} vs ${p.away} ${p.date} ${p.time} | PICK:${p.pick} xG:${p.xg.toFixed(2)} ${p.confidence} | builders:[${p.pick} ${p.builderWin}, ${p.pick} ${p.builderGoals}, BTTS] | ${oddsStr} | form:${p.form.map(f=>f.result+f.score).join(",")}`;
      }).join("\n");

      const ctx = `${lg.standings[0]?.team||""}(${lg.standings[0]?.pts||0}pts) leads. Bottom: ${lg.standings.slice(-1)[0]?.team||""}`;

      return `${today}. ${lgName} analyst. Write reason text for these ${prePicks.length} fixtures:

${pickLines}

Return ONLY valid JSON:
{"leagues":[{"league":"${lgName}","flag":"PLACEHOLDER","context":"${ctx}","picks":[{"home":"exact","away":"exact","date":"exact","time":"exact","primary":{"pick":"PICK to Score","xg":X.XX,"odds":"N/A","confidence":"exact","reason":"2 sentences on why PICK will score"},"builders":[{"name":"PICK [Win OR Double Chance]","odds":"N/A","confidence":"Medium","reason":"1 sentence"},{"name":"PICK [Over 0.5 OR Over 1.5] Goals","odds":"N/A","confidence":"Medium","reason":"1 sentence"},{"name":"BTTS","odds":"N/A","confidence":"Medium","reason":"1 sentence"}],"combo":{"name":"PICK + Goals","picks":["PICK [Win OR Double Chance]","PICK [Over 0.5 OR Over 1.5] Goals"],"odds":"CALCULATE","reason":"1 sentence"},"form":[{"result":"W","score":"2-0","xg":1.5,"actual":2}],"tags":["tag"]}]}]}

Copy home/away/date/time/pick/xg/confidence EXACTLY. Write ALL ${prePicks.length} picks. combo.odds="CALCULATE". flag="PLACEHOLDER". league="${lgName}".
For builders and combo: use EXACTLY the builder names from the "builders:[...]" section above for each fixture — do not invent your own. Raw JSON only.`;
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

    // Build server-side pick data for merging
    const serverPickData = {};
    leagueData.forEach(lg => {
      const picks = buildLeaguePicks(lg);
      if (picks) serverPickData[lg.name] = picks;
    });

    allLeagues.forEach(lg => {
      const live = leagueData.find(r => r.name === lg.league);
      if (live) {
        lg.standings = live.standings;
        lg.cfg = live;
        lg.flag = live.flag;
        lg.flagCode = live.flagCode;
      }
      // Merge server-calculated data (xg, form, utc, odds) into Claude's picks
      const serverPicks = serverPickData[lg.league] || [];
      (lg.picks || []).forEach(pick => {
        const sp = serverPicks.find(s =>
          teamsMatch(s.home, pick.home) && teamsMatch(s.away, pick.away)
        );
        if (sp) {
          pick.utc = sp.utc;
          // Always use server-calculated form and xg — never Claude's invented values
          if (sp.form && sp.form.length) pick.primary = pick.primary || {};
          if (pick.primary) {
            pick.primary.xg = sp.xg;
            pick.primary.confidence = sp.confidence;
          }
          if (sp.form && sp.form.length) pick.form = sp.form;
          // Inject tags
          if (sp.tags) pick.tags = sp.tags;
        }
      });

      // If Claude returned fewer picks than server pre-built, add missing ones
      const serverPicsList = serverPickData[lg.league] || [];
      serverPicsList.forEach(sp => {
        const already = (lg.picks||[]).find(p =>
          teamsMatch(p.home, sp.home) && teamsMatch(p.away, sp.away)
        );
        if (!already) {
          // Claude missed this pick — add a minimal version
          lg.picks = lg.picks || [];
          lg.picks.push({
            home: sp.home, away: sp.away, date: sp.date, time: sp.time, utc: sp.utc,
            primary: {
              pick: `${sp.pick} to Score`,
              xg: sp.xg,
              odds: sp.odds.homeToScore || sp.odds.awayToScore || "N/A",
              confidence: sp.confidence,
              reason: `${sp.pick} have an xG of ${sp.xg.toFixed(2)} for this fixture based on recent form.`
            },
            builders: [
              {name:`${sp.pick} ${sp.builderWin||"Double Chance"}`, odds:"N/A", confidence:"Medium", reason:""},
              {name:`${sp.pick} ${sp.builderGoals||"Over 0.5 Goals"}`, odds:"N/A", confidence:"Medium", reason:""},
              {name:"BTTS", odds:"N/A", confidence:"Medium", reason:""}
            ],
            combo: {name:"Pick + Goals", picks:[`${sp.pick} ${sp.builderWin||"Double Chance"}`,`${sp.pick} ${sp.builderGoals||"Over 0.5 Goals"}`], odds:"CALCULATE", reason:"Form and xG support this combination."},
            form: sp.form,
            tags: sp.tags
          });
        }
      });
    });

    // Replace all combo.odds with mathematically calculated values
    allLeagues = recalculateComboOdds(allLeagues);

    const payload = {
      leagues: allLeagues,
      leagueData: leagueData.map(lg => ({
        id: lg.id, name: lg.name, flag: lg.flag, flagCode: lg.flagCode,
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
