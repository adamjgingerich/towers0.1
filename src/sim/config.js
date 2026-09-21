/**
 * Builds and validates every tunable parameter from the parsed data files.
 *
 * `buildConfig` is pure -- it takes already-parsed objects and never touches
 * the network or the filesystem. Fetching belongs to the loader
 * (src/data-loader.js in the browser, tools/balance_sim.mjs under node), which
 * is exactly what lets one simulation run in both places.
 */

import { DamageMatrix } from './damage.js';
import { buildSkills } from './skills.js';

const VALID_ATTACKS = new Set(['projectile', 'hitscan', 'chain', 'beam']);

export class DataError extends Error {}

const ENEMY_DEFAULTS = {
  heal_per_sec: 0.0,
  heal_radius: 0.0,
  // Shield pool. Zero means "no barrier", which is every type except the
  // bulwark, so the whole mechanic costs nothing on the hot path when unused.
  shield: 0.0,
  shield_regen: 0.0,
  shield_delay: 0.0,
  // `{ key, count, hp_share }` -- spawns children where this enemy dies.
  spawn_on_death: null,
  // Empty means "pick a death effect from the damage type that killed it".
  // Set a key to give an enemy a signature death regardless.
  death_fx: '',
  resist: {},
  cc_resist: 0.0,
  flying: false,
  armor: 0.0,
  armor_class: 'light',
  weight: 0.0,
  skill: 0.0,
  unlock_wave: 1,
};

const TOWER_DEFAULTS = {
  projectile_speed: 0.0,
  projectile_sprite: '',
  splash_radius: 0.0,
  ground_only: false,
  air_only: false,
  chain_count: 1,
  chain_falloff: 1.0,
  chain_range: 2.0,
  slow_factor: 1.0,
  slow_duration: 0.0,
  poison_dps: 0.0,
  poison_duration: 0.0,
  poison_max_stacks: 0,
  bonus_vs: {},
  // Beam weapons: `{ pulse, gap, ramp_per_sec, ramp_max }`. Null for every
  // tower that fires discrete shots.
  beam: null,
  description: '',
};

/** Strip `_comment`-style authoring notes from a data block. */
function withoutComment(mapping) {
  const out = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!key.startsWith('_')) out[key] = value;
  }
  return out;
}

function makeEnemyDef(key, raw) {
  const d = { ...ENEMY_DEFAULTS, ...withoutComment(raw), key };
  return d;
}

function makeTowerDef(key, raw) {
  return { ...TOWER_DEFAULTS, ...withoutComment(raw), key };
}

export class GameConfig {
  constructor({
    enemies,
    towers,
    damage,
    waves,
    atlas,
    specialisations = {},
    terrain = null,
    barracks = null,
    weather = null,
    skills = null,
    mapId = null,
    mapTint = null,
    mapZoom = 1.0,
  }) {
    this.enemies = enemies;
    this.towers = towers;
    this.damage = damage;
    this.waves = waves;
    this.atlas = atlas;
    /** Tower key -> array of tiers. Optional; towers may have none. */
    this.specialisations = specialisations;
    /** Terrain generation params and the ground bands. */
    this.terrain = terrain;
    /** Barracks parameters: capacity, evolution curve, aura and buff schedule. */
    this.barracks = barracks ?? null;
    /** Weather types and their board-wide multipliers. Optional. */
    this.weather = weather ?? null;
    /** Persistent meta-progression tree. Optional; empty when absent. */
    this.skills = skills ?? { currency: 'Cores', branches: [], nodes: [] };
    /** Which map file this config was built for, and its base colour. */
    this.mapId = mapId;
    this.mapTint = mapTint;
    /**
     * Zoom this level was framed for. A level authored to be read up close sets
     * this above 1; the player can still zoom out to the whole board.
     */
    this.mapZoom = Number.isFinite(mapZoom) && mapZoom > 0 ? mapZoom : 1.0;
  }

  /** Tower keys in shop order (hotkey order). */
  towerKeys() {
    // Numeric hotkeys sort in play order with "0" taking the tenth slot, so the
    // shop reads 1..9 then 0 rather than putting 0 first lexicographically.
    const rank = (key) => {
      const hotkey = this.towers[key].hotkey ?? '';
      if (/^[1-9]$/.test(hotkey)) return Number(hotkey);
      if (hotkey === '0') return 10;
      return 99;
    };
    return Object.keys(this.towers).sort((a, b) => {
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return (this.towers[a].hotkey ?? '').localeCompare(this.towers[b].hotkey ?? '');
    });
  }

  /**
   * Towers that start locked and drop from bosses, in unlock order.
   *
   * The order is the shop order filtered to `boss_drop` towers, so a run always
   * receives them in a stable, predictable sequence rather than a random one
   * the player cannot plan around.
   */
  dropTowers() {
    return this.towerKeys().filter((key) => this.towers[key].boss_drop === true);
  }

  /** Composition weight for an enemy type at a given wave. */
  enemyWeight(key, wave) {
    const d = this.enemies[key];
    if (d.weight <= 0 || wave < d.unlock_wave) return 0;
    return d.weight * (1 + d.skill * (wave - d.unlock_wave));
  }

  validate() {
    if (Object.keys(this.enemies).length === 0) throw new DataError('no enemies defined');
    if (Object.keys(this.towers).length === 0) throw new DataError('no towers defined');

    const armorClasses = new Set(Object.values(this.enemies).map((d) => d.armor_class));

    for (const [key, d] of Object.entries(this.enemies)) {
      if (!(d.hp > 0)) throw new DataError(`enemy ${key}: hp must be positive`);
      if (!(d.speed > 0)) throw new DataError(`enemy ${key}: speed must be positive`);
      if (!(d.radius > 0)) throw new DataError(`enemy ${key}: radius must be positive`);
      if (d.leak < 0) throw new DataError(`enemy ${key}: leak cannot be negative`);
      for (const dtype of Object.keys(d.resist)) {
        if (!this.damage.types[dtype]) {
          throw new DataError(`enemy ${key}: resist refers to unknown damage type ${dtype}`);
        }
      }
    }

    for (const [key, d] of Object.entries(this.towers)) {
      if (!VALID_ATTACKS.has(d.attack)) {
        throw new DataError(
          `tower ${key}: attack must be one of ${[...VALID_ATTACKS].sort().join(', ')}`,
        );
      }
      if (d.attack === 'projectile' && !(d.projectile_speed > 0)) {
        throw new DataError(`tower ${key}: projectile attack needs projectile_speed`);
      }
      if (!this.damage.types[d.damage_type]) {
        throw new DataError(`tower ${key}: unknown damage type ${d.damage_type}`);
      }
      if (!(d.cost > 0) || !(d.rate > 0) || !(d.range > 0)) {
        throw new DataError(`tower ${key}: cost, rate and range must be positive`);
      }
      if (d.chain_count < 1) throw new DataError(`tower ${key}: chain_count must be at least 1`);
      if (!(d.chain_falloff > 0) || d.chain_falloff > 1) {
        throw new DataError(`tower ${key}: chain_falloff must be in (0, 1]`);
      }
      if (!(d.slow_factor > 0) || d.slow_factor > 1) {
        throw new DataError(`tower ${key}: slow_factor must be in (0, 1]`);
      }
      for (const armorClass of Object.keys(d.bonus_vs)) {
        if (!armorClasses.has(armorClass)) {
          throw new DataError(
            `tower ${key}: bonus_vs refers to unknown armor class ${armorClass}`,
          );
        }
      }
    }

    // Specialisations are optional per tower, but a malformed one fails
    // silently at runtime -- an unknown flag would simply never fire -- so
    // every reference is checked here instead.
    for (const [key, tiers] of Object.entries(this.specialisations)) {
      if (!this.towers[key]) {
        throw new DataError(`specialisations: unknown tower '${key}'`);
      }
      if (!Array.isArray(tiers)) {
        throw new DataError(`specialisations ${key}: must be a list of tiers`);
      }
      for (const tier of tiers) {
        if (!(Number(tier.tier) >= 1)) {
          throw new DataError(`specialisations ${key}: tier must be at least 1`);
        }
        if (!Array.isArray(tier.options) || tier.options.length === 0) {
          throw new DataError(`specialisations ${key} tier ${tier.tier}: needs options`);
        }
        for (const option of tier.options) {
          if (!option.key || !option.name) {
            throw new DataError(
              `specialisations ${key} tier ${tier.tier}: every option needs a key and a name`,
            );
          }
        }
      }
    }

    // Terrain drives both tower and enemy numbers, so a malformed band would
    // quietly rebalance every map rather than fail visibly.
    if (!this.terrain || !Array.isArray(this.terrain.bands) || this.terrain.bands.length === 0) {
      throw new DataError('terrain: needs at least one band');
    }
    if (this.terrain.bands[0].min > 0) {
      throw new DataError('terrain: the first band must start at 0 so every tile matches one');
    }

    let previousMin = -1;
    for (const band of this.terrain.bands) {
      if (!band.name) throw new DataError('terrain: every band needs a name');
      if (!(band.min >= 0) || band.min > 1) {
        throw new DataError(`terrain band ${band.name}: min must be within 0..1`);
      }
      if (band.min < previousMin) {
        throw new DataError(`terrain band ${band.name}: bands must be listed in ascending order of min`);
      }
      previousMin = band.min;

      const sides = [
        ['tower', ['range', 'damage']],
        ['enemy', ['speed', 'damage_taken']],
      ];
      for (const [side, keys] of sides) {
        for (const key of keys) {
          if (!(band[side][key] > 0)) {
            throw new DataError(`terrain band ${band.name}: ${side}.${key} must be positive`);
          }
        }
      }
    }

    const wave = this.waves;
    if (wave.max_concurrent < 1) throw new DataError('max_concurrent must be at least 1');    if (!(wave.spawn_interval_floor > 0)) {
      throw new DataError('spawn_interval_floor must be positive');
    }
  }
}

/**
 * @param {{enemies:object, towers:object, damage:object, waves:object, atlas:object, map:string}} raw
 */
/**
 * Resolve the difficulty block into plain multipliers.
 *
 * Falls back to a single neutral level rather than throwing, because difficulty
 * is a presentation-layer concern: a malformed block should leave the game
 * playable at Normal, not refuse to boot.
 *
 * Multipliers are clamped to positive finite numbers for the same reason. A NaN
 * here would propagate into every enemy's health and silently make the run
 * unlosable, which is exactly the class of bug that has bitten this project
 * before.
 */
function buildDifficulty(raw) {
  const fallback = {
    default: 0,
    powerRampWaves: 1,
    levels: [{ key: 'normal', name: 'Normal', size: 1, power: 1, growth: 1 }],
  };

  const source = raw && Array.isArray(raw.levels) && raw.levels.length > 0 ? raw : fallback;

  const positive = (value, fallbackValue) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallbackValue;
  };

  const levels = source.levels.map((level, index) => ({
    key: String(level.key ?? `level_${index}`),
    name: String(level.name ?? `Level ${index + 1}`),
    size: positive(level.size, 1),
    power: positive(level.power, 1),
    growth: positive(level.growth, 1),
  }));

  const preferred = Number(source.default);
  const index = Number.isInteger(preferred) && preferred >= 0 && preferred < levels.length
    ? preferred
    : Math.min(levels.length - 1, Math.floor(levels.length / 2));

  const ramp = Number(source.power_ramp_waves);
  const powerRampWaves = Number.isFinite(ramp) && ramp >= 1 ? Math.floor(ramp) : 1;

  return { default: index, powerRampWaves, levels };
}

/**
 * Resolve the barracks block.
 *
 * Returns null when the file is missing rather than throwing, and the world
 * treats "no barracks data" as "no barracks", so a broken data file costs the
 * player a feature instead of the whole game.
 *
 * Buff stats are whitelisted here. An unknown `stat` in the data file would
 * otherwise be silently multiplied into the tower's support bag as a key nothing
 * reads, which looks like a working bonus and does nothing.
 */
const BARRACKS_STATS = new Set(['damage', 'range', 'rate', 'crit_chance', 'bounty']);

/**
 * Normalise a power option's `air` field into a list of usable sorties.
 *
 * An unknown `kind` is dropped rather than passed through: it would spawn
 * aircraft with no stats, which is a silent no-op that looks like a working
 * power-up. `rate` falls back to the kind's base rate rather than 0, because 0
 * would mean "an aircraft that never fires" -- the same silent failure wearing a
 * different hat.
 */
function buildAirSpecs(raw, aircraft) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];

  for (const spec of list) {
    if (!spec || typeof spec !== 'object') continue;
    const kind = String(spec.kind ?? '');
    if (!aircraft[kind]) continue;
    const count = Math.max(0, Math.floor(Number(spec.count) || 0));
    if (count <= 0) continue;
    const rate = Number(spec.rate);
    out.push({
      kind,
      count,
      rate: Number.isFinite(rate) && rate > 0 ? rate : aircraft[kind].rate,
    });
  }

  return out;
}

function buildAircraft(raw) {
  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  /**
   * A non-negative number, where 0 is a real answer.
   *
   * `positive` cannot be used for altitude: a ground vehicle's altitude IS 0,
   * and `Number(0) || 0.3` would silently lift every tank off the ground.
   */
  const atLeastZero = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const out = {};
  for (const [kind, def] of Object.entries(raw ?? {})) {
    if (kind.startsWith('_') || !def || typeof def !== 'object') continue;
    out[kind] = {
      key: kind,
      name: String(def.name ?? kind),
      description: String(def.description ?? ''),
      speed: positive(def.speed, 5),
      damage: positive(def.damage, 10),
      rate: positive(def.rate, 1),
      range: positive(def.range, 6),
      attack_range: positive(def.attack_range, 0.8),
      splash: Math.max(0, Number(def.splash) || 0),
      damage_type: String(def.damage_type ?? 'physical'),
      altitude: atLeastZero(def.altitude, 0.3),
      // Drawn size as a fraction of a tile. A tank is deliberately small on the
      // board -- it is the one unit that shares the lane with the enemies, and a
      // full-tile vehicle would read as terrain rather than as a unit.
      scale: positive(def.scale, 1),
      // Targeting filter. A ground vehicle cannot shoot at a flyer, which is the
      // cost that buys its higher damage.
      ground_only: Boolean(def.ground_only),
      air_only: Boolean(def.air_only),
      // Condition. `hp` of 0 means "indestructible", which is what a build with
      // no condition numbers in its data should get rather than an aircraft that
      // dies the instant it launches.
      hp: Math.max(0, Number(def.hp) || 0),
      attrition: Math.max(0, Number(def.attrition) || 0),
      repair: Math.max(0, Number(def.repair) || 0),
      rebuild: Math.max(0.5, Number(def.rebuild) || 10),
    };
  }
  return out;
}

function buildBarracks(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const levels = {
    max_level: Math.max(1, Math.floor(positive(raw.levels?.max_level, 10))),
    xp_per_damage: positive(raw.levels?.xp_per_damage, 0),
    xp_per_wave: positive(raw.levels?.xp_per_wave, 0),
    xp_to_next_base: positive(raw.levels?.xp_to_next_base, 100),
    xp_to_next_power: positive(raw.levels?.xp_to_next_power, 1.3),
  };

  const aircraft = buildAircraft(raw.aircraft);

  /**
   * The power tree: a set of options at each level.
   *
   * Aura stats are whitelisted here. An unknown `stat` in the data file would
   * otherwise be multiplied into the tower's support bag as a key nothing reads,
   * which looks like a working bonus and does nothing.
   *
   * A level with no usable options is dropped rather than kept empty: the
   * barracks asks the player to choose whenever it reaches a pending level, and
   * an empty level would present a choice that cannot be made.
   */
  const powers = (Array.isArray(raw.powers) ? raw.powers : [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      level: Math.max(1, Math.min(levels.max_level, Math.floor(positive(p.level, 1)))),
      options: (Array.isArray(p.options) ? p.options : [])
        .filter((o) => o && typeof o === 'object' && typeof o.key === 'string')
        .map((o) => {
          const aura = {};
          for (const [stat, value] of Object.entries(o.aura ?? {})) {
            if (!BARRACKS_STATS.has(stat)) continue;
            const n = Number(value);
            if (Number.isFinite(n) && n !== 0) aura[stat] = n;
          }
          return {
            key: String(o.key),
            name: String(o.name ?? o.key),
            description: String(o.description ?? ''),
            aura,
            capacity: Math.max(0, Math.floor(Number(o.capacity) || 0)),
            radius: Math.max(0, Number(o.radius) || 0),
            air: buildAirSpecs(o.air, aircraft),
          };
        }),
    }))
    .filter((p) => p.options.length > 0)
    .sort((a, b) => a.level - b.level);

  /**
   * Named promotions, in ascending order of the level they unlock at.
   *
   * Two ranks at the same level would make "which one am I?" ambiguous, so
   * duplicates are dropped rather than resolved. A file with no ranks at all is
   * not an error -- the barracks still works, it just has nothing to be
   * promoted to, which keeps the structure usable in a trimmed-down data set.
   */
  const ranks = [];
  for (const entry of Array.isArray(raw.ranks) ? raw.ranks : []) {
    if (!entry || typeof entry !== 'object') continue;
    const at = Math.max(1, Math.min(levels.max_level, Math.floor(positive(entry.at, 1))));
    if (ranks.some((existing) => existing.at === at)) continue;
    ranks.push({
      at,
      name: String(entry.name ?? raw.name ?? 'Base'),
      description: String(entry.description ?? ''),
      aura_bonus: Math.max(0, Number(entry.aura_bonus) || 0),
    });
  }
  ranks.sort((a, b) => a.at - b.at);

  // Level 1 has to be *a* rank, or the inspector has nothing to call the
  // structure between levels 1 and the first author's promotion.
  if (ranks.length === 0 || ranks[0].at !== 1) {
    ranks.unshift({
      at: 1,
      name: String(raw.name ?? 'Base'),
      description: '',
      aura_bonus: 0,
    });
  }

  return {
    name: String(raw.name ?? 'Base'),
    description: String(raw.description ?? ''),
    hotkey: String(raw.hotkey ?? 'b'),
    cost: positive(raw.cost, 100),
    cost_growth: positive(raw.cost_growth, 1),
    max_count: Math.max(1, Math.floor(positive(raw.max_count, 4))),
    capacity: {
      base: Math.max(1, Math.floor(positive(raw.capacity?.base, 4))),
      per_barracks: Math.max(0, Math.floor(Number(raw.capacity?.per_barracks) || 0)),
    },
    levels,
    aura: {
      radius: positive(raw.aura?.radius, 3),
      radius_per_level: Number(raw.aura?.radius_per_level) || 0,
    },
    ranks,
    aircraft,
    powers,
  };
}

/**
 * Weather.
 *
 * `alpha` is clamped hard. It multiplies a full-board wash, so a data typo of
 * 1.0 would black the map out and make the game unplayable rather than merely
 * look wrong -- a failure mode worth closing in the parser.
 *
 * A type with no positive weight can never be rolled, which is a silent no-op
 * the caller would not see, so weights are floored at 0 and the picker is left
 * to do the right thing with an empty pool.
 */
function buildWeather(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const types = (Array.isArray(raw.types) ? raw.types : [])
    .filter((t) => t && typeof t === 'object' && typeof t.key === 'string')
    .map((t) => ({
      key: String(t.key),
      name: String(t.name ?? t.key),
      description: String(t.description ?? ''),
      weight: Math.max(0, num(t.weight, 0)),
      tint: String(t.tint ?? '#ffffff'),
      alpha: Math.max(0, Math.min(0.5, num(t.alpha, 0))),
      particles: String(t.particles ?? 'none'),
      effects: {
        tower: {
          damage: num(t.effects?.tower?.damage, 1),
          rate: num(t.effects?.tower?.rate, 1),
          range: num(t.effects?.tower?.range, 1),
        },
        enemy: {
          speed: num(t.effects?.enemy?.speed, 1),
        },
      },
    }));

  if (types.length === 0) return null;

  const min = Math.max(1, Math.floor(num(raw.min_waves, 2)));
  const max = Math.max(1, Math.floor(num(raw.max_waves, 4)));

  return {
    first_wave: Math.max(1, Math.floor(num(raw.first_wave, 3))),
    min_waves: Math.min(min, max),
    max_waves: Math.max(min, max),
    types,
  };
}

export function buildConfig(raw) {
  const damage = new DamageMatrix(
    Number(raw.damage.damage_floor),
    Object.fromEntries(
      Object.entries(raw.damage.types).map(([key, value]) => [
        key,
        {
          label: value.label ?? key,
          armor_mult: Number(value.armor_mult),
          class_mult: { ...(value.class_mult ?? {}) },
          shield_mult: value.shield_mult === undefined ? 1.0 : Number(value.shield_mult),
        },
      ]),
    ),
  );

  const enemies = {};
  for (const [key, value] of Object.entries(raw.enemies)) {
    if (!key.startsWith('_')) enemies[key] = makeEnemyDef(key, value);
  }

  const towers = {};
  for (const [key, value] of Object.entries(raw.towers)) {
    if (!key.startsWith('_')) towers[key] = makeTowerDef(key, value);
  }

  const specialisations = {};
  for (const [key, value] of Object.entries(raw.specialisations ?? {})) {
    if (!key.startsWith('_')) specialisations[key] = value;
  }

  const rawTerrain = raw.terrain ?? {};
  const terrain = {
    resolution: Number(rawTerrain.resolution ?? 7),
    octaves: Number(rawTerrain.octaves ?? 3),
    persistence: Number(rawTerrain.persistence ?? 0.5),
    bands: (rawTerrain.bands ?? []).map((band) => ({
      name: String(band.name ?? 'Ground'),
      min: Number(band.min ?? 0),
      tower: {
        range: Number(band.tower?.range ?? 1),
        damage: Number(band.tower?.damage ?? 1),
      },
      enemy: {
        speed: Number(band.enemy?.speed ?? 1),
        damage_taken: Number(band.enemy?.damage_taken ?? 1),
      },
    })),
  };

  const w = raw.waves;
  const s = w.scaling;
  const l = w.leveling;
  const waves = {
    prep_time: Number(w.prep_time),
    early_call_coins_per_sec: Number(w.early_call_coins_per_sec),
    max_concurrent: Number(w.max_concurrent),
    base_count: Number(w.base_count),
    max_per_wave: Number(w.max_per_wave),
    group_gap: Number(w.group_gap),
    spawn_interval_base: Number(w.spawn_interval_base),
    spawn_interval_floor: Number(w.spawn_interval_floor),
    spawn_interval_per_wave: Number(w.spawn_interval_per_wave),
    group_gap_per_wave: Number(w.group_gap_per_wave),
    group_gap_floor: Number(w.group_gap_floor),

    mix_types_base: Number(w.mix_types_base ?? 1),
    mix_types_per_waves: Number(w.mix_types_per_waves ?? 5),

    mini_boss_every: Number(w.mini_boss.every),
    mini_boss_hp_mult: Number(w.mini_boss.hp_mult),
    mini_boss_bounty_mult: Number(w.mini_boss.bounty_mult),

    boss_every: Number(w.boss.every),
    boss_count_base: Number(w.boss.count_base),
    boss_count_per_50_waves: Number(w.boss.count_per_50_waves),

    scaling: {
      hp_lin: Number(s.hp_lin),
      hp_exp: Number(s.hp_exp),
      count_lin: Number(s.count_lin),
      speed_lin: Number(s.speed_lin),
      speed_cap: Number(s.speed_cap),
      armor_lin: Number(s.armor_lin ?? 0),
      armor_cap: Number(s.armor_cap ?? Infinity),
      // Counterweight to crowd control. Must be listed here as well as in
      // data/waves.json -- this block is an explicit whitelist, so a key that
      // exists in the data but not here is silently dropped and the feature
      // reads as broken rather than as unconfigured.
      cc_resist_lin: Number(s.cc_resist_lin ?? 0),
      cc_resist_cap: Number(s.cc_resist_cap ?? Infinity),
      bounty_lin: Number(s.bounty_lin),
      bounty_exp: Number(s.bounty_exp),
    },

    wave_bonus_base: Number(w.wave_bonus_base),
    wave_bonus_per_wave: Number(w.wave_bonus_per_wave),
    start_coins: Number(w.start_coins),
    base_hp: Number(w.base_hp),
    bonus_tile_coins: Number(w.bonus_tile_coins),
    sell_refund: Number(w.sell_refund),

    /**
     * Selectable difficulty, resolved to plain numbers here so the simulation
     * never has to know about the settings UI.
     */
    difficulty: buildDifficulty(w.difficulty),

    interest: {
      base_rate: Number(w.interest.base_rate),
      rate_per_step: Number(w.interest.rate_per_step),
      step_coins: Number(w.interest.step_coins),
      wave_rate_bonus: Number(w.interest.wave_rate_bonus),
      max_rate: Number(w.interest.max_rate),
    },

    leveling: {
      max_level: Number(l.max_level),
      damage_per_level: Number(l.damage_per_level),
      range_per_level: Number(l.range_per_level),
      rate_per_level: Number(l.rate_per_level),
      xp_per_damage: Number(l.xp_per_damage),
      xp_to_next_base: Number(l.xp_to_next_base),
      xp_to_next_power: Number(l.xp_to_next_power),
      upgrade_cost_factor: Number(l.upgrade_cost_factor),
      upgrade_cost_growth: Number(l.upgrade_cost_growth),
      specialisation_cost_factor: Number(l.specialisation_cost_factor),
      spec_cost_growth: Number(l.spec_cost_growth ?? 1.0),
    },

    /** ASCII map text, carried alongside so a level is one atomic payload. */
    map: raw.map,
  };

  const config = new GameConfig({
    enemies,
    towers,
    damage,
    waves,
    atlas: raw.atlas,
    specialisations,
    terrain,
    barracks: buildBarracks(raw.barracks),
    weather: buildWeather(raw.weather),
    skills: buildSkills(raw.skills),
    mapId: raw.mapId ?? null,
    mapTint: raw.mapTint ?? null,
    mapZoom: raw.mapZoom ?? 1.0,
  });
  config.validate();
  return config;
}
