// League definitions. `path` is the ESPN site API path segment for the league.
// `weekly` leagues (football) are browsed by week instead of by day.

export const LEAGUES = {
  nfl: {
    id: 'nfl',
    label: 'NFL',
    name: 'National Football League',
    sport: 'football',
    path: 'football/nfl',
    weekly: true,
  },
  nba: {
    id: 'nba',
    label: 'NBA',
    name: 'National Basketball Association',
    sport: 'basketball',
    path: 'basketball/nba',
    weekly: false,
  },
  mlb: {
    id: 'mlb',
    label: 'MLB',
    name: 'Major League Baseball',
    sport: 'baseball',
    path: 'baseball/mlb',
    weekly: false,
  },
  nhl: {
    id: 'nhl',
    label: 'NHL',
    name: 'National Hockey League',
    sport: 'hockey',
    path: 'hockey/nhl',
    weekly: false,
  },
  cfb: {
    id: 'cfb',
    label: 'CFB',
    name: 'College Football',
    sport: 'football',
    path: 'football/college-football',
    weekly: true,
    college: true,
    // groups=80 is every FBS game; without it ESPN only returns featured games.
    // Picking a conference swaps in that conference's group id instead.
    scoreboardParams: { groups: '80', limit: '400' },
    teamsParams: { groups: '80' },
  },
  cbb: {
    id: 'cbb',
    label: 'CBB',
    name: "Men's College Basketball",
    sport: 'basketball',
    path: 'basketball/mens-college-basketball',
    weekly: false,
    college: true,
    halves: true, // two 20-minute halves, not quarters
    // groups=50 is every Division I game.
    scoreboardParams: { groups: '50', limit: '400' },
    teamsParams: { groups: '50' },
  },
};

export const LEAGUE_ORDER = ['nfl', 'nba', 'mlb', 'nhl', 'cfb', 'cbb'];

// Label for a period number, e.g. "Q3", "2nd", "OT", "Top 7th".
export function periodLabel(sport, period, { short = true, halves = false } = {}) {
  if (!period) return '';
  if (halves) {
    if (period <= 2) return short ? `${period}H` : `${ordinal(period)} Half`;
    const ot = period - 2;
    return ot === 1 ? 'OT' : `${ot}OT`;
  }
  if (sport === 'football' || sport === 'basketball') {
    if (period <= 4) return short ? `Q${period}` : `${ordinal(period)} Quarter`;
    const ot = period - 4;
    return ot === 1 ? 'OT' : `${ot}OT`;
  }
  if (sport === 'hockey') {
    if (period <= 3) return short ? ordinal(period) : `${ordinal(period)} Period`;
    const ot = period - 3;
    return ot === 1 ? 'OT' : `${ot}OT`;
  }
  return ordinal(period);
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Short period tag for play-by-play lists: "Q3", "H2", "P1", "OT", "SO".
export function periodShort(leagueId, n) {
  const league = LEAGUES[leagueId];
  if (!league || !n) return '';
  if (league.halves) return n <= 2 ? `H${n}` : n === 3 ? 'OT' : `${n - 2}OT`;
  if (league.sport === 'hockey') return n <= 3 ? `P${n}` : n === 4 ? 'OT' : 'SO';
  return n <= 4 ? `Q${n}` : n === 5 ? 'OT' : `${n - 4}OT`;
}

// Fallback names for the main conferences, keyed by ESPN group id, used only
// if the conference list can't be loaded from ESPN's standings.
export const CONFERENCE_FALLBACK = {
  cfb: {
    1: 'ACC',
    4: 'Big 12',
    5: 'Big Ten',
    8: 'SEC',
    9: 'Pac-12',
    12: 'C-USA',
    15: 'MAC',
    17: 'Mountain West',
    18: 'FBS Independents',
    37: 'Sun Belt',
    151: 'American',
  },
  cbb: {
    2: 'ACC',
    3: 'Atlantic 10',
    4: 'Big East',
    7: 'Big Ten',
    8: 'Big 12',
    18: 'Missouri Valley',
    21: 'Pac-12',
    23: 'SEC',
    29: 'West Coast',
    44: 'Mountain West',
    62: 'American',
  },
};
