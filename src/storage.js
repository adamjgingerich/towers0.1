/**
 * Persistence for the single save slot.
 *
 * Kept out of src/sim on purpose: the simulation must not know what
 * localStorage is, so it stays runnable under node. This is the only module
 * that touches browser storage.
 *
 * Every access is wrapped because localStorage throws rather than returning
 * null in some privacy modes, and a full disk raises on write. Losing a save is
 * annoying; crashing the game over it is not acceptable.
 */

const KEY = 'towers.save.v1';

/** @returns {object|null} the stored save, or null if absent or corrupt. */
export function readSave() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Corrupt JSON is treated as "no save" rather than a hard failure.
    return null;
  }
}

/** @returns {boolean} false when the write was rejected (quota, private mode) */
export function writeSave(data) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function clearSave() {
  try {
    window.localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasSave() {
  return readSave() !== null;
}

// ------------------------------------------------------------- characters

/**
 * Named characters and their progress.
 *
 * Progress is per name, not per install, because "pick a character name" only
 * means something if a second name starts from nothing. A character owns one
 * number per map -- the furthest wave survived there -- and everything else
 * (which maps are open) is derived from that, so the two can never disagree.
 */
const PLAYERS_KEY = 'towers.players.v1';
const ACTIVE_KEY = 'towers.player.v1';
/** Pre-progression builds kept a single best wave. Migrated on first run. */
const LEGACY_BEST_KEY = 'towers.bestWave';

/**
 * Waves that must be survived on one map before the next opens.
 *
 * A floor, not a limit: the run does not stop at 40, it just stops being the
 * only thing to do.
 */
export const UNLOCK_WAVE = 40;

/** Long enough for a name, short enough to fit the HUD and stay a sane key. */
export const MAX_NAME_LENGTH = 16;

/**
 * Clean a typed name into something safe to use as an object key and to draw.
 *
 * Control characters are stripped rather than escaped: a name is a label on a
 * localStorage key, and letting a newline or a bidi override through would
 * corrupt the HUD rather than merely look odd.
 */
export function sanitiseName(raw) {
  return String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/** @returns {Record<string, {best: Record<string, number>}>} */
export function readPlayers() {
  try {
    const raw = window.localStorage.getItem(PLAYERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [name, value] of Object.entries(parsed)) {
      const clean = sanitiseName(name);
      if (!clean) continue;
      const best = value && typeof value.best === 'object' && value.best !== null
        ? value.best
        : {};
      // Numbers only: a corrupted entry must not become NaN and poison every
      // comparison it touches.
      const safe = {};
      for (const [mapId, wave] of Object.entries(best)) {
        const n = Number(wave);
        if (Number.isFinite(n) && n > 0) safe[mapId] = Math.floor(n);
      }
      out[clean] = { best: safe };
    }
    return out;
  } catch {
    return {};
  }
}

/** @returns {boolean} false when the write was rejected */
export function writePlayers(players) {
  try {
    window.localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
    return true;
  } catch {
    return false;
  }
}

export function readActiveName() {
  try {
    return sanitiseName(window.localStorage.getItem(ACTIVE_KEY));
  } catch {
    return '';
  }
}

// ------------------------------------------------------------- meta (skills)

/**
 * Persistent skill-tree progress, keyed by character name.
 *
 * Stored separately from the players table because its shape is different: a
 * wallet of Cores plus bought node ranks, not per-map best waves. Per-name so a
 * second character climbs the tree from nothing, exactly like map unlocks.
 */
const META_KEY = 'towers.meta.v1';

/**
 * @param {string} playerName
 * @returns {{cores: number, nodes: Record<string, number>}}
 */
export function readMeta(playerName) {
  const empty = { cores: 0, nodes: {} };
  const name = sanitiseName(playerName);
  if (!name) return empty;
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    const entry = parsed && typeof parsed === 'object' && parsed[name]
      ? parsed[name]
      : null;
    if (!entry || typeof entry !== 'object') return empty;

    const cores = Number(entry.cores);
    const nodes = {};
    if (entry.nodes && typeof entry.nodes === 'object') {
      for (const [id, rank] of Object.entries(entry.nodes)) {
        const n = Number(rank);
        if (Number.isInteger(n) && n >= 1) nodes[id] = n;
      }
    }
    return {
      cores: Number.isFinite(cores) && cores >= 0 ? Math.floor(cores) : 0,
      nodes,
    };
  } catch {
    return empty;
  }
}

/**
 * @param {string} playerName
 * @param {{cores: number, nodes: Record<string, number>}} meta
 * @returns {boolean} false when the write was rejected
 */
export function writeMeta(playerName, meta) {
  const name = sanitiseName(playerName);
  if (!name) return false;
  try {
    let all = {};
    const raw = window.localStorage.getItem(META_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') all = parsed;
    }
    all[name] = {
      cores: Math.max(0, Math.floor(Number(meta?.cores) || 0)),
      nodes: meta?.nodes && typeof meta.nodes === 'object' ? meta.nodes : {},
    };
    window.localStorage.setItem(META_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function writeActiveName(name) {
  try {
    window.localStorage.setItem(ACTIVE_KEY, sanitiseName(name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Carry a pre-progression best wave onto the first map.
 *
 * Only fires when there are no characters at all, so it can never overwrite
 * real progress. Losing a record to a format change would be a poor trade for
 * three lines of migration.
 *
 * @returns {boolean} whether anything was migrated
 */
export function migrateLegacyBest(players, firstMapId) {
  if (!firstMapId || Object.keys(players).length > 0) return false;
  try {
    const legacy = Number(window.localStorage.getItem(LEGACY_BEST_KEY));
    if (!Number.isFinite(legacy) || legacy <= 0) return false;
    players.Default = { best: { [firstMapId]: Math.floor(legacy) } };
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the map at `index` is open for a character.
 *
 * Derived from the best waves rather than stored as a list of unlocked ids, so
 * there is no second source of truth to fall out of step with the first.
 */
export function mapUnlocked(levels, best, index) {
  if (index <= 0) return true;
  const previous = levels[index - 1];
  if (!previous) return true;
  return (best?.[previous.id] ?? 0) >= UNLOCK_WAVE;
}

/** How many maps a character can currently reach. */
export function unlockedCount(levels, best) {
  let count = 0;
  for (let i = 0; i < levels.length; i += 1) {
    if (!mapUnlocked(levels, best, i)) break;
    count += 1;
  }
  return Math.max(1, count);
}
