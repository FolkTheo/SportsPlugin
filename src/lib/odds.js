// Betting odds. The primary source is DraftKings Sportsbook's own web feed
// (the unofficial JSON its site loads), which has live in-game lines. ESPN's
// odds (DraftKings is ESPN's odds provider) are the fallback when that feed is
// unreachable. Both are turned into one shape, oriented to ESPN's home/away:
//
//   { source: 'draftkings' | 'espn', provider, live, suspended, url,
//     spread:    { away: { line, price }, home: { line, price } } | null,
//     total:     { line, over, under } | null,
//     moneyline: { away, home } | null,
//     open:      { spread, total, moneyline } | null,   // ESPN only
//     details }

const DK_API = 'https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues';

// DraftKings league ids.
export const DK_LEAGUE_IDS = {
  nfl: 88808,
  nba: 42648,
  mlb: 84240,
  nhl: 42133,
  cfb: 87637,
  cbb: 92483,
};

export function draftKingsUrl(leagueId) {
  const id = DK_LEAGUE_IDS[leagueId];
  return id ? `${DK_API}/${id}` : null;
}

export function draftKingsEventUrl(eventId) {
  return `https://sportsbook.draftkings.com/event/${encodeURIComponent(eventId)}`;
}

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === undefined || v === null ? '' : String(v));

// ---------------------------------------------------------------------------
// Formatting & math

// "+130", "-110", "EVEN". Accepts numbers or strings (DraftKings uses U+2212).
export function formatAmerican(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim().replace(/[−–]/g, '-');
  if (/^even$/i.test(s)) return 'EVEN';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n === 100) return '+100';
  return n > 0 ? `+${n}` : String(n);
}

// Spread line: "+2.5", "-7", "PK".
export function formatLine(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(String(v).replace(/[−–]/g, '-').replace(/^[ou]/i, ''));
  if (!Number.isFinite(n)) return String(v);
  if (n === 0) return 'PK';
  return n > 0 ? `+${n}` : String(n);
}

function formatTotal(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(String(v).replace(/^[ou]/i, ''));
  return Number.isFinite(n) ? String(n) : String(v);
}

function americanToNumber(v) {
  const s = formatAmerican(v);
  if (s === 'EVEN') return 100;
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

export function impliedProbability(american) {
  const n = americanToNumber(american);
  if (n === null) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

// Win probability from the moneyline with the bookmaker's margin removed.
export function noVigProbabilities(moneyline) {
  const a = impliedProbability(moneyline?.away);
  const h = impliedProbability(moneyline?.home);
  if (a === null || h === null) return null;
  return { away: a / (a + h), home: h / (a + h) };
}

// ---------------------------------------------------------------------------
// DraftKings feed

function selectionPrice(s) {
  return formatAmerican(s?.displayOdds?.american ?? s?.oddsAmerican ?? s?.americanOdds ?? '');
}

function selectionSide(s, home, away) {
  const role = str(s.outcomeType || arr(s.participants)[0]?.venueRole).toLowerCase();
  if (role === 'home' || role === 'away') return role;
  const label = str(s.label).toLowerCase();
  if (label && label === str(home?.name).toLowerCase()) return 'home';
  if (label && label === str(away?.name).toLowerCase()) return 'away';
  if (/^over\b/i.test(s.label) || role === 'over') return 'over';
  if (/^under\b/i.test(s.label) || role === 'under') return 'under';
  return '';
}

function marketKind(m) {
  const name = str(m.marketType?.name || m.name).toLowerCase();
  if (/money\s*line/.test(name)) return 'moneyline';
  if (/spread|puck line|run line/.test(name)) return 'spread';
  if (/^total/.test(name) && !/team|player|alternate/.test(name)) return 'total';
  return '';
}

function participantsOf(e) {
  const parts = arr(e.participants);
  let home = parts.find((p) => /home/i.test(p.venueRole));
  let away = parts.find((p) => /away/i.test(p.venueRole));
  if (!home || !away) {
    // Fall back to the event name: "KC Chiefs @ BUF Bills" / "A at B".
    const m = /^(.*?)\s+(?:@|at)\s+(.*)$/i.exec(str(e.name));
    if (m) {
      away = away || { name: m[1] };
      home = home || { name: m[2] };
    }
  }
  return { home: { name: str(home?.name) }, away: { name: str(away?.name) } };
}

export function normalizeDraftKings(json) {
  const byMarket = new Map();
  for (const s of arr(json?.selections)) {
    const key = str(s.marketId);
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(s);
  }
  const byEvent = new Map();
  for (const m of arr(json?.markets)) {
    const key = str(m.eventId);
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(m);
  }

  return arr(json?.events).map((e) => {
    const id = str(e.id || e.eventId);
    const { home, away } = participantsOf(e);
    const status = str(e.status || e.eventStatus?.state).toUpperCase();
    const out = {
      id,
      name: str(e.name),
      start: str(e.startEventDate || e.startDate),
      live: /^(STARTED|LIVE|IN_?PROGRESS|IN_?PLAY)$/.test(status) || e.isLive === true,
      home,
      away,
      spread: null,
      total: null,
      moneyline: null,
      suspended: false,
    };
    for (const m of byEvent.get(id) || []) {
      const kind = marketKind(m);
      // Keep the first (main) market of each kind.
      if (!kind || out[kind]) continue;
      const sels = byMarket.get(str(m.id)) || [];
      const sides = {};
      for (const s of sels) {
        const side = selectionSide(s, home, away);
        if (side && !sides[side]) sides[side] = s;
      }
      if (m.isSuspended || m.status === 'SUSPENDED') out.suspended = true;
      if (kind === 'moneyline' && sides.home && sides.away) {
        out.moneyline = { away: selectionPrice(sides.away), home: selectionPrice(sides.home) };
      } else if (kind === 'spread' && sides.home && sides.away) {
        out.spread = {
          away: { line: formatLine(sides.away.points), price: selectionPrice(sides.away) },
          home: { line: formatLine(sides.home.points), price: selectionPrice(sides.home) },
        };
      } else if (kind === 'total' && sides.over && sides.under) {
        out.total = {
          line: formatTotal(sides.over.points ?? sides.under.points),
          over: selectionPrice(sides.over),
          under: selectionPrice(sides.under),
        };
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Matching DraftKings events to ESPN games

function norm(s) {
  return str(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'’()]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// How confidently a DraftKings participant name ("KC Chiefs", "Alabama",
// "Los Angeles Lakers") names an ESPN team. 0 means no match.
export function teamMatchScore(dkName, team) {
  const n = norm(dkName);
  if (!n || !team) return 0;
  const full = norm(team.fullName);
  const nick = norm(team.nickname);
  const loc = norm(team.location);
  const short = norm(team.name);
  if (n === full) return 4;
  if (nick && (n === nick || n.endsWith(` ${nick}`))) return 3;
  if ((loc && n === loc) || (short && n === short)) return 2;
  if (norm(team.abbr) && n === norm(team.abbr)) return 2;
  if (full && (full.startsWith(`${n} `) || n.startsWith(`${full} `))) return 1;
  return 0;
}

function swapSides(odds) {
  const swap = (pair) => (pair ? { away: pair.home, home: pair.away } : pair);
  return { ...odds, spread: swap(odds.spread), moneyline: swap(odds.moneyline) };
}

const MAX_START_GAP_MS = 20 * 3600 * 1000;

// Returns Map(gameId -> odds) for the games DraftKings has lines on.
export function matchDraftKings(games, dkEvents) {
  const result = new Map();
  const used = new Set();
  for (const g of games) {
    const gameTime = Date.parse(g.date);
    let best = null;
    for (const e of dkEvents) {
      if (used.has(e.id)) continue;
      const t = Date.parse(e.start);
      if (Number.isFinite(t) && Number.isFinite(gameTime) && Math.abs(t - gameTime) > MAX_START_GAP_MS) continue;
      const straight = Math.min(teamMatchScore(e.away.name, g.away), teamMatchScore(e.home.name, g.home));
      // Neutral-site games may list home/away the other way round.
      const swapped = Math.min(teamMatchScore(e.away.name, g.home), teamMatchScore(e.home.name, g.away));
      const score = Math.max(straight, swapped - 0.5);
      if (score > 0 && (!best || score > best.score)) best = { e, score, swapped: swapped - 0.5 > straight };
    }
    if (!best) continue;
    used.add(best.e.id);
    const { e } = best;
    const odds = {
      source: 'draftkings',
      provider: 'DraftKings',
      live: e.live,
      suspended: e.suspended,
      url: draftKingsEventUrl(e.id),
      spread: e.spread,
      total: e.total,
      moneyline: e.moneyline,
      open: null,
      details: '',
    };
    if (odds.spread || odds.total || odds.moneyline) result.set(g.id, best.swapped ? swapSides(odds) : odds);
  }
  return result;
}

// ---------------------------------------------------------------------------
// ESPN odds (scoreboard `competitions[0].odds`, summary `pickcenter`)

function pick(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

export function oddsFromEspn(list) {
  const items = arr(list).filter((o) => o && typeof o === 'object');
  const o = items.find((x) => /draft\s*kings/i.test(x.provider?.name || '')) || items[0];
  if (!o) return null;

  const side = (key) => o[`${key}TeamOdds`] || {};
  const ml = (key) =>
    formatAmerican(pick(o.moneyline?.[key]?.close?.odds, o.moneyline?.[key]?.current?.odds, side(key).moneyLine));
  const moneyline = ml('away') && ml('home') ? { away: ml('away'), home: ml('home') } : null;

  // ESPN's bare `spread` number is from the home team's perspective.
  const homeLine = pick(o.pointSpread?.home?.close?.line, o.pointSpread?.home?.current?.line, o.spread);
  const awayLine = pick(o.pointSpread?.away?.close?.line, o.pointSpread?.away?.current?.line, Number.isFinite(Number(homeLine)) ? -Number(homeLine) : undefined);
  const spread =
    homeLine !== undefined && awayLine !== undefined
      ? {
          away: { line: formatLine(awayLine), price: formatAmerican(pick(o.pointSpread?.away?.close?.odds, side('away').spreadOdds)) },
          home: { line: formatLine(homeLine), price: formatAmerican(pick(o.pointSpread?.home?.close?.odds, side('home').spreadOdds)) },
        }
      : null;

  const totalLine = pick(o.total?.over?.close?.line, o.overUnder);
  const total =
    totalLine !== undefined
      ? {
          line: formatTotal(totalLine),
          over: formatAmerican(pick(o.total?.over?.close?.odds, o.overOdds)),
          under: formatAmerican(pick(o.total?.under?.close?.odds, o.underOdds)),
        }
      : null;

  const openHome = o.pointSpread?.home?.open?.line;
  const openTotal = o.total?.over?.open?.line;
  const openMl = o.moneyline?.home?.open?.odds && o.moneyline?.away?.open?.odds;
  const open =
    openHome !== undefined || openTotal !== undefined || openMl
      ? {
          spread: openHome !== undefined ? { home: formatLine(openHome), away: formatLine(o.pointSpread?.away?.open?.line ?? -Number(openHome)) } : null,
          total: openTotal !== undefined ? formatTotal(openTotal) : null,
          moneyline: openMl ? { away: formatAmerican(o.moneyline.away.open.odds), home: formatAmerican(o.moneyline.home.open.odds) } : null,
        }
      : null;

  if (!spread && !total && !moneyline && !o.details) return null;
  return {
    source: 'espn',
    provider: o.provider?.name || 'ESPN',
    live: false,
    suspended: false,
    url: '',
    spread,
    total,
    moneyline,
    open,
    details: str(o.details),
  };
}

// Prefer DraftKings' own (live) numbers, keeping ESPN's opening line.
export function mergeOdds(dk, espn) {
  if (!dk) return espn || null;
  return { ...dk, open: espn?.open || null, details: espn?.details || '' };
}
