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
    // groups=80 is every FBS game; without it ESPN only returns featured games.
    scoreboardParams: { groups: '80', limit: '400' },
  },
};

export const LEAGUE_ORDER = ['nfl', 'nba', 'mlb', 'nhl', 'cfb'];

// Label for a period number, e.g. "Q3", "2nd", "OT", "Top 7th".
export function periodLabel(sport, period, { short = true } = {}) {
  if (!period) return '';
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
