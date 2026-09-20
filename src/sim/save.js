/**
 * Save games: turning a live World into plain JSON and back.
 *
 * Pure data in, data out -- no DOM and no localStorage, so this runs under a
 * test or the headless balance sweep like the rest of src/sim. The host owns
 * persistence (src/storage.js) and the map.
 *
 * A save deliberately does NOT carry the tile grid. It records the map id and
 * is applied to a world already rebuilt on that map, which keeps saves small
 * and means an edited map file takes effect on the next load instead of the
 * save overriding it.
 */

import { Barracks } from './barracks.js';
import { Enemy } from './enemy.js';
import { Tower } from './tower.js';
import { SpawnOrder } from './wave_manager.js';
import { World } from './world.js';

/** Bump when the shape of a save changes incompatibly. */
export const SAVE_VERSION = 1;

export class SaveError extends Error {}

const TOWER_FIELDS = [
  'xp',
  'mode',
  'angle',
  'invested',
  'damageDealt',
  'kills',
  'levelsGained',
  // Sequential's sweep position. Kept so a loaded run does not restart every
  // sweep from the front of the lane, which would be a visible behaviour change.
  'lastTargetProgress',
];
const ENEMY_FIELDS = [
  'hp',
  'maxHp',
  'speedMult',
  'bounty',
  'leak',
  'shielded',
  'armorBonus',
  // The shield pool is runtime state that refills over time, so a run saved
  // mid-wave must restore it or the barrier silently resets to full on load.
  'shield',
  'shieldMax',
  'shieldHold',
];
const ECONOMY_FIELDS = ['coins', 'baseHp', 'baseHpMax', 'earned', 'spent', 'leaked'];
const STATS_FIELDS = [
  'kills',
  'leaked',
  'damageDealt',
  'towersBuilt',
  'towersSold',
  'enemiesSpawned',
];
const WAVE_FIELDS = ['prepRemaining', 'clock', 'waveElapsed', 'lastBonus'];

/**
 * Coerce to a finite number.
 *
 * Every numeric field goes through this. A single NaN in a loaded save would
 * spread silently -- NaN coins, NaN hp -- and `NaN <= 0` is false, so a run
 * with a NaN base health can never actually be lost.
 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) out[field] = source[field];
  return out;
}

/** @returns {object} a JSON-safe snapshot of the run. */
export function serializeWorld(world, { mapId, testEnabled = false } = {}) {
  const waves = world.waves;

  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    mapId,
    // Recorded so a sandbox run cannot be laundered into a legitimate record by
    // saving it and then loading it with test mode off.
    testMode: Boolean(testEnabled),

    time: world.time,
    speedScale: world.speedScale,
    paused: world.paused,
    gameOver: world.gameOver,
    nextEid: world._nextEid,
    // Boss-drop towers unlocked so far, so a loaded run does not relock a
    // weapon the player has already earned.
    unlockedTowers: [...world.unlockedTowers],
    rngState: world.rng.state,
    waveRngState: waves.rng.state,

    wave: waves.wave,
    waveState: waves.state,
    queueHead: waves.queueHead,
    waveFields: pick(waves, WAVE_FIELDS),
    queue: waves.queue.map((o) => [o.time, o.key, o.hpMult, o.bountyMult, o.speedMult]),

    /**
     * Weather is run state, not scenery: it is currently multiplying every
     * tower and enemy, so loading without it would silently change the numbers
     * mid-wave. The RNG state travels too, or every spell after a load would be
     * re-rolled from wherever the stream happened to be.
     */
    weather: {
      key: world.weather.key,
      wavesLeft: world.weather.wavesLeft,
      rngState: world.weather.state,
    },

    economy: pick(world.economy, ECONOMY_FIELDS),
    stats: pick(world.stats, STATS_FIELDS),
    notes: [...world.notes],

    towers: [...world.towers.values()].map((t) => ({
      key: t.key,
      tx: t.tx,
      ty: t.ty,
      level: t.level,
      ...pick(t, TOWER_FIELDS),
      specs: [...t.specs.entries()].map(([tier, option]) => [tier, option.key]),
    })),

    /**
     * Barracks carry level and xp, so an evolved one has to come back evolved.
     * `invested` is kept because the sell refund is based on it and the price has
     * risen by the time the save is loaded.
     */
    barracks: [...world.barracks.values()].map((b) => ({
      tx: b.tx,
      ty: b.ty,
      level: b.level,
      xp: b.xp,
      invested: b.invested,
      levelsGained: b.levelsGained,
      // Which power was taken at each level. This IS the build -- two barracks
      // with the same level and different powers are different structures.
      powers: { ...b.powers },
      // Supply links to other bases and the wing re-homing they enable. The
      // links are tile keys, so they resolve against the other bases on load.
      links: [...b.links],
      transfersIn: b.transfersIn,
      transfersOut: b.transfersOut,
    })),

    // Only what is needed to rebuild them: position comes back from `dist`
    // along the path, which the map already defines.
    enemies: world.enemies
      .filter((e) => e.alive)
      .map((e) => ({ key: e.key, dist: e.dist, ...pick(e, ENEMY_FIELDS) })),

    /**
     * Aircraft condition, keyed by the barracks that owns them.
     *
     * The wing itself is derived from the barracks powers, so only the wear is
     * saved. Without it a load would silently hand back every aircraft that had
     * been shot down and patch up every one that was damaged -- and since the
     * whole point of the rebuild cycle is that losses cost time, a save would
     * become a way to skip the cost.
     *
     * Order within each list is the order `refreshAircraft()` rebuilds in, which
     * is the barracks' roster order.
     */
    aircraft: Object.fromEntries(
      [...world.barracks.values()].map((b) => [
        World.tileKey(b.tx, b.ty),
        world.aircraft
          .filter((craft) => craft.barracks === b)
          .map((craft) => [craft.hp, craft.rebuildLeft]),
      ]),
    ),
  };
}

/**
 * Check a save against the current data files before touching the world.
 *
 * Runs first so a save referring to a deleted tower or map fails cleanly,
 * instead of half-loading and leaving a run with missing towers.
 */
export function validateSave(data, config) {
  if (!data || typeof data !== 'object') {
    throw new SaveError('save data is missing or unreadable');
  }
  if (data.version !== SAVE_VERSION) {
    throw new SaveError(
      `save is version ${data.version ?? '?'}, this build reads version ${SAVE_VERSION}`,
    );
  }

  for (const tower of data.towers ?? []) {
    if (!config.towers[tower.key]) {
      throw new SaveError(`save contains an unknown tower: '${tower.key}'`);
    }
    for (const [tier, optionKey] of tower.specs ?? []) {
      const tierDef = (config.specialisations[tower.key] ?? []).find((t) => t.tier === tier);
      if (!tierDef) throw new SaveError(`${tower.key}: no specialisation tier ${tier}`);
      if (!tierDef.options.some((o) => o.key === optionKey)) {
        throw new SaveError(`${tower.key}: unknown specialisation '${optionKey}'`);
      }
    }
  }

  for (const enemy of data.enemies ?? []) {
    if (!config.enemies[enemy.key]) {
      throw new SaveError(`save contains an unknown enemy: '${enemy.key}'`);
    }
  }

  if ((data.barracks ?? []).length > 0 && !config.barracks) {
    throw new SaveError('save contains barracks but this build has none');
  }
}

/**
 * Put the saved wear back onto a freshly rebuilt wing.
 *
 * Matched by owning barracks and position in its roster rather than by id: the
 * ids are handed out by `refreshAircraft()` from a running counter, so they are
 * not stable across a load, but the rebuild order is.
 *
 * A missing entry is left alone, so a save written before aircraft carried
 * condition loads a healthy wing rather than a destroyed one.
 */
function restoreAircraftCondition(world, saved) {
  if (!saved || typeof saved !== 'object') return;

  const seen = new Map();
  for (const craft of world.aircraft) {
    const key = World.tileKey(craft.barracks.tx, craft.barracks.ty);
    const list = saved[key];
    if (!Array.isArray(list)) continue;

    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);

    const entry = list[index];
    if (!Array.isArray(entry)) continue;

    craft.hp = Math.max(0, Math.min(craft.maxHp, num(entry[0], craft.maxHp)));
    craft.rebuildLeft = Math.max(0, num(entry[1], 0));
    if (craft.hp <= 0 && craft.maxHp > 0) {
      craft.alive = false;
      craft.lost = true;
      craft.target = null;
      craft.state = 'idle';
    }
  }
}

/**
 * Apply a validated save to a world built on the same map.
 *
 * Deliberately drops in-flight projectiles and active damage-over-time stacks:
 * they last a fraction of a second, and rebuilding them faithfully would mean
 * serialising homing targets and pooled slots for no real gain.
 */
export function applySave(world, config, data) {
  const waves = world.waves;

  world.time = num(data.time);
  world.speedScale = num(data.speedScale, 1);
  world.paused = Boolean(data.paused);
  world.gameOver = Boolean(data.gameOver);
  world._nextEid = num(data.nextEid);
  world.unlockedTowers = new Set(
    Array.isArray(data.unlockedTowers)
      ? data.unlockedTowers.filter((key) => typeof key === 'string' && config.towers[key])
      : [],
  );

  // Restore both streams: the wave generator's picks the composition of every
  // future wave, and combat's drives crits.
  world.rng.state = data.rngState;
  waves.rng.state = data.waveRngState;

  waves.wave = num(data.wave);
  waves.state = data.waveState;
  waves.queueHead = num(data.queueHead);
  for (const field of WAVE_FIELDS) waves[field] = num(data.waveFields?.[field]);
  waves.queue = (data.queue ?? []).map(
    ([time, key, hpMult, bountyMult, speedMult]) =>
      new SpawnOrder(time, key, num(hpMult, 1), num(bountyMult, 1), num(speedMult, 1)),
  );

  for (const field of ECONOMY_FIELDS) world.economy[field] = num(data.economy?.[field]);
  for (const field of STATS_FIELDS) world.stats[field] = num(data.stats?.[field]);
  world.notes = [...(data.notes ?? [])];

  // Restored before the towers, because each tower recalculates from the
  // weather it is standing in.
  if (data.weather) {
    world.weather.set(String(data.weather.key ?? 'clear'), num(data.weather.wavesLeft, 0));
    world.weather.state = num(data.weather.rngState, 0);
  }

  world.towers.clear();
  for (const saved of data.towers ?? []) {
    const def = config.towers[saved.key];
    const tower = new Tower(def, saved.tx, saved.ty, world.leveling, world.meta);
    // Ground before level, so the level scaling lands on top of the right base.
    tower.setTerrain(world.terrain.bandAt(saved.tx, saved.ty), world.leveling);
    tower.setLevel(num(saved.level, 1), world.leveling);

    for (const [tier, optionKey] of saved.specs ?? []) {
      const tierDef = (config.specialisations[saved.key] ?? []).find((t) => t.tier === tier);
      const option = tierDef?.options.find((o) => o.key === optionKey);
      // validateSave already rejected unknown ones; this is belt and braces.
      if (option) tower.chooseSpec(tier, option, world.leveling);
    }

    // Assigned after setLevel, which zeroes xp.
    for (const field of TOWER_FIELDS) {
      if (saved[field] !== undefined) tower[field] = saved[field];
    }

    world.towers.set(World.tileKey(saved.tx, saved.ty), tower);
  }

  world.barracks.clear();
  if (config.barracks) {
    const levels = config.barracks.levels;
    for (const saved of data.barracks ?? []) {
      const barracks = new Barracks(
        config.barracks,
        saved.tx,
        saved.ty,
        num(saved.invested, config.barracks.cost),
      );
      // setLevel clears xp, so restore the level first and the progress after.
      barracks.setLevel(num(saved.level, 1), levels);
      barracks.xp = Math.max(0, num(saved.xp));
      barracks.levelsGained = num(saved.levelsGained);
      // Powers after the level, because `setPowers` keeps only the levels the
      // power table offers and an unknown key is dropped rather than trusted.
      barracks.setPowers(saved.powers);
      // Links and wing re-homing after powers: a transfer only makes sense
      // against the wing the powers define.
      barracks.links = Array.isArray(saved.links)
        ? saved.links.filter((key) => typeof key === 'string')
        : [];
      barracks.transfersIn = saved.transfersIn && typeof saved.transfersIn === 'object'
        ? saved.transfersIn
        : {};
      barracks.transfersOut = saved.transfersOut && typeof saved.transfersOut === 'object'
        ? saved.transfersOut
        : {};
      world.barracks.set(World.tileKey(saved.tx, saved.ty), barracks);
    }
  }

  // Auras depend on both sets of positions, so this has to run after everything
  // is standing rather than at the end of the tower loop.
  world.refreshSupport();
  // Aircraft are derived from the barracks powers just restored, so the wing
  // comes back without being saved -- there is no second copy to lose.
  world.refreshAircraft();
  restoreAircraftCondition(world, data.aircraft);

  for (const projectile of world.projectiles) world.releaseProjectile(projectile);
  world.fx.length = 0;
  world.texts.length = 0;

  world.enemies.length = 0;
  for (const saved of data.enemies ?? []) {
    const def = config.enemies[saved.key];
    const path = def.flying ? world.flyPath : world.groundPath;

    const enemy = new Enemy(world._nextEid, def, path);
    world._nextEid += 1;

    for (const field of ENEMY_FIELDS) {
      if (saved[field] !== undefined) enemy[field] = saved[field];
    }

    enemy.dist = num(saved.dist);
    const [x, y, angle] = path.posAt(enemy.dist);
    enemy.x = x;
    enemy.y = y;
    enemy.angle = angle;
    enemy.progress = enemy.dist / path.length;

    world.enemies.push(enemy);
  }
}

/** Short human summary, for the Load button and confirmations. */
export function describeSave(data) {
  if (!data) return 'no save';
  const waves = num(data.wave);
  const towers = (data.towers ?? []).length;
  const barracks = (data.barracks ?? []).length;
  const suffix = barracks > 0 ? ` · ${barracks} barracks` : '';
  return `wave ${waves} · ${towers} tower${towers === 1 ? '' : 's'}${suffix}`;
}
