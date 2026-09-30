// Conference names as fans know them ("SEC", "Sun Belt", "Big Ten").
// ESPN's standings give a full name ("Southeastern Conference") and a
// lowercase internal slug ("sec", "belt") that isn't meant for display, so
// labels come from these tables, then from a tidied full name.

// Keyed by normalized full name (see `key` below). Covers every FBS and
// Division I men's basketball conference, including former names.
const BY_NAME = {
  'america east conference': 'America East',
  'american athletic conference': 'American',
  'american conference': 'American',
  'asun conference': 'ASUN',
  'atlantic sun conference': 'ASUN',
  'atlantic 10 conference': 'Atlantic 10',
  'atlantic coast conference': 'ACC',
  'big 12 conference': 'Big 12',
  'big east conference': 'Big East',
  'big sky conference': 'Big Sky',
  'big south conference': 'Big South',
  'big ten conference': 'Big Ten',
  'big west conference': 'Big West',
  'coastal athletic association': 'CAA',
  'colonial athletic association': 'CAA',
  'conference usa': 'C-USA',
  'fbs independents': 'FBS Independents',
  'independents': 'Independents',
  'division i independents': 'Independents',
  'horizon league': 'Horizon League',
  'ivy league': 'Ivy League',
  'metro atlantic athletic conference': 'MAAC',
  'mid american conference': 'MAC',
  'mid eastern athletic conference': 'MEAC',
  'missouri valley conference': 'Missouri Valley',
  'mountain west conference': 'Mountain West',
  'northeast conference': 'NEC',
  'ohio valley conference': 'Ohio Valley',
  'pac 12 conference': 'Pac-12',
  'patriot league': 'Patriot League',
  'southeastern conference': 'SEC',
  'southern conference': 'SoCon',
  'southland conference': 'Southland',
  'southwestern athletic conference': 'SWAC',
  'summit league': 'Summit League',
  'sun belt conference': 'Sun Belt',
  'west coast conference': 'WCC',
  'western athletic conference': 'WAC',
};

// ESPN's internal slugs, for when the full name isn't one we know.
const BY_SLUG = {
  aac: 'American',
  acc: 'ACC',
  a10: 'Atlantic 10',
  amer: 'American',
  ameast: 'America East',
  asun: 'ASUN',
  b1g: 'Big Ten',
  belt: 'Sun Belt',
  big10: 'Big Ten',
  big12: 'Big 12',
  bigeast: 'Big East',
  bigsky: 'Big Sky',
  bigsouth: 'Big South',
  bigwest: 'Big West',
  caa: 'CAA',
  cusa: 'C-USA',
  horizon: 'Horizon League',
  ind: 'FBS Independents',
  ivy: 'Ivy League',
  maac: 'MAAC',
  mac: 'MAC',
  meac: 'MEAC',
  mvc: 'Missouri Valley',
  mwc: 'Mountain West',
  nec: 'NEC',
  ovc: 'Ohio Valley',
  pac12: 'Pac-12',
  patriot: 'Patriot League',
  sec: 'SEC',
  socon: 'SoCon',
  southland: 'Southland',
  summit: 'Summit League',
  swac: 'SWAC',
  wac: 'WAC',
  wcc: 'WCC',
};

const key = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// e.g. { name: 'Sun Belt Conference', abbreviation: 'belt' } -> 'Sun Belt'
export function conferenceLabel({ name = '', abbreviation = '' } = {}) {
  const known = BY_NAME[key(name)] || BY_SLUG[key(abbreviation).replace(/\s+/g, '')];
  if (known) return known;
  // Unknown conference: its full name minus the word "Conference".
  const tidy = String(name)
    .replace(/^the\s+/i, '')
    .replace(/\s+(athletic\s+)?conference$/i, '')
    .trim();
  return tidy || String(abbreviation).toUpperCase();
}

// Used only if the conference list can't be loaded from ESPN's standings.
// Keyed by ESPN group id.
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
    29: 'WCC',
    44: 'Mountain West',
    62: 'American',
  },
};
