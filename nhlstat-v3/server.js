const express = require('express');
const session = require('express-session');
const path = require('path');
const https = require('https');
const app = express();

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.SITE_PASSWORD || 'nhlstat2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'nhlstat-secret-key-change-me';

// ─── HTTP fetch helper ───────────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'NHLStat/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ─── NHL Schedule API ────────────────────────────────────────────────────────
async function fetchTodaySchedule() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const data = await fetchJson(`https://api-web.nhle.com/v1/schedule/${today}`);
    const games = [];
    for (const day of (data.gameWeek || [])) {
      if (day.date === today) {
        for (const g of (day.games || [])) {
          const ha = g.homeTeam.abbrev;
          const aa = g.awayTeam.abbrev;
          games.push({
            id: `${aa}-${ha}-${g.id}`,
            nhlId: g.id,
            home: ha, away: aa,
            time: formatGameTime(g.startTimeUTC),
            status: mapState(g.gameState),
            venue: g.venue?.default || '',
          });
        }
      }
    }
    return games.length ? games : null;
  } catch (e) {
    console.error('NHL API error:', e.message);
    return null;
  }
}

function formatGameTime(utc) {
  if (!utc) return 'TBD';
  try {
    return new Date(utc).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Chicago', timeZoneName: 'short'
    });
  } catch { return utc; }
}

function mapState(s) {
  if (!s) return 'scheduled';
  const u = s.toUpperCase();
  if (['OFF','FINAL','OVER'].includes(u)) return 'final';
  if (['LIVE','CRIT','IN','PRE'].includes(u)) return 'live';
  return 'scheduled';
}

// ─── Cache ───────────────────────────────────────────────────────────────────
let cachedGames = null;
let cacheDate = null;

async function getGames(force = false) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && cachedGames && cacheDate === today) return cachedGames;
  const live = await fetchTodaySchedule();
  cachedGames = live || STATIC_GAMES;
  cacheDate = today;
  return cachedGames;
}

// ─── Weights ─────────────────────────────────────────────────────────────────
const W = {
  startingGoalie:11, goalieRecentForm:6, xGDifferential:14,
  offensiveStrength:8, defensiveStrength:8, injuries:8,
  topLineMatchups:5, depthScoring:5, powerPlay:5, penaltyKill:4,
  faceoffPct:2, homeAway:4, restFatigue:4, puckLuck:3,
  travel:2, momentum:2, gameImportance:2,
  coachingSystem:3, lineMatching:2, inGameAdjustments:2,
};

const AVG = { gf:3.1, ga:3.1, pp:21.5, pk:82.0, fo:50.0 };

function score(team, isHome) {
  const s = {};
  const gq = Math.min(Math.max((( team.starterSvPct||0.900)-0.870)/0.070,0),1);
  s.startingGoalie    = W.startingGoalie * (team.starterIsConfirmed!==false ? gq : gq*0.55);
  s.goalieRecentForm  = W.goalieRecentForm * Math.max(Math.min((3.5-(team.goalieRecentGAA||3.0))/2.0,1),0);
  const xg = (team.goalsForPG||AVG.gf)-(team.goalsAgainstPG||AVG.ga);
  s.xGDifferential    = W.xGDifferential * Math.min(Math.max((xg+1.5)/3.0,0),1);
  s.offensiveStrength = W.offensiveStrength * Math.min((team.goalsForPG||AVG.gf)/(AVG.gf*1.5),1);
  const dga = team.goalsAgainstPG||AVG.ga;
  s.defensiveStrength = W.defensiveStrength * Math.max(Math.min((AVG.ga*1.5-dga)/AVG.ga,1),0);
  s.injuries          = W.injuries        * (team.injuryImpact   ||0.5);
  s.topLineMatchups   = W.topLineMatchups  * (team.topLineRating  ||0.5);
  s.depthScoring      = W.depthScoring     * (team.depthRating    ||0.5);
  s.powerPlay         = W.powerPlay   * Math.max(Math.min(((team.ppPct||AVG.pp)-10)/25,1),0);
  s.penaltyKill       = W.penaltyKill * Math.max(Math.min(((team.pkPct||AVG.pk)-70)/25,1),0);
  s.faceoffPct        = W.faceoffPct  * Math.max(Math.min(((team.foPct||AVG.fo)-40)/20,1),0);
  s.homeAway          = W.homeAway     * (isHome ? 0.7 : 0.4);
  s.restFatigue       = W.restFatigue  * (team.isBackToBack ? 0.25 : 0.75);
  s.puckLuck          = W.puckLuck     * 0.5;
  s.travel            = W.travel       * (isHome ? 0.9 : (team.travelDistance>2000?0.35:0.6));
  s.momentum          = W.momentum     * Math.min(team.last10WinPct??0.5,1);
  s.gameImportance    = W.gameImportance    * (team.playoffImportance||0.6);
  s.coachingSystem    = W.coachingSystem    * (team.coachingRating   ||0.6);
  s.lineMatching      = W.lineMatching      * (isHome ? 0.75 : 0.5);
  s.inGameAdjustments = W.inGameAdjustments * (team.adjustmentRating||0.6);
  return { scores:s, total:Math.round(Object.values(s).reduce((a,b)=>a+b,0)*10)/10 };
}

function moneyline(hs, as) {
  const t = hs+as;
  const hi = hs/t, ai = as/t, v = 0.0238;
  function ml(p) {
    const pv = Math.min(Math.max(p+v,0.01),0.99);
    return pv>=0.5 ? Math.round(-(pv/(1-pv))*100) : Math.round(((1-pv)/pv)*100);
  }
  const hm=ml(hi), am=ml(ai);
  return {
    homeImplied: Math.round(hi*1000)/10, awayImplied: Math.round(ai*1000)/10,
    homeML: hm>0?`+${hm}`:`${hm}`, awayML: am>0?`+${am}`:`${am}`,
  };
}

// ─── 32-Team Database ────────────────────────────────────────────────────────
const DB = {
  ANA:{name:'Anaheim Ducks',       gfpg:2.80,gapg:3.40,pp:19.2,pk:79.0,fo:49.0,svp:0.898,gaa:3.20,tl:0.55,d:0.45,inj:0.70,l10:0.40,pi:0.30,cr:0.55,ar:0.50,b2b:false,td:0,g:'L. Dostal',     injs:[]},
  BOS:{name:'Boston Bruins',        gfpg:3.15,gapg:2.95,pp:26.3,pk:76.4,fo:53.0,svp:0.931,gaa:1.87,tl:0.80,d:0.60,inj:0.81,l10:0.75,pi:0.90,cr:0.65,ar:0.60,b2b:false,td:0,g:'J. Swayman',    injs:[]},
  BUF:{name:'Buffalo Sabres',       gfpg:3.48,gapg:2.88,pp:20.4,pk:87.7,fo:50.0,svp:0.914,gaa:2.54,tl:0.82,d:0.70,inj:0.63,l10:0.80,pi:0.75,cr:0.65,ar:0.60,b2b:false,td:0,g:'A. Lyon',       injs:[]},
  CGY:{name:'Calgary Flames',       gfpg:2.95,gapg:3.20,pp:21.0,pk:80.5,fo:50.5,svp:0.895,gaa:3.10,tl:0.58,d:0.50,inj:0.72,l10:0.45,pi:0.50,cr:0.58,ar:0.55,b2b:false,td:0,g:'D. Wolf',       injs:[]},
  CAR:{name:'Carolina Hurricanes',  gfpg:3.30,gapg:2.70,pp:22.5,pk:84.0,fo:51.0,svp:0.918,gaa:2.60,tl:0.78,d:0.75,inj:0.80,l10:0.70,pi:0.85,cr:0.80,ar:0.75,b2b:false,td:0,g:'F. Andersen',   injs:[]},
  CHI:{name:'Chicago Blackhawks',   gfpg:3.10,gapg:3.00,pp:22.0,pk:81.0,fo:49.5,svp:0.905,gaa:2.90,tl:0.75,d:0.55,inj:0.75,l10:0.55,pi:0.65,cr:0.62,ar:0.58,b2b:false,td:0,g:'P. Wedgewood', injs:[]},
  COL:{name:'Colorado Avalanche',   gfpg:3.90,gapg:2.90,pp:27.0,pk:83.0,fo:51.5,svp:0.920,gaa:2.70,tl:0.95,d:0.85,inj:0.85,l10:0.80,pi:0.95,cr:0.85,ar:0.80,b2b:false,td:0,g:'A. Georgiev',   injs:[]},
  CBJ:{name:'Columbus Blue Jackets',gfpg:3.20,gapg:2.85,pp:23.5,pk:83.5,fo:50.0,svp:0.916,gaa:2.55,tl:0.70,d:0.65,inj:0.78,l10:0.65,pi:0.70,cr:0.65,ar:0.62,b2b:false,td:0,g:'E. Cooley',     injs:[]},
  DAL:{name:'Dallas Stars',         gfpg:3.40,gapg:2.80,pp:24.0,pk:84.5,fo:52.0,svp:0.922,gaa:2.50,tl:0.88,d:0.80,inj:0.82,l10:0.75,pi:0.92,cr:0.82,ar:0.78,b2b:false,td:0,g:'J. Oettinger',  injs:[]},
  DET:{name:'Detroit Red Wings',    gfpg:3.05,gapg:3.05,pp:20.5,pk:80.0,fo:50.0,svp:0.900,gaa:3.00,tl:0.65,d:0.58,inj:0.72,l10:0.55,pi:0.65,cr:0.62,ar:0.58,b2b:false,td:0,g:'A. Nedeljkovic',injs:[]},
  EDM:{name:'Edmonton Oilers',      gfpg:3.60,gapg:3.10,pp:28.5,pk:81.0,fo:52.5,svp:0.910,gaa:2.90,tl:0.98,d:0.65,inj:0.80,l10:0.65,pi:0.90,cr:0.72,ar:0.68,b2b:false,td:0,g:'C. Ingram',     injs:[]},
  FLA:{name:'Florida Panthers',     gfpg:3.45,gapg:2.75,pp:25.5,pk:85.5,fo:51.0,svp:0.925,gaa:2.45,tl:0.92,d:0.82,inj:0.85,l10:0.75,pi:0.95,cr:0.85,ar:0.80,b2b:false,td:0,g:'S. Bobrovsky', injs:[]},
  LA: {name:'Los Angeles Kings',    gfpg:2.85,gapg:2.65,pp:18.5,pk:86.5,fo:51.5,svp:0.918,gaa:2.60,tl:0.72,d:0.72,inj:0.82,l10:0.60,pi:0.75,cr:0.75,ar:0.72,b2b:false,td:0,g:'D. Rittich',    injs:[]},
  MIN:{name:'Minnesota Wild',       gfpg:3.35,gapg:2.85,pp:23.0,pk:83.5,fo:51.0,svp:0.920,gaa:2.60,tl:0.80,d:0.72,inj:0.82,l10:0.70,pi:0.85,cr:0.75,ar:0.70,b2b:false,td:0,g:'F. Gustavsson', injs:[]},
  MTL:{name:'Montreal Canadiens',   gfpg:3.10,gapg:3.15,pp:22.8,pk:79.0,fo:50.0,svp:0.902,gaa:3.05,tl:0.65,d:0.55,inj:0.75,l10:0.55,pi:0.55,cr:0.60,ar:0.58,b2b:false,td:0,g:'J. Dobes',      injs:[]},
  NSH:{name:'Nashville Predators',  gfpg:2.90,gapg:3.30,pp:19.5,pk:79.5,fo:49.5,svp:0.895,gaa:3.20,tl:0.60,d:0.50,inj:0.68,l10:0.40,pi:0.40,cr:0.58,ar:0.55,b2b:false,td:0,g:'J. Saros',      injs:[]},
  NJ: {name:'New Jersey Devils',    gfpg:3.00,gapg:2.90,pp:21.8,pk:82.5,fo:50.5,svp:0.912,gaa:2.75,tl:0.80,d:0.65,inj:0.78,l10:0.60,pi:0.70,cr:0.68,ar:0.65,b2b:false,td:0,g:'J. Markstrom',  injs:[]},
  NYI:{name:'New York Islanders',   gfpg:3.15,gapg:2.95,pp:20.8,pk:82.0,fo:51.0,svp:0.910,gaa:2.85,tl:0.72,d:0.65,inj:0.78,l10:0.60,pi:0.72,cr:0.68,ar:0.62,b2b:false,td:0,g:'I. Sorokin',    injs:[]},
  NYR:{name:'New York Rangers',     gfpg:2.56,gapg:2.93,pp:23.8,pk:78.1,fo:50.0,svp:0.913,gaa:2.49,tl:0.70,d:0.50,inj:0.50,l10:0.45,pi:0.60,cr:0.60,ar:0.55,b2b:false,td:0,g:'I. Shesterkin', injs:[]},
  OTT:{name:'Ottawa Senators',      gfpg:3.20,gapg:3.00,pp:22.0,pk:81.5,fo:50.5,svp:0.908,gaa:2.95,tl:0.72,d:0.62,inj:0.78,l10:0.62,pi:0.68,cr:0.65,ar:0.60,b2b:false,td:0,g:'L. Ullmark',    injs:[]},
  PHI:{name:'Philadelphia Flyers',  gfpg:3.25,gapg:2.90,pp:24.5,pk:83.0,fo:50.5,svp:0.916,gaa:2.65,tl:0.75,d:0.68,inj:0.80,l10:0.65,pi:0.72,cr:0.68,ar:0.65,b2b:false,td:0,g:'S. Vladar',     injs:[]},
  PIT:{name:'Pittsburgh Penguins',  gfpg:2.90,gapg:3.10,pp:20.0,pk:80.5,fo:52.0,svp:0.898,gaa:3.05,tl:0.75,d:0.58,inj:0.72,l10:0.45,pi:0.60,cr:0.62,ar:0.60,b2b:false,td:0,g:'A. Nedeljkovic',injs:[]},
  SEA:{name:'Seattle Kraken',       gfpg:3.00,gapg:3.05,pp:20.5,pk:81.5,fo:49.5,svp:0.906,gaa:2.95,tl:0.68,d:0.60,inj:0.75,l10:0.52,pi:0.65,cr:0.65,ar:0.62,b2b:false,td:0,g:'P. Grubauer',   injs:[]},
  SJ: {name:'San Jose Sharks',      gfpg:2.70,gapg:3.60,pp:17.5,pk:77.0,fo:48.5,svp:0.885,gaa:3.50,tl:0.55,d:0.40,inj:0.65,l10:0.30,pi:0.20,cr:0.55,ar:0.50,b2b:false,td:0,g:'M. Blackwood',  injs:[]},
  STL:{name:'St. Louis Blues',      gfpg:3.15,gapg:3.00,pp:22.5,pk:82.0,fo:51.0,svp:0.910,gaa:2.85,tl:0.72,d:0.65,inj:0.78,l10:0.60,pi:0.70,cr:0.70,ar:0.65,b2b:false,td:0,g:'J. Binnington', injs:[]},
  TB: {name:'Tampa Bay Lightning',  gfpg:3.50,gapg:2.80,pp:26.0,pk:85.0,fo:52.0,svp:0.922,gaa:2.55,tl:0.92,d:0.80,inj:0.85,l10:0.75,pi:0.92,cr:0.85,ar:0.80,b2b:false,td:0,g:'A. Vasilevskiy',injs:[]},
  TOR:{name:'Toronto Maple Leafs',  gfpg:3.14,gapg:3.48,pp:29.5,pk:84.2,fo:50.0,svp:0.912,gaa:2.90,tl:0.88,d:0.50,inj:0.81,l10:0.40,pi:0.60,cr:0.60,ar:0.55,b2b:false,td:0,g:'A. Stolarz',    injs:[]},
  UTA:{name:'Utah Mammoth',         gfpg:3.05,gapg:3.15,pp:21.0,pk:81.5,fo:50.0,svp:0.904,gaa:3.00,tl:0.65,d:0.58,inj:0.75,l10:0.50,pi:0.55,cr:0.62,ar:0.58,b2b:false,td:0,g:'C. Vejmelka',   injs:[]},
  VAN:{name:'Vancouver Canucks',    gfpg:3.20,gapg:3.10,pp:22.0,pk:81.0,fo:51.0,svp:0.906,gaa:2.95,tl:0.80,d:0.68,inj:0.78,l10:0.58,pi:0.72,cr:0.68,ar:0.65,b2b:false,td:0,g:'F. Ahl.',       injs:[]},
  VGK:{name:'Vegas Golden Knights', gfpg:3.30,gapg:2.90,pp:23.5,pk:83.5,fo:51.5,svp:0.916,gaa:2.70,tl:0.85,d:0.78,inj:0.82,l10:0.65,pi:0.88,cr:0.80,ar:0.75,b2b:false,td:0,g:'A. Hill',       injs:[]},
  WSH:{name:'Washington Capitals',  gfpg:3.20,gapg:3.00,pp:22.8,pk:82.5,fo:51.0,svp:0.910,gaa:2.80,tl:0.82,d:0.68,inj:0.80,l10:0.62,pi:0.80,cr:0.72,ar:0.68,b2b:false,td:0,g:'C. Lindgren',   injs:[]},
  WPG:{name:'Winnipeg Jets',        gfpg:3.35,gapg:2.80,pp:24.5,pk:84.0,fo:52.5,svp:0.920,gaa:2.55,tl:0.85,d:0.75,inj:0.85,l10:0.72,pi:0.90,cr:0.80,ar:0.75,b2b:false,td:0,g:'C. Hellebuyck', injs:[]},
};

// Map compact DB fields to full team object
function getTeam(abbr) {
  const t = DB[abbr];
  if (!t) return null;
  return {
    name: t.name, abbr,
    goalsForPG: t.gfpg, goalsAgainstPG: t.gapg,
    ppPct: t.pp, pkPct: t.pk, foPct: t.fo,
    starterSvPct: t.svp, goalieRecentGAA: t.gaa,
    starterIsConfirmed: true, starterName: t.g,
    topLineRating: t.tl, depthRating: t.d,
    injuryImpact: t.inj, last10WinPct: t.l10,
    playoffImportance: t.pi, coachingRating: t.cr,
    adjustmentRating: t.ar, isBackToBack: t.b2b,
    travelDistance: t.td, injuries: t.injs,
  };
}

const STATIC_GAMES = [
  { id:'BUF-BOS-static', home:'BUF', away:'BOS', time:'6:30 PM CDT', status:'scheduled', venue:'KeyBank Center' },
  { id:'TOR-NYR-static', home:'TOR', away:'NYR', time:'6:30 PM CDT', status:'scheduled', venue:'Scotiabank Arena' },
];

function buildGame(game) {
  const hd = getTeam(game.home);
  const ad = getTeam(game.away);
  if (!hd || !ad) return null;
  const hr = score(hd, true);
  const ar = score(ad, false);
  const ml = moneyline(hr.total, ar.total);
  const logoBase = 'https://assets.nhle.com/logos/nhl/svg';

  const lead = hr.total > ar.total ? game.home : game.away;
  const gap = Math.abs(hr.total - ar.total).toFixed(1);
  const favML = hr.total > ar.total ? ml.homeML : ml.awayML;

  const homePP = hd.ppPct>=25?'elite':hd.ppPct>=21?'average':'below-average';
  const awayPP = ad.ppPct>=25?'elite':ad.ppPct>=21?'average':'below-average';
  const homePK = hd.pkPct>=85?'elite':hd.pkPct>=80?'solid':'poor';
  const awayPK = ad.pkPct>=85?'elite':ad.pkPct>=80?'solid':'poor';

  let summary = `The model projects ${lead} as the favourite at ${favML}, with a ${gap}-point edge in the moneyline calculation. `;
  if (hd.isBackToBack) summary += `${ad.name} benefit from rest — ${hd.name} are on a back-to-back with ${hd.starterName}. `;
  if (ad.isBackToBack) summary += `${hd.name} benefit from rest — ${ad.name} are on a back-to-back with ${ad.starterName}. `;
  if (hd.starterSvPct < 0.895) summary += `${hd.starterName} is a below-average starter, elevating scoring risk for ${game.home}. `;
  if (ad.starterSvPct < 0.895) summary += `${ad.starterName} is a liability in net for ${game.away}. `;
  summary += `${hd.name}: ${homePP} PP (${hd.ppPct}%), ${homePK} PK (${hd.pkPct}%). `;
  summary += `${ad.name}: ${awayPP} PP (${ad.ppPct}%), ${awayPK} PK (${ad.pkPct}%). `;
  const injs = [...hd.injuries.map(x=>`${game.home}: ${x}`),...ad.injuries.map(x=>`${game.away}: ${x}`)];
  if (injs.length) summary += `Injuries: ${injs.join(', ')}.`;

  return {
    id: game.id, time: game.time, status: game.status, venue: game.venue||'',
    moneyline: ml,
    home: {
      abbr:game.home, name:hd.name, record:hd.record||'',
      starterName:hd.starterName, injuries:hd.injuries, isBackToBack:hd.isBackToBack,
      score:hr.total, factors:hr.scores,
      logoUrl:`${logoBase}/${game.home}_light.svg`,
      stats:{ppPct:hd.ppPct,pkPct:hd.pkPct,goalsForPG:hd.goalsForPG,goalsAgainstPG:hd.goalsAgainstPG}
    },
    away: {
      abbr:game.away, name:ad.name, record:ad.record||'',
      starterName:ad.starterName, injuries:ad.injuries, isBackToBack:ad.isBackToBack,
      score:ar.total, factors:ar.scores,
      logoUrl:`${logoBase}/${game.away}_light.svg`,
      stats:{ppPct:ad.ppPct,pkPct:ad.pkPct,goalsForPG:ad.goalsForPG,goalsAgainstPG:ad.goalsAgainstPG}
    },
    summary, weights:W, lastUpdated:new Date().toISOString(),
  };
}

// ─── Express setup ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended:true }));
app.use(session({ secret:SESSION_SECRET, resave:false, saveUninitialized:false, cookie:{secure:false,maxAge:86400000} }));
app.use(express.static(path.join(__dirname,'public')));

function auth(req,res,next){ req.session?.authenticated ? next() : res.status(401).json({error:'Unauthorized'}); }

app.post('/auth/login',  (req,res)=>{ req.body.password===PASSWORD ? (req.session.authenticated=true,res.json({success:true})) : res.status(401).json({error:'Invalid password'}); });
app.post('/auth/logout', (req,res)=>{ req.session.destroy(); res.json({success:true}); });
app.get( '/auth/check',  (req,res)=>{ res.json({authenticated:!!(req.session?.authenticated)}); });

const dateStr = ()=>new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

app.get('/api/games', auth, async (req,res)=>{
  const games = (await getGames(false)).map(buildGame).filter(Boolean);
  res.json({ games, date:dateStr(), lastRefresh:new Date().toISOString() });
});

app.post('/api/refresh', auth, async (req,res)=>{
  cachedGames = null;
  try {
    const games = (await getGames(true)).map(buildGame).filter(Boolean);
    res.json({ games, date:dateStr(), lastRefresh:new Date().toISOString(), refreshed:true });
  } catch(e) {
    res.status(500).json({ error:'Refresh failed: '+e.message });
  }
});

app.listen(PORT, ()=>console.log(`NHL Stat running on port ${PORT}`));
