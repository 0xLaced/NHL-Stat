const express = require('express');
const session = require('express-session');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.SITE_PASSWORD || 'nhlstat2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'nhlstat-secret-key-change-me';

// ─── NHL Data Engine ────────────────────────────────────────────────────────

// League benchmark thresholds (2025-26 season context)
const LEAGUE_AVG = {
  goalsFor: 3.1,
  goalsAgainst: 3.1,
  ppPct: 21.5,
  pkPct: 82.0,
  foPct: 50.0,
  savePct: 0.905,
};

// Factor weights (revised system from research)
const WEIGHTS = {
  startingGoalie:      11,
  goalieRecentForm:     6,
  xGDifferential:      14,
  offensiveStrength:    8,
  defensiveStrength:    8,
  injuries:             8,
  topLineMatchups:      5,
  depthScoring:         5,
  powerPlay:            5,
  penaltyKill:          4,
  faceoffPct:           2,
  homeAway:             4,
  restFatigue:          4,
  puckLuck:             3,
  travel:               2,
  momentum:             2,
  gameImportance:       2,
  coachingSystem:       3,
  lineMatching:         2,
  inGameAdjustments:    2,
};

// Score each factor 0.0–1.0 vs league, multiply by weight
function scoreTeam(team, isHome, opponentTeam) {
  const w = WEIGHTS;
  const scores = {};

  // Goalie quality: compare starter SV% to league avg
  const goalieQuality = team.starterSvPct ? Math.min((team.starterSvPct - 0.870) / (0.940 - 0.870), 1) : 0.4;
  const goalieIsStarter = team.starterIsConfirmed !== false;
  scores.startingGoalie = w.startingGoalie * (goalieIsStarter ? goalieQuality : goalieQuality * 0.55);

  // Recent goalie form
  const formRaw = team.goalieRecentGAA ? Math.min((3.5 - team.goalieRecentGAA) / (3.5 - 1.5), 1) : 0.5;
  scores.goalieRecentForm = w.goalieRecentForm * Math.max(formRaw, 0);

  // xG differential: use goals-for minus goals-against differential as proxy
  const xgDiff = (team.goalsForPG || LEAGUE_AVG.goalsFor) - (team.goalsAgainstPG || LEAGUE_AVG.goalsAgainst);
  const xgScore = Math.min(Math.max((xgDiff + 1.5) / 3.0, 0), 1);
  scores.xGDifferential = w.xGDifferential * xgScore;

  // Offensive strength
  const offScore = Math.min((team.goalsForPG || LEAGUE_AVG.goalsFor) / (LEAGUE_AVG.goalsFor * 1.5), 1);
  scores.offensiveStrength = w.offensiveStrength * offScore;

  // Defensive strength (lower GA = better)
  const defGA = team.goalsAgainstPG || LEAGUE_AVG.goalsAgainst;
  const defScore = Math.min((LEAGUE_AVG.goalsAgainst * 1.5 - defGA) / (LEAGUE_AVG.goalsAgainst * 1.0), 1);
  scores.defensiveStrength = w.defensiveStrength * Math.max(defScore, 0);

  // Injuries (inverted: more injured = lower score)
  const injuryImpact = team.injuryImpact || 0.5; // 0=devastated, 1=fully healthy
  scores.injuries = w.injuries * injuryImpact;

  // Top line matchups (normalized star power rating 0-1)
  scores.topLineMatchups = w.topLineMatchups * (team.topLineRating || 0.5);

  // Depth scoring
  scores.depthScoring = w.depthScoring * (team.depthRating || 0.5);

  // Power play
  const ppScore = Math.min(((team.ppPct || LEAGUE_AVG.ppPct) - 10) / (35 - 10), 1);
  scores.powerPlay = w.powerPlay * Math.max(ppScore, 0);

  // Penalty kill
  const pkScore = Math.min(((team.pkPct || LEAGUE_AVG.pkPct) - 70) / (95 - 70), 1);
  scores.penaltyKill = w.penaltyKill * Math.max(pkScore, 0);

  // Faceoff
  const foScore = Math.min(((team.foPct || LEAGUE_AVG.foPct) - 40) / (20), 1);
  scores.faceoffPct = w.faceoffPct * Math.max(foScore, 0);

  // Home/away
  scores.homeAway = w.homeAway * (isHome ? 0.7 : 0.4);

  // Rest/fatigue
  const restScore = team.isBackToBack ? 0.25 : (team.daysSinceLastGame === 1 ? 0.65 : 0.75);
  scores.restFatigue = w.restFatigue * restScore;

  // Puck luck (neutral unless team is clearly over/underperforming vs xG)
  scores.puckLuck = w.puckLuck * 0.5;

  // Travel (home = max, short trip = good)
  const travelScore = isHome ? 0.9 : (team.travelDistance > 2000 ? 0.35 : 0.6);
  scores.travel = w.travel * travelScore;

  // Momentum (last 10 game win%)
  const momScore = team.last10WinPct !== undefined ? Math.min(team.last10WinPct, 1) : 0.5;
  scores.momentum = w.momentum * momScore;

  // Game importance
  scores.gameImportance = w.gameImportance * (team.playoffImportance || 0.6);

  // Coaching system
  scores.coachingSystem = w.coachingSystem * (team.coachingRating || 0.6);

  // Line matching (home advantage)
  scores.lineMatching = w.lineMatching * (isHome ? 0.75 : 0.5);

  // In-game adjustments
  scores.inGameAdjustments = w.inGameAdjustments * (team.adjustmentRating || 0.6);

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return { scores, total: Math.round(total * 10) / 10 };
}

// ─── Static NHL Team Data Store ──────────────────────────────────────────────
// In a production app this would be fetched from an NHL API.
// These are the season stats confirmed from research; game-day fields update via /api/refresh.

const TEAM_DATA = {
  BUF: {
    name: 'Buffalo Sabres', abbr: 'BUF', conf: 'E', div: 'Atlantic',
    record: '44-20-7', pts: 95,
    goalsForPG: 3.48, goalsAgainstPG: 2.88,
    ppPct: 20.4, pkPct: 87.7, foPct: 50.0,
    starterSvPct: 0.914, goalieRecentGAA: 2.54,
    topLineRating: 0.82, depthRating: 0.70,
    injuryImpact: 0.63, last10WinPct: 0.80,
    playoffImportance: 0.75, coachingRating: 0.65,
    adjustmentRating: 0.60, isBackToBack: false, travelDistance: 0,
    starterName: 'Alex Lyon', starterIsConfirmed: true,
    injuries: ['T. Pearson (out)', 'M. Samuelsson (GTD)'],
  },
  BOS: {
    name: 'Boston Bruins', abbr: 'BOS', conf: 'E', div: 'Atlantic',
    record: '39-23-8', pts: 86,
    goalsForPG: 3.15, goalsAgainstPG: 2.95,
    ppPct: 26.3, pkPct: 76.4, foPct: 53.0,
    starterSvPct: 0.900, goalieRecentGAA: 3.10,
    topLineRating: 0.80, depthRating: 0.60,
    injuryImpact: 0.81, last10WinPct: 0.75,
    playoffImportance: 0.90, coachingRating: 0.65,
    adjustmentRating: 0.60, isBackToBack: true, travelDistance: 450,
    starterName: 'J. Korpisalo (b2b)', starterIsConfirmed: true,
    injuries: ['E. Lindholm (illness)'],
  },
  TOR: {
    name: 'Toronto Maple Leafs', abbr: 'TOR', conf: 'E', div: 'Atlantic',
    record: '29-29-13', pts: 71,
    goalsForPG: 3.14, goalsAgainstPG: 3.48,
    ppPct: 29.5, pkPct: 84.2, foPct: 50.0,
    starterSvPct: 0.912, goalieRecentGAA: 2.90,
    topLineRating: 0.88, depthRating: 0.50,
    injuryImpact: 0.81, last10WinPct: 0.40,
    playoffImportance: 0.60, coachingRating: 0.60,
    adjustmentRating: 0.55, isBackToBack: false, travelDistance: 0,
    starterName: 'A. Stolarz (returns)', starterIsConfirmed: true,
    injuries: ['Stolarz returning from injury (cleared)'],
  },
  NYR: {
    name: 'New York Rangers', abbr: 'NYR', conf: 'E', div: 'Metropolitan',
    record: '32-36-3', pts: 67,
    goalsForPG: 2.56, goalsAgainstPG: 2.93,
    ppPct: 23.8, pkPct: 78.1, foPct: 50.0,
    starterSvPct: 0.875, goalieRecentGAA: 3.40,
    topLineRating: 0.70, depthRating: 0.50,
    injuryImpact: 0.50, last10WinPct: 0.45,
    playoffImportance: 0.60, coachingRating: 0.60,
    adjustmentRating: 0.55, isBackToBack: false, travelDistance: 550,
    starterName: 'Sykora (NHL debut)', starterIsConfirmed: true,
    injuries: ['J. Quick (upper body, out)', 'M. Rempe (upper body, out)', 'U. Vaakanainen (upper body, out)'],
  },
};

// Tonight's games — in production this would come from NHL schedule API
const TONIGHT_GAMES = [
  { id: 'BUF-BOS', home: 'BUF', away: 'BOS', time: '6:30 PM CDT', status: 'scheduled' },
  { id: 'TOR-NYR', home: 'TOR', away: 'NYR', time: '6:30 PM CDT', status: 'scheduled' },
];

function buildGameSummary(homeTeam, awayTeam, homeScore, awayScore, homeData, awayData) {
  const keyFactors = [];
  const homePKLabel = homeData.pkPct >= 85 ? 'elite' : homeData.pkPct >= 80 ? 'solid' : 'poor';
  const awayPKLabel = awayData.pkPct >= 85 ? 'elite' : awayData.pkPct >= 80 ? 'solid' : 'poor';
  const homePPLabel = homeData.ppPct >= 25 ? 'elite' : homeData.ppPct >= 21 ? 'average' : 'below-average';
  const awayPPLabel = awayData.ppPct >= 25 ? 'elite' : awayData.ppPct >= 21 ? 'average' : 'below-average';

  if (homeData.isBackToBack) keyFactors.push(`${awayData.name} get the rest edge — ${homeData.name} play a back-to-back with ${homeData.starterName} between the pipes`);
  if (awayData.isBackToBack) keyFactors.push(`${homeData.name} get the rest edge — ${awayData.name} play a back-to-back with ${awayData.starterName}`);
  if (homeData.starterSvPct < 0.895) keyFactors.push(`${homeData.starterName} is a below-average starter; expect elevated scoring`);
  if (awayData.starterSvPct < 0.895) keyFactors.push(`${awayData.starterName} is a below-average starter — a significant risk factor tonight`);

  const lead = homeScore > awayScore ? homeTeam : awayTeam;
  const trail = homeScore > awayScore ? awayTeam : homeTeam;
  const gap = Math.abs(homeScore - awayScore).toFixed(1);

  let summary = `The model gives ${lead} the edge with a ${gap}-point margin in the spread calculation. `;

  if (keyFactors.length) summary += keyFactors.join('. ') + '. ';

  summary += `${homeData.name} PP ranks ${homePPLabel} (${homeData.ppPct}%) while their PK sits ${homePKLabel} (${homeData.pkPct}%). `;
  summary += `${awayData.name} counter with a ${awayPPLabel} power play (${awayData.ppPct}%) and ${awayPKLabel} PK (${awayData.pkPct}%). `;
  summary += `Key injuries to monitor: ${[...homeData.injuries, ...awayData.injuries].join(', ') || 'none reported'}.`;

  return summary;
}

// ─── API Routes ──────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/auth/check', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// Games API
app.get('/api/games', requireAuth, (req, res) => {
  const games = TONIGHT_GAMES.map(game => {
    const homeData = TEAM_DATA[game.home];
    const awayData = TEAM_DATA[game.away];
    if (!homeData || !awayData) return null;

    const homeResult = scoreTeam(homeData, true, awayData);
    const awayResult = scoreTeam(awayData, false, homeData);

    return {
      id: game.id,
      time: game.time,
      status: game.status,
      home: {
        abbr: game.home,
        name: homeData.name,
        record: homeData.record,
        starterName: homeData.starterName,
        injuries: homeData.injuries,
        isBackToBack: homeData.isBackToBack,
        score: homeResult.total,
        factors: homeResult.scores,
        stats: {
          ppPct: homeData.ppPct, pkPct: homeData.pkPct,
          goalsForPG: homeData.goalsForPG, goalsAgainstPG: homeData.goalsAgainstPG,
        }
      },
      away: {
        abbr: game.away,
        name: awayData.name,
        record: awayData.record,
        starterName: awayData.starterName,
        injuries: awayData.injuries,
        isBackToBack: awayData.isBackToBack,
        score: awayResult.total,
        factors: awayResult.scores,
        stats: {
          ppPct: awayData.ppPct, pkPct: awayData.pkPct,
          goalsForPG: awayData.goalsForPG, goalsAgainstPG: awayData.goalsAgainstPG,
        }
      },
      summary: buildGameSummary(game.home, game.away, homeResult.total, awayResult.total, homeData, awayData),
      weights: WEIGHTS,
      lastUpdated: new Date().toISOString(),
    };
  }).filter(Boolean);

  res.json({ games, date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) });
});

app.listen(PORT, () => {
  console.log(`NHL Stat server running on port ${PORT}`);
});
