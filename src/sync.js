/**
 * Optional shared roster.
 *
 * ## Why this exists
 *
 * `src/storage.js` keeps every character in localStorage, which is **per
 * browser**. Two people opening the game on two machines never see each other's
 * characters, and clearing a browser wipes them. That is a real limitation and
 * no amount of client code can fix it: GitHub Pages serves static files, so a
 * page has nowhere to write that another visitor can read.
 *
 * This module is that "somewhere", and it is deliberately optional. With no
 * configuration the game behaves exactly as before -- one browser, one roster,
 * no network. With a URL and a key filled in below, the roster becomes shared:
 * every visitor sees every character, and progress follows the player between
 * machines.
 *
 * ## Turning it on
 *
 * 1. Create a free project at supabase.com (no card needed).
 * 2. In the SQL editor, run the schema in `docs/SHARED-ROSTER.md`.
 * 3. Copy the project URL and the **anon** public key from Settings > API.
 * 4. Paste them into `REMOTE` below. Nothing else to change.
 *
 * ## What is stored
 *
 * Only the fields below, and nothing that identifies a person: the name the
 * player typed, their per-map best waves, their Cores, their skill ranks, and
 * the secret weapons they have earned. No email, no IP, no device id.
 *
 * ## Merge policy
 *
 * Both sides are kept and merged field by field, always toward the *better*
 * value: the higher wave, the larger Core balance, the higher skill rank, the
 * union of weapons. A player who progresses offline and then comes back does not
 * lose the progress they made while disconnected, and two machines cannot
 * destroy each other's records by pushing a stale copy.
 */

/**
 * Fill these in to switch sharing on. Both empty = local-only, which is the
 * default and needs no account.
 */
const REMOTE = {
  url: '',
  anonKey: '',
  /** Table name. Change it if you want more than one game in one project. */
  table: 'players',
};

/** How long a request may take before the game gives up and plays on. */
const TIMEOUT_MS = 6000;

/**
 * Whether a shared store has been configured.
 *
 * Every sync call checks this first, so an unconfigured build does no network
 * work at all and cannot fail in a way the player notices.
 */
export function isShared() {
  return Boolean(REMOTE.url && REMOTE.anonKey);
}

/** Where the roster lives, or null when sharing is off. */
function endpoint() {
  if (!isShared()) return null;
  return `${REMOTE.url.replace(/\/+$/, '')}/rest/v1/${REMOTE.table}`;
}

function headers(extra = {}) {
  return {
    apikey: REMOTE.anonKey,
    Authorization: `Bearer ${REMOTE.anonKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * `fetch` with a deadline.
 *
 * A shared store is a nice-to-have; the game must never wait on it. Without
 * this, a flaky connection would leave the name gate spinning forever, which
 * looks exactly like a broken game.
 */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** One remote row -> one local character record. */
function fromRow(row) {
  return {
    name: row.name,
    best: row.best ?? {},
    cores: row.cores ?? 0,
    nodes: row.nodes ?? {},
    weapons: row.weapons ?? [],
    runs: row.runs ?? 0,
    createdAt: row.created_at ?? Date.now(),
    lastSeen: row.last_seen ?? Date.now(),
  };
}

/** One local character record -> one remote row. */
function toRow(record) {
  return {
    name: record.name,
    best: record.best ?? {},
    cores: record.cores ?? 0,
    nodes: record.nodes ?? {},
    weapons: record.weapons ?? [],
    runs: record.runs ?? 0,
    created_at: record.createdAt ?? Date.now(),
    last_seen: record.lastSeen ?? Date.now(),
  };
}

/**
 * Combine two copies of the same character, keeping the better of each field.
 *
 * Written so that either argument may be missing, because a character can exist
 * on only one side: a brand new local player has never been pushed, and a
 * character made on another machine is remote-only.
 */
export function mergePlayer(local, remote) {
  if (!local) return remote ?? null;
  if (!remote) return local;

  const best = { ...(local.best ?? {}) };
  for (const [mapId, wave] of Object.entries(remote.best ?? {})) {
    best[mapId] = Math.max(best[mapId] ?? 0, Number(wave) || 0);
  }

  const nodes = { ...(local.nodes ?? {}) };
  for (const [id, rank] of Object.entries(remote.nodes ?? {})) {
    nodes[id] = Math.max(nodes[id] ?? 0, Number(rank) || 0);
  }

  return {
    name: local.name,
    best,
    // Cores are a balance rather than a total, so the larger of the two is the
    // honest answer: whichever machine has more has seen more play.
    cores: Math.max(local.cores ?? 0, remote.cores ?? 0),
    nodes,
    // Weapons are permanent, so they are unioned and never removed.
    weapons: [...new Set([...(local.weapons ?? []), ...(remote.weapons ?? [])])],
    runs: Math.max(local.runs ?? 0, remote.runs ?? 0),
    createdAt: Math.min(local.createdAt ?? Infinity, remote.createdAt ?? Infinity) || Date.now(),
    lastSeen: Math.max(local.lastSeen ?? 0, remote.lastSeen ?? 0),
  };
}

/**
 * Merge a whole local roster with a whole remote one.
 *
 * @param {Record<string, object>} local
 * @param {object[]} rows
 * @returns {{roster: Record<string, object>, changed: string[]}}
 *   `changed` lists characters whose merged form differs from the local copy,
 *   so the caller knows what still needs pushing.
 */
export function mergeRosters(local, rows) {
  const out = { ...local };
  const changed = [];

  for (const row of rows ?? []) {
    const name = row?.name;
    if (typeof name !== 'string' || !name) continue;
    const localCopy = out[name] ?? null;
    const merged = mergePlayer(localCopy, fromRow(row));
    if (!merged) continue;
    if (!localCopy || JSON.stringify(localCopy) !== JSON.stringify(merged)) {
      out[name] = merged;
      changed.push(name);
    }
  }
  return { roster: out, changed };
}

/**
 * Fetch every shared character.
 *
 * @returns {Promise<object[]|null>} rows, or null when sharing is off or the
 *   request failed. Callers treat null as "no news", never as "empty roster",
 *   so a network blip can never delete anyone.
 */
export async function pullRoster() {
  const url = endpoint();
  if (!url) return null;
  try {
    return await request(`${url}?select=*`);
  } catch {
    return null;
  }
}

/**
 * Create or update one character.
 *
 * Upsert rather than insert-or-update: PostgREST needs `on_conflict` to know
 * which row to replace, and getting that wrong would either duplicate a player
 * or silently fail, so the name is the conflict target and the table's primary
 * key matches.
 *
 * @returns {Promise<boolean>} whether the write landed
 */
export async function pushPlayer(record) {
  const url = endpoint();
  if (!url || !record?.name) return false;
  try {
    await request(`${url}?on_conflict=name`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([toRow(record)]),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push several characters, stopping at the first failure.
 *
 * Sequential rather than parallel on purpose: this runs in the background and a
 * burst of simultaneous writes to the same table is the fastest way to get rate
 * limited on a free tier.
 *
 * @returns {Promise<number>} how many were stored
 */
export async function pushRoster(records) {
  let stored = 0;
  for (const record of records) {
    if (!(await pushPlayer(record))) break;
    stored += 1;
  }
  return stored;
}
