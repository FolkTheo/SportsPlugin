// Settings and favorites sync across the user's browsers; UI state (which
// league/game was last open) is local so the popup, overlay and pop-out all
// reopen where the user left off.

export const DEFAULT_SETTINGS = {
  refreshSeconds: 15,
  notifyFavorites: true,
  cfbTop25Only: false,
  compact: false,
  hideFinal: false,
};

export const DEFAULT_UI = {
  league: 'nfl',
  view: 'scores', // 'scores' | 'game'
  gameId: null,
  gameLeague: null,
  gameTab: 'box',
};

const area = () => globalThis.chrome?.storage;

export async function getSettings() {
  const { settings } = (await area()?.sync.get('settings')) || {};
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await area()?.sync.set({ settings });
  return settings;
}

// Favorites are stored as "league:teamId" keys with display info alongside.
export async function getFavorites() {
  const { favorites } = (await area()?.sync.get('favorites')) || {};
  return Array.isArray(favorites) ? favorites : [];
}

export const favoriteKey = (league, teamId) => `${league}:${teamId}`;

export async function toggleFavorite(league, team) {
  const favorites = await getFavorites();
  const key = favoriteKey(league, team.id);
  const next = favorites.some((f) => f.key === key)
    ? favorites.filter((f) => f.key !== key)
    : [...favorites, { key, league, teamId: team.id, abbr: team.abbr, name: team.fullName || team.name, logo: team.logo }];
  await area()?.sync.set({ favorites: next });
  return next;
}

export async function getUiState() {
  const { ui } = (await area()?.local.get('ui')) || {};
  return { ...DEFAULT_UI, ...(ui || {}) };
}

export async function saveUiState(patch) {
  const ui = { ...(await getUiState()), ...patch };
  await area()?.local.set({ ui });
  return ui;
}
