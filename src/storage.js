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
 * Named characters and everything they own.
 *
 * One record per name, rather than the two separate tables this used to keep
 * (`players` for best waves, `meta` for the skill tree). They were split when a
 * character only had two things; a character now also owns the secret weapons
 * they have earned and the timestamps that make a roster list worth reading, and
 * three tables keyed by the same name is three chances for them to disagree.
 *
 * Progress is per name, not per install, because "pick a character name" only
 * means something if a second name starts from nothing.
 *
 * Everything here lives in localStorage, which is **per browser**. Two people on
 * two machines never see each other's characters. `src/sync.js` adds an optional
 * shared store on top for exactly that reason; this module stays the source of
 * truth either way, and works offline.
 */
const ROSTER_KEY = 'towers.roster.v2';
/** Superseded by ROSTER_KEY. Read once, folded in, then left alone. */
const PLAYERS_KEY = 'towers.players.v1';
const META_KEY = 'towers.meta.v1';
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

/** How many characters one browser will keep. Bounded so the list stays a list. */
export const MAX_PLAYERS = 24;

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

/** A character who has never played. */
export function blankPlayer(name, now = Date.now()) {
  return {
    name,
    best: {},
    cores: 0,
    nodes: {},
    weapons: [],
    runs: 0,
    createdAt: now,
    lastSeen: now,
  };
}

/**
 * Coerce one stored record into a known shape.
 *
 * Numbers go through `Number.isFinite` rather than `Number(x) || 0`, because a
 * saved 0 is a real value in all three numeric fields here and `||` would treat
 * it as missing. Anything unrecognised degrades to empty rather than throwing:
 * a corrupt character should cost the player that character, never the game.
 */
function cleanPlayer(name, raw, fallbackNow) {
  const out = blankPlayer(name, fallbackNow);
  if (!raw || typeof raw !== 'object') return out;

  if (raw.best && typeof raw.best === 'object' && !Array.isArray(raw.best)) {
    for (const [mapId, wave] of Object.entries(raw.best)) {
      const n = Number(wave);
      if (Number.isFinite(n) && n > 0) out.best[mapId] = Math.floor(n);
    }
  }

  const cores = Number(raw.cores);
  out.cores = Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 0;

  if (raw.nodes && typeof raw.nodes === 'object' && !Array.isArray(raw.nodes)) {
    for (const [id, rank] of Object.entries(raw.nodes)) {
      const n = Number(rank);
      if (Number.isInteger(n) && n >= 1) out.nodes[id] = n;
    }
  }

  /*
    Weapons are tower keys, so they are filtered against the roster the game
    actually ships. A key left over from an older build would otherwise sit in
    the list forever, and `unlockedTowers` would claim a tower that no longer
    exists.
  */
  if (Array.isArray(raw.weapons)) {
    out.weapons = [...new Set(raw.weapons.filter((k) => typeof k === 'string' && k))];
  }

  const runs = Number(raw.runs);
  out.runs = Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 0;
  const created = Number(raw.createdAt);
  out.createdAt = Number.isFinite(created) && created > 0 ? created : fallbackNow;
  const seen = Number(raw.lastSeen);
  out.lastSeen = Number.isFinite(seen) && seen > 0 ? seen : out.createdAt;
  return out;
}

/**
 * Fold the two superseded tables into one roster.
 *
 * Runs only when there is no roster yet, so it can never overwrite live data.
 * The old keys are deliberately left in place: they cost a few hundred bytes,
 * and deleting them would make a rollback to the previous build lose everyone's
 * progress. Re-running this is idempotent because of the same guard.
 */
function migrateToRoster(now) {
  const out = {};
  const readOld = (key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const oldPlayers = readOld(PLAYERS_KEY);
  const oldMeta = readOld(META_KEY);
  const names = new Set([...Object.keys(oldPlayers), ...Object.keys(oldMeta)]);

  for (const rawName of names) {
    const name = sanitiseName(rawName);
    if (!name) continue;
    const merged = { ...(oldPlayers[rawName] ?? {}) };
    const meta = oldMeta[rawName];
    if (meta && typeof meta === 'object') {
      merged.cores = meta.cores;
      merged.nodes = meta.nodes;
    }
    out[name] = cleanPlayer(name, merged, now);
  }
  return out;
}

/**
 * Every character this browser knows about.
 *
 * @returns {Record<string, object>} name -> record
 */
export function readRoster() {
  const now = Date.now();
  try {
    const raw = window.localStorage.getItem(ROSTER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out = {};
        for (const [rawName, value] of Object.entries(parsed)) {
          const name = sanitiseName(rawName);
          if (!name) continue;
          out[name] = cleanPlayer(name, value, now);
        }
        return out;
      }
    }
  } catch {
    // Fall through to migration: a corrupt roster is still better replaced by
    // the legacy tables than by nothing.
  }

  const migrated = migrateToRoster(now);
  if (Object.keys(migrated).length > 0) writeRoster(migrated);
  return migrated;
}

/** @returns {boolean} false when the write was rejected (quota, private mode) */
export function writeRoster(roster) {
  try {
    window.localStorage.setItem(ROSTER_KEY, JSON.stringify(roster ?? {}));
    return true;
  } catch {
    return false;
  }
}

/** One character's record, or a blank one if the name is unknown. */
export function readPlayer(name) {
  const clean = sanitiseName(name);
  if (!clean) return blankPlayer('');
  return readRoster()[clean] ?? blankPlayer(clean);
}

/**
 * Merge a patch into one character and persist.
 *
 * Read-modify-write rather than a whole-roster save, so a caller that only knows
 * about the active character cannot clobber a different one that was updated in
 * another tab.
 *
 * @returns {object|null} the saved record, or null if it could not be stored
 */
export function savePlayer(name, patch) {
  const clean = sanitiseName(name);
  if (!clean) return null;
  const roster = readRoster();
  const current = roster[clean] ?? blankPlayer(clean);
  const next = cleanPlayer(clean, { ...current, ...patch, name: clean }, current.createdAt);
  next.lastSeen = Date.now();
  roster[clean] = next;

  // Oldest first once over the cap, so a shared machine does not grow forever.
  const names = Object.keys(roster);
  if (names.length > MAX_PLAYERS) {
    names
      .sort((a, b) => (roster[a].lastSeen ?? 0) - (roster[b].lastSeen ?? 0))
      .slice(0, names.length - MAX_PLAYERS)
      .forEach((old) => { delete roster[old]; });
  }

  return writeRoster(roster) ? next : null;
}

/** Forget one character. Their record is gone; there is no undo. */
export function deletePlayer(name) {
  const clean = sanitiseName(name);
  if (!clean) return false;
  const roster = readRoster();
  if (!roster[clean]) return false;
  delete roster[clean];
  return writeRoster(roster);
}

export function readActiveName() {
  try {
    return sanitiseName(window.localStorage.getItem(ACTIVE_KEY));
  } catch {
    return '';
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
