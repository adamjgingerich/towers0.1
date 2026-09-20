/**
 * The simulation world: owns every entity and steps them in a fixed order.
 *
 * Step order matters and is deliberate:
 *   1. waves       - may spawn enemies
 *   2. enemies     - move, tick poison, heal, leak
 *   3. towers      - acquire targets and fire
 *   4. projectiles - move and resolve hits
 *   5. effects     - fade
 *   6. cleanup     - drop dead entities
 *
 * This module imports nothing but the sim. No three.js, no DOM. That is what
 * lets tools/balance_sim.mjs step it headlessly under node.
 */

import { Barracks, barracksCost } from './barracks.js';
import { Economy } from './economy.js';
import { Enemy } from './enemy.js';
import { Fx } from './fx.js';
import { Grid } from './grid.js';
import { Aircraft } from './aircraft.js';
import { buildPaths } from './pathfinding.js';
import { WeatherManager } from './weather.js';
import { Projectile } from './projectile.js';
import { Rng } from './rng.js';
import { Terrain } from './terrain.js';
import { TARGETING_MODES, Tower } from './tower.js';
import { OVER, PREP, WaveManager } from './wave_manager.js';

export const PROJECTILE_CAPACITY = 512;
export const MAX_FX = 240;
export const DAMAGE_TEXT_THRESHOLD = 25.0;
export const MAX_NOTES = 6;

/**
 * Floating damage/level numbers get their own, much smaller pool.
 *
 * They used to share `MAX_FX` with the sprite effects, and at high levels every
 * hit clears the damage threshold -- so a few splash towers would fill the
 * buffer with numbers and evict the explosion that caused them. Two pools means
 * neither can starve the other.
 */
export const MAX_TEXTS = 48;

/** Advance a pool of timed effects and compact out the expired ones. */
function tickEffects(effects, dt) {
  if (effects.length === 0) return;
  let write = 0;
  for (let i = 0; i < effects.length; i += 1) {
    const effect = effects[i];
    effect.t += dt;
    if (effect.t < effect.duration) {
      effects[write] = effect;
      write += 1;
    }
  }
  if (write !== effects.length) effects.length = write;
}

/**
 * Death effects by damage type, so a kill reads as *how* it died.
 *
 * Repeats weight the choice: fire almost always burns, poison mostly goos.
 * An enemy's own `death_fx` overrides this pool entirely.
 */
const DEATH_FX = {
  fire: ['burn', 'burn', 'boom'],
  ice: ['shatter', 'shatter', 'pop'],
  energy: ['zap', 'zap', 'boom'],
  poison: ['goo', 'goo', 'pop'],
  physical: ['impact', 'pop', 'boom', 'coins'],
};

/**
 * A neutral aura bag. Multipliers start at 1 and crit chance at 0, so a tower
 * with a bag that nothing has multiplied behaves exactly as one with no bag.
 */
function emptySupport() {
  return { damage: 1.0, range: 1.0, rate: 1.0, bounty: 1.0, crit_chance: 0.0 };
}

export class RunStats {  constructor() {
    this.kills = 0;
    this.leaked = 0;
    this.damageDealt = 0.0;
    this.towersBuilt = 0;
    this.towersSold = 0;
    this.enemiesSpawned = 0;
  }
}

export class World {
  constructor(config, levelText, { seed = 12345, terrain = null, difficulty = null, meta = null } = {}) {
    this.config = config;
    this.leveling = config.waves.leveling;
    /**
     * Resolved skill-tree buffs, or null when the host has none. Read by the
     * economy, tower placement and the wave manager; see src/sim/skills.js.
     */
    this.meta = meta ?? null;

    this.grid = Grid.fromText(levelText);
    const paths = buildPaths(this.grid);
    this.groundPath = paths.ground;
    this.flyPath = paths.flying;

    /**
     * Ground elevation. Handed in when the host already built one, so the board
     * art and the gameplay numbers can never disagree about the terrain.
     */
    this.terrain = terrain ?? new Terrain(this.grid.width, this.grid.height, config.terrain, levelText);

    this.enemies = [];
    /** Keyed by "tx,ty" so a tower can be found from a pointer hit. */
    this.towers = new Map();
    /** Barracks, keyed the same way. They take a tile like anything else. */
    this.barracks = new Map();
    /**
     * Tower keys unlocked this run by boss drops. A boss-drop tower starts
     * locked in the shop and becomes buildable once its boss is felled.
     */
    this.unlockedTowers = new Set();
    /** Instanced sprite effects: explosions, death flourishes, beams, chains. */
    this.fx = [];
    /** DOM floating numbers, kept separate -- see MAX_TEXTS. */
    this.texts = [];

    this.projectiles = [];
    this._freeProjectiles = [];
    for (let slot = PROJECTILE_CAPACITY - 1; slot >= 0; slot -= 1) {
      this.projectiles.push(new Projectile(slot));
      this._freeProjectiles.push(slot);
    }

    /**
     * Aircraft fielded by the barracks, rebuilt whenever a power is taken or a
     * structure is placed or sold -- never persisted directly, because a wing is
     * entirely derived from the powers that justify it.
     */
    this.aircraft = [];
    this._nextAid = 0;

    this.economy = new Economy(
      config.waves.start_coins + (this.meta?.startCoins ?? 0),
      config.waves.base_hp + (this.meta?.baseHp ?? 0),
    );
    this.waves = new WaveManager(config, seed);
    this.waves.setDifficulty(difficulty ?? World.defaultDifficulty(config));
    this.stats = new RunStats();

    /**
     * Sandbox switches. Off by default, so a normal run behaves exactly as it
     * did before. The host replaces this object wholesale rather than mutating
     * it, which is what lets the settings outlive a restart -- see
     * Game.newWorld.
     */
    this.test = { enabled: false, level: 1 };

    /**
     * Combat rolls (crits), on a separate stream from the wave generator's.
     * Sharing one stream would let crit luck shift wave composition, which
     * would make the balance sweep irreproducible between runs.
     */
    this.rng = new Rng(seed ^ 0x5bf03635);

    /**
     * Weather, on a third stream.
     *
     * Seeded apart from the crit and wave streams for exactly the reason those
     * two are apart from each other: a weather roll must not be able to shift
     * wave composition, or a balance sweep would quietly be measuring the
     * weather generator instead of the curve.
     */
    this.weather = new WeatherManager(config.weather, seed ^ 0x2f1b7c9d);

    this.time = 0.0;
    /**
     * Selected game speed, 1..5.
     *
     * Read by the *loop*, not by update() -- the loop takes this many 1/60 s
     * steps per unit of real time so that every speed runs the same simulation.
     * Kept on the world because it is run state: it is saved and restored with
     * a run, and the HUD reads it to highlight the active button.
     */
    this.speedScale = 1.0;
    this.paused = false;
    this.gameOver = false;
    this.waveStartedAt = 0.0;
    this.notes = [];
    this._nextEid = 0;
  }

  // ---------------------------------------------------------------- helpers

  get prepared() {
    return this.waves.state === PREP;
  }

  get wave() {
    return this.waves.wave;
  }

  get waveState() {
    return this.waves.state;
  }

  /**
   * The difficulty a world runs at when the host does not choose one.
   *
   * The ramp value lives on the difficulty block rather than on each level, so it
   * has to be merged in -- passing the level object alone would silently drop it
   * back to no ramp.
   */
  static defaultDifficulty(config) {
    const block = config.waves.difficulty;
    const level = block?.levels?.[block.default];
    return level ? { ...level, powerRampWaves: block.powerRampWaves } : null;
  }

  /**
   * Change difficulty on a live run.
   *
   * Takes effect from the next wave: the current wave's composition, health
   * multipliers and count were already generated. That is the honest behaviour
   * -- retroactively rescaling enemies that are already on the board would let a
   * player ride the slider up and down mid-wave.
   */
  setDifficulty(mult) {
    this.waves.setDifficulty(mult);
  }

  note(message) {
    this.notes.push(message);
    if (this.notes.length > MAX_NOTES) {
      this.notes.splice(0, this.notes.length - MAX_NOTES);
    }
  }

  addFx(effect) {
    if (this.fx.length >= MAX_FX) this.fx.shift();
    this.fx.push(effect);
  }

  /** Floating number for the DOM layer, on its own budget. */
  addText(effect) {
    if (this.texts.length >= MAX_TEXTS) this.texts.shift();
    this.texts.push(effect);
  }

  onWaveStart(wave) {
    this.waveStartedAt = this.time;
    this.note(`Wave ${wave} incoming`);
    const [bx, by] = Grid.tileCenter(this.grid.base[0], this.grid.base[1]);
    this.addFx(Fx.sprite('spawn', bx, by, 0.5));

    // Rolled before the first spawn, so a wave is fought in the conditions it
    // arrived in rather than having them change underneath it.
    if (this.weather.onWave(wave)) {
      this.applyWeather();
      // The badge carries the numbers; the feed only has to say it happened.
      if (!this.weather.isCalm) this.note(`Weather: ${this.weather.name}`);
    }
  }

  /**
   * Push the current weather onto every tower.
   *
   * Called when a spell changes and whenever a tower is built, so a tower added
   * mid-storm is not quietly fighting under clear skies.
   */
  applyWeather() {
    const effects = this.weather.tower;
    for (const tower of this.towers.values()) tower.setWeather(effects, this.leveling);
  }

  onWaveComplete(wave, bonus, bonusTiles, interest = 0.0) {
    const suffix = bonusTiles > 0 ? ` (+${bonusTiles} bonus tiles)` : '';
    this.note(`Wave ${wave} cleared: +${bonus.toFixed(0)} coins${suffix}`);
    // Interest is called out on its own line because it is the one part of the
    // payout the player directly controls -- it is the feedback that makes
    // saving a deliberate choice rather than a forgotten pile of coins.
    if (interest > 0.0) {
      const pct = (this.waves.lastInterestRate * 100).toFixed(1);
      this.note(`Savings interest: +${interest} coins (${pct}%)`);
    }
    this._creditBarracksWave();
  }

  // --------------------------------------------------------------- spawning

  spawnEnemy(key, hpMult = 1.0, bountyMult = 1.0, speedMult = 1.0) {
    const d = this.config.enemies[key];
    const path = d.flying ? this.flyPath : this.groundPath;
    const enemy = new Enemy(this._nextEid, d, path, {
      hpMult,
      speedMult,
      bountyMult,
      // Resolved once, here, rather than per hit: the wave an enemy was born on
      // is fixed, and this sits on the damage hot path.
      armorBonus: this.waves.armorBonus(this.wave),
    });
    this._nextEid += 1;
    this.enemies.push(enemy);
    this.stats.enemiesSpawned += 1;
    this.addFx(Fx.sprite('spawn', enemy.x, enemy.y, 0.3, 0.5));
    return enemy;
  }

  // ------------------------------------------------------------ damage flow

  applyDamage(owner, enemy, raw, dtype, { showFx = true } = {}) {
    if (!enemy.alive || raw <= 0.0) return 0.0;

    // Armour is read off the enemy so corrosion applies, and forced to zero
    // outright for a tower that punches straight through it.
    const bypassArmor = owner !== null && owner.trueDamage;
    // Ground the target is standing on: valleys leave it exposed, peaks give it
    // cover. Applied before armour so it stacks with the damage-type bonuses.
    const cover = enemy.terrainDamageTaken ?? 1.0;
    let amount = this.config.damage.resolve(raw * cover, dtype, {
      armor: bypassArmor ? 0.0 : enemy.effectiveArmor,
      resist: enemy.d.resist,
      armorClass: enemy.d.armor_class,
      shielded: enemy.shielded,
    });

    // Execute: finish a weakened enemy regardless of how big this hit was.
    if (
      owner !== null &&
      owner.executeBelow > 0.0 &&
      enemy.hp <= enemy.maxHp * owner.executeBelow
    ) {
      amount = Math.max(amount, enemy.hp);
    }

    const dealt = enemy.takeDamage(amount);
    if (dealt <= 0.0) return 0.0;

    this.stats.damageDealt += dealt;

    if (owner !== null) {
      owner.damageDealt += dealt;
      const gained = owner.addXp(dealt * this.leveling.xp_per_damage, this.leveling);
      if (gained) {
        this.addText(Fx.text(owner.x, owner.y - 0.5, `Lv${owner.level}`, '#ffe066', 0.9));
        this._noteSpecTier(owner);
      }

      // Barracks learn from the fighting their towers do. Crediting the sources
      // directly rather than searching the aura list keeps this off the hot path:
      // it runs for every damage tick in the game.
      for (let i = 0; i < owner.supportSources.length; i += 1) {
        this._creditBarracks(owner.supportSources[i], dealt);
      }
    }

    if (showFx && dealt >= DAMAGE_TEXT_THRESHOLD) {
      this.addText(Fx.text(enemy.x, enemy.y - 0.3, dealt.toFixed(0), '#ffffff', 0.5));
    }

    if (!enemy.alive) this._onKill(owner, enemy, dtype);
    return dealt;
  }

  /**
   * Award a barracks experience, and announce anything it gained.
   *
   * Shared by the damage path (the main source) and the per-wave trickle, so a
   * promotion is never silent just because it arrived with the wave bonus rather
   * than mid-fight.
   *
   * @returns {boolean} whether it evolved
   */
  _evolveBarracks(barracks, xp) {
    const cfg = this.config.barracks;
    if (!cfg || !barracks || !barracks.alive) return false;

    const rankBefore = barracks.rankIndex;
    if (barracks.addXp(xp, cfg.levels) <= 0) return false;

    // A promotion is the louder event: it changes the building on the board, so
    // it gets its own name and colour rather than being folded into the
    // level-up line.
    const promoted = barracks.rankIndex > rankBefore;
    this.addText(
      Fx.text(
        barracks.x,
        barracks.y - 0.6,
        promoted ? barracks.rankName : `Base Lv${barracks.level}`,
        promoted ? '#ffe9a3' : '#9ee6a0',
        promoted ? 1.6 : 1.0,
      ),
    );

    if (promoted) {
      this.note(`${cfg.name} promoted — ${barracks.rankName} (Lv${barracks.level})`);
    }

    this.refreshSupport();
    return true;
  }

  /**
   * Give a barracks experience, and rebuild the auras if it evolved.
   *
   * The refresh is what makes evolution feel like something: a barracks crossing
   * a level can newly reach a tower just outside its old radius, or start
   * granting a stat it did not have before.
   */
  _creditBarracks(barracks, damage) {
    const cfg = this.config.barracks;
    if (!cfg) return;
    this._evolveBarracks(barracks, damage * cfg.levels.xp_per_damage);
  }

  /** Every barracks gets a trickle each cleared wave, so none can stall out. */
  _creditBarracksWave() {
    const cfg = this.config.barracks;
    if (!cfg) return;
    for (const barracks of this.barracks.values()) {
      this._evolveBarracks(barracks, cfg.levels.xp_per_wave);
    }
  }

  _onKill(owner, enemy, dtype = 'physical') {    this.stats.kills += 1;
    if (owner !== null) owner.kills += 1;
    const mult = owner !== null ? owner.bountyMult : 1.0;
    this.economy.earn(enemy.bounty * mult);
    this._deathEffect(enemy, dtype);
    this._splitOnDeath(enemy);

    // A felled boss drops the next locked tower type for the rest of the run.
    if (enemy.key === 'boss') this.unlockNextDrop();
  }

  /**
   * Unlock the next boss-drop tower, and say so.
   *
   * @returns {string|null} the tower key unlocked, or null when none remain
   */
  unlockNextDrop() {
    for (const key of this.config.dropTowers()) {
      if (this.unlockedTowers.has(key)) continue;
      this.unlockedTowers.add(key);
      const def = this.config.towers[key];
      this.note(`${def.name} unlocked — dropped by the boss`);
      this.addText(Fx.text(this.grid.base[0] + 1, this.grid.base[1] + 1, `${def.name}!`, '#ffd166', 2.0));
      return key;
    }
    return null;
  }

  /**
   * Break a splitter into its children where it died.
   *
   * Spawned at the parent's position, not at the spawner: a split that sent its
   * children back to the start would reward killing it. Children carry a share
   * of the parent's *scaled* health, so the split adds real health to the wave
   * rather than recycling what was already paid for.
   *
   * Appending to `this.enemies` here is safe: the step loop re-reads `.length`
   * every iteration, and dead entries are only filtered in `_cleanup`, which
   * runs at the very end of the step.
   */
  _splitOnDeath(enemy) {
    const split = enemy.d.spawn_on_death;
    if (!split || !split.key) return;
    // A type that splits into itself would spawn without bound, so a data
    // mistake is refused rather than trusted.
    if (split.key === enemy.key) return;
    if (!this.config.enemies[split.key]) return;

    const count = Math.max(0, Math.floor(split.count ?? 2));
    const share = Math.max(0.05, Math.min(1, split.hp_share ?? 0.3));

    for (let i = 0; i < count; i += 1) {
      const child = this.spawnEnemy(split.key, 1, 1, enemy.speedMult);
      // Fanned out along the lane, so the children do not stack on one pixel.
      child.dist = Math.max(0, enemy.dist - i * 0.34);
      const [cx, cy, ca] = child.path.posAt(child.dist);
      child.x = cx;
      child.y = cy;
      child.angle = ca;
      child.maxHp = enemy.maxHp * share;
      child.hp = child.maxHp;
    }
  }

  /**
   * Spawn a death flourish for a kill.
   *
   * The variant comes from the damage type plus a per-enemy override, so the
   * same enemy dies differently depending on what killed it. It is picked from
   * `eid` rather than the RNG on purpose -- rolling here would consume the
   * combat stream and shift every later crit, breaking save reproducibility.
   *
   * Everything is kept small and brief: during a big wave dozens of these
   * overlap, so the renderer draws them under the units and towers.
   */
  _deathEffect(enemy, dtype) {
    const pool = DEATH_FX[dtype] ?? DEATH_FX.physical;
    const key = enemy.d.death_fx || pool[enemy.eid % pool.length];
    // Roughly half a tile for a normal enemy: clearly readable without ever
    // covering the lane the way a full-tile burst would.
    const scale = 0.34 + enemy.d.radius * 0.7;

    this.addFx(Fx.sprite(key, enemy.x, enemy.y, 0.32, scale));
  }

  onLeak(enemy) {
    this.economy.takeLeak(enemy.leak);
    this.stats.leaked += 1;

    const [bx, by] = Grid.tileCenter(this.grid.base[0], this.grid.base[1]);
    this.addFx(Fx.sprite('leak', bx, by, 0.5));
    this.addText(Fx.text(bx, by - 0.6, `-${enemy.leak}`, '#ff6b6b', 0.8));

    if (this.economy.defeated) {
      this.gameOver = true;
      this.waves.forceOver();
      this.note(`Base destroyed on wave ${this.wave}`);
    }
  }

  // -------------------------------------------------------------- attacking

  spawnProjectile(tower, target) {
    if (this._freeProjectiles.length === 0) return null;
    const slot = this._freeProjectiles.pop();
    const projectile = this.projectiles[slot];
    projectile.slot = slot;
    projectile.launch(tower, target, this.rng);
    return projectile;
  }

  releaseProjectile(projectile) {
    if (!projectile.alive) return;
    projectile.alive = false;
    projectile.target = null;
    projectile.owner = null;
    projectile.hitIds.clear();
    this._freeProjectiles.push(projectile.slot);
  }

  onProjectileHit(projectile, enemy) {
    const owner = projectile.owner;

    if (projectile.splash > 0.0) {
      this.detonate(projectile, enemy.x, enemy.y);
    } else {
      this.applyDamage(owner, enemy, projectile.damage, projectile.damageType);
      this.addFx(Fx.sprite('impact', enemy.x, enemy.y, 0.18, 0.5));
    }

    if (enemy.alive) this._applyRiders(projectile, enemy, owner);

    projectile.hitIds.add(enemy.eid);

    // A penetrating round carries on through. Splash rounds never pierce --
    // they have already spent themselves on the blast.
    if (projectile.pierce > 0 && projectile.splash <= 0.0) {
      projectile.pierce -= 1;
      projectile.target = null;
      return;
    }

    this.releaseProjectile(projectile);
  }

  /**
   * Rider effects a hit leaves behind: slow, poison, burn and corrosion.
   *
   * `source` is whatever carried the hit (projectile or tower); `owner` is the
   * tower credited with any damage the effect later deals.
   */
  _applyRiders(source, enemy, owner) {
    if (source.slowDuration > 0.0) {
      enemy.applySlow(source.slowFactor, source.slowDuration);
    }
    if (source.poisonDps > 0.0) {
      enemy.applyDot(source.poisonDps, source.poisonDuration, source.poisonStacks, owner, 'poison');
    }
    if (source.burnDps > 0.0) {
      enemy.applyDot(source.burnDps, source.burnDuration, source.burnStacks, owner, 'fire');
    }
    if (source.armorShred > 0.0) {
      enemy.applyShred(source.armorShred, source.armorShredDuration);
    }
  }

  detonate(projectile, x, y) {
    const radius = projectile.splash;
    const owner = projectile.owner;

    this.applyBlast(owner, x, y, radius, projectile.damage, projectile.damageType);
    if (radius <= 0.0) return;

    // Riders go on in a second pass. They only ever touch the enemy they are
    // applied to, so applying them to every survivor after the blast lands is
    // the same thing as applying them enemy-by-enemy.
    const radiusSq = radius * radius;
    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;
      const dx = enemy.x - x;
      const dy = enemy.y - y;
      if (dx * dx + dy * dy > radiusSq) continue;
      this._applyRiders(projectile, enemy, owner);
    }
  }

  /**
   * Damage everything within `radius` of a point.
   *
   * Shared by projectile detonations and aircraft ordnance. The falloff rule is
   * a balance decision, and two copies of it would eventually disagree -- so a
   * bomber would quietly hit differently from a mortar with the same numbers.
   */
  applyBlast(owner, x, y, radius, damage, damageType) {
    this.addFx(Fx.sprite('splash', x, y, 0.3));
    if (radius <= 0.0) return;

    const radiusSq = radius * radius;
    const enemies = this.enemies;

    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;

      const dx = enemy.x - x;
      const dy = enemy.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq) continue;

      // Linear falloff to 50% damage at the edge of the blast.
      const falloff = 1.0 - 0.5 * (Math.sqrt(distSq) / radius);
      this.applyDamage(owner, enemy, damage * falloff, damageType);
    }
  }

  fireHitscan(tower, target) {
    const raw = tower.rawDamageAgainst(target, this.rng);
    this.applyDamage(tower, target, raw, tower.d.damage_type);
    this.addFx(Fx.beam(tower.x, tower.y, target.x, target.y, '#ffe9a8', 0.07));
    if (target.alive) this._applyRiders(tower, target, tower);
  }

  fireChain(tower, target) {
    const d = tower.d;
    const points = [[tower.x, tower.y]];
    const seen = new Set();
    let current = target;

    for (let hop = 0; hop < tower.chainCount; hop += 1) {
      if (current === null) break;
      seen.add(current.eid);

      const raw = tower.rawDamageAgainst(current, this.rng) * tower.chainFalloff ** hop;
      this.applyDamage(tower, current, raw, d.damage_type, { showFx: false });
      if (current.alive) this._applyRiders(tower, current, tower);
      points.push([current.x, current.y]);

      current = this.nearestEnemy(current.x, current.y, tower.chainRange, seen, tower);
    }

    if (points.length > 1) this.addFx(Fx.chain(points, '#9fe6ff', 0.13));
  }

  nearestEnemy(x, y, radius, excludeIds = null, tower = null) {
    let best = null;
    let bestDistSq = radius * radius;
    const enemies = this.enemies;

    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;
      if (excludeIds !== null && excludeIds.has(enemy.eid)) continue;
      if (tower !== null && !tower.canTarget(enemy)) continue;

      const dx = enemy.x - x;
      const dy = enemy.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestDistSq) {
        best = enemy;
        bestDistSq = distSq;
      }
    }
    return best;
  }

  // ---------------------------------------------------------- tower actions

  static tileKey(tx, ty) {
    return `${tx},${ty}`;
  }

  /**
   * How many towers this run may field: a base, plus a bonus per barracks.
   *
   * This is the point of the barracks. Without one a run is capped at a handful
   * of towers, so the first barracks is the first real decision, and every later
   * one is what lets the build keep growing.
   */
  towerCapacity() {
    const cfg = this.config.barracks;
    if (!cfg) return Infinity;
    // Powers that buy capacity are added per barracks rather than as a global
    // bonus, so where the towers can go is the same question as how many.
    let capacity = cfg.capacity.base + cfg.capacity.per_barracks * this.barracks.size;
    for (const barracks of this.barracks.values()) capacity += barracks.capacityBonus();
    return capacity + (this.meta?.towerCap ?? 0);
  }

  /** The sell refund rate, including any Salvage skill ranks. */
  sellRefundRate() {
    return Math.min(
      0.95,
      this.config.waves.sell_refund + (this.meta?.sellRefund ?? 0),
    );
  }

  /**
   * Take a power for a barracks, and rebuild everything it changes.
   *
   * A power can touch the aura, the tower limit, the aura radius or the air
   * wing, and all four are derived state -- so they are all rebuilt here rather
   * than at each call site.
   *
   * @returns {[boolean, string]} ok, and the option taken for the message
   */
  chooseBarracksPower(barracks, key) {
    if (!barracks || !barracks.alive) return [false, 'No base selected'];
    const option = barracks.choosePower(key);
    if (option === null) return [false, 'That power is not on offer'];

    this.refreshSupport();
    this.refreshAircraft();
    return [true, option.name];
  }

  /**
   * Make the aircraft on the board match what the barracks have bought.
   *
   * Rebuilt from scratch rather than diffed. A wing is a handful of entities and
   * this runs on a purchase or a sale, not per frame -- and rebuilding makes it
   * impossible for the roster to drift out of step with the powers that justify
   * it, which a diff would have to be carefully written not to do.
   */
  refreshAircraft() {
    const cfg = this.config.barracks;
    const known = cfg?.aircraft ?? null;
    if (!known) {
      this.aircraft.length = 0;
      return;
    }

    const next = [];
    for (const barracks of this.barracks.values()) {
      if (!barracks.alive) continue;
      for (const spec of barracks.fieldedRoster()) {
        const d = known[spec.kind];
        if (!d) continue;
        for (let i = 0; i < spec.count; i += 1) {
          next.push(new Aircraft(this._nextAid + next.length, spec.kind, d, barracks, spec.rate));
        }
      }
    }

    this._nextAid += next.length;
    this.aircraft = next;
  }

  /**
   * Connect two bases with a supply pathway. A wing can only move along a
   * pathway, so linking is the permission slip that makes a transfer possible.
   *
   * @returns {[boolean, string]}
   */
  linkBases(a, b) {
    if (!a || !b || !a.alive || !b.alive) return [false, 'Both bases must be standing'];
    if (a === b) return [false, 'A base cannot link to itself'];
    const added = a.linkTo(b) || b.linkTo(a);
    if (!added) return [false, 'Already linked'];
    this.note(`${a.rankName} (${a.tx},${a.ty}) ↔ ${b.rankName} (${b.tx},${b.ty}) linked`);
    return [true, ''];
  }

  /**
   * Re-home every aircraft of one kind from a base to a linked base.
   *
   * The move is recorded on both bases rather than on the aircraft, so it
   * survives the next wing rebuild. Selling the *sending* base leaves the
   * aircraft where they were sent; selling the *receiving* base loses them,
   * because they were stationed there when it went.
   *
   * @returns {number} aircraft moved
   */
  transferAircraft(source, target, kind) {
    if (!source || !target || !source.alive || !target.alive) return 0;
    if (!source.isLinkedTo(target)) return 0;

    const spec = source.airRoster().find((s) => s.kind === kind);
    if (!spec) return 0;
    const sent = Object.values(source.transfersOut[kind] ?? {})
      .reduce((sum, n) => sum + (n ?? 0), 0);
    const available = spec.count - sent;
    if (available <= 0) return 0;

    const destKey = `${target.tx},${target.ty}`;
    if (!source.transfersOut[kind]) source.transfersOut[kind] = {};
    source.transfersOut[kind][destKey] = (source.transfersOut[kind][destKey] ?? 0) + available;

    if (!target.transfersIn[kind]) target.transfersIn[kind] = { count: 0, rate: spec.rate };
    target.transfersIn[kind].count += available;
    target.transfersIn[kind].rate = Math.max(target.transfersIn[kind].rate, spec.rate);

    this.refreshAircraft();
    const label = this.config.barracks.aircraft?.[kind]?.name ?? kind;
    this.note(`${available} × ${label} moved to ${target.rankName} (${target.tx},${target.ty})`);
    return available;
  }

  /**
   * Price of the next barracks, or null when the limit is reached.
   *
   * Rises per barracks so the fifth is a commitment rather than a formality.
   */
  nextBarracksCost() {
    const cfg = this.config.barracks;
    if (!cfg) return null;
    if (this.barracks.size >= cfg.max_count) return null;
    return barracksCost(cfg, this.barracks.size);
  }

  towerAt(tx, ty) {
    return this.towers.get(World.tileKey(tx, ty)) ?? null;
  }

  barracksAt(tx, ty) {
    return this.barracks.get(World.tileKey(tx, ty)) ?? null;
  }

  /** Whatever is standing on a tile, tower or barracks. */
  structureAt(tx, ty) {
    const key = World.tileKey(tx, ty);
    return this.towers.get(key) ?? this.barracks.get(key) ?? null;
  }

  /**
   * Recompute which towers each barracks covers, and what that adds up to.
   *
   * Event-driven rather than per frame: the aura picture only changes when
   * something is built, sold, or evolves. A tower inside two auras gets both,
   * with each stat clamped to its cap so overlapping barracks cannot run away.
   */
  refreshSupport() {
    // Weather rides along with the aura refresh. Both are board-wide tower
    // modifiers, and every place that needs one rebuilt needs the other -- so
    // doing it here means a new tower can never miss the current spell.
    this.applyWeather();

    const cfg = this.config.barracks;
    if (!cfg) return;

    for (const tower of this.towers.values()) {
      tower.support = null;
      tower.supportSources.length = 0;
    }
    for (const barracks of this.barracks.values()) barracks.supported.length = 0;

    for (const barracks of this.barracks.values()) {
      const r2 = barracks.radius * barracks.radius;
      const bonuses = barracks.bonuses();

      for (const tower of this.towers.values()) {
        const dx = tower.x - barracks.x;
        const dy = tower.y - barracks.y;
        if (dx * dx + dy * dy > r2) continue;

        barracks.supported.push(tower);
        const bag = tower.support ?? (tower.support = emptySupport());
        bag.damage *= bonuses.damage;
        bag.range *= bonuses.range;
        bag.rate *= bonuses.rate;
        bag.bounty *= bonuses.bounty;
        bag.crit_chance += bonuses.crit_chance;
        tower.supportSources.push(barracks);
      }
    }

    for (const tower of this.towers.values()) tower.setSupport(tower.support, tower.supportSources, this.leveling);
  }

  canPlace(key, tx, ty) {
    const d = this.config.towers[key];
    if (d === undefined) return [false, 'Unknown tower'];
    if (!this.grid.inBounds(tx, ty)) return [false, 'Outside the map'];
    if (this.structureAt(tx, ty)) return [false, 'Tile already occupied'];
    if (!this.grid.isBuildable(tx, ty)) return [false, 'Cannot build on that tile'];
    if (!this.test.enabled && this.towers.size >= this.towerCapacity()) {
      return [false, `Tower limit ${this.towerCapacity()} — build a base`];
    }
    if (!this.test.enabled && !this.economy.canAfford(d.cost)) {
      return [false, 'Not enough coins'];
    }
    return [true, ''];
  }

  /**
   * Build a tower. `level` is only honoured in test mode; a normal run always
   * starts every tower at level 1 and makes you earn the rest.
   */
  placeTower(key, tx, ty, level = 1) {
    const [ok, reason] = this.canPlace(key, tx, ty);
    if (!ok) return [false, reason];

    const d = this.config.towers[key];
    if (!this.test.enabled) this.economy.spend(d.cost);

    const tower = new Tower(d, tx, ty, this.leveling, this.meta);
    tower.setTerrain(this.terrain.bandAt(tx, ty), this.leveling);
    if (this.test.enabled) tower.setLevel(level, this.leveling);
    else if ((this.meta?.startLevel ?? 0) > 0) {
      tower.setLevel(1 + Math.floor(this.meta.startLevel), this.leveling);
    }

    this.towers.set(World.tileKey(tx, ty), tower);
    this.stats.towersBuilt += 1;
    this.addFx(Fx.sprite('spawn', tower.x, tower.y, 0.3, 0.6));
    this.refreshSupport();
    return [true, ''];
  }

  /** Can a barracks go here? Separate from `canPlace` because the reasons differ. */
  canPlaceBarracks(tx, ty) {
    const cfg = this.config.barracks;
    if (!cfg) return [false, 'No base in this build'];
    if (!this.grid.inBounds(tx, ty)) return [false, 'Outside the map'];
    if (this.structureAt(tx, ty)) return [false, 'Tile already occupied'];
    if (!this.grid.isBuildable(tx, ty)) return [false, 'Cannot build on that tile'];
    if (this.barracks.size >= cfg.max_count) {
      return [false, `Base limit ${cfg.max_count} reached`];
    }
    const cost = this.nextBarracksCost();
    if (!this.test.enabled && !this.economy.canAfford(cost)) {
      return [false, `Needs ${cost.toFixed(0)} coins`];
    }
    return [true, ''];
  }

  /**
   * Build a barracks, raising the tower limit and starting an aura.
   *
   * @returns {[boolean, string]} ok, and why not
   */
  placeBarracks(tx, ty, level = 1) {
    const [ok, reason] = this.canPlaceBarracks(tx, ty);
    if (!ok) return [false, reason];

    const cfg = this.config.barracks;
    const cost = this.nextBarracksCost();
    if (!this.test.enabled) this.economy.spend(cost);

    const barracks = new Barracks(cfg, tx, ty, cost);
    if (this.test.enabled) barracks.setLevel(level, cfg.levels);

    this.barracks.set(World.tileKey(tx, ty), barracks);
    this.addFx(Fx.sprite('spawn', barracks.x, barracks.y, 0.4, 0.8));
    this.refreshSupport();
    this.refreshAircraft();
    this.note(`Base raised — tower limit ${this.towerCapacity()}`);
    return [true, ''];
  }

  sellBarracks(barracks) {
    if (!barracks || !barracks.alive) return 0.0;
    const refund = barracks.sellValue(this.sellRefundRate());
    barracks.alive = false;
    this.barracks.delete(World.tileKey(barracks.tx, barracks.ty));
    this.economy.refund(refund);
    this.addText(Fx.text(barracks.x, barracks.y - 0.4, `+${refund.toFixed(0)}`, '#ffd166', 0.8));
    this.refreshSupport();

    // Its pathways and borrowed wings go with it. Every other base drops the
    // link to the sold tile, and any aircraft it had lent to the sold base
    // return to their sender, because the base they were stationed at is gone.
    const soldKey = World.tileKey(barracks.tx, barracks.ty);
    for (const other of this.barracks.values()) {
      other.links = other.links.filter((key) => key !== soldKey);
      for (const kind of Object.keys(other.transfersOut)) {
        const byDest = other.transfersOut[kind];
        if (byDest && soldKey in byDest) delete byDest[soldKey];
      }
    }

    // Its wing goes with it. Aircraft belong to a structure, so selling the
    // structure has to take them off the board or they would keep fighting for
    // a base that no longer exists.
    this.refreshAircraft();
    this.note(`Base sold — tower limit ${this.towerCapacity()}`);
    return refund;
  }

  upgradeTower(tower) {
    const cost = tower.upgradeCost(this.leveling);
    if (cost === null) return [false, 'Already at maximum level'];

    if (!this.test.enabled) {
      if (!this.economy.canAfford(cost)) return [false, `Needs ${cost.toFixed(0)} coins`];
      this.economy.spend(cost);
      tower.invested += cost;
    }

    tower.buyLevel(this.leveling);
    this.addText(Fx.text(tower.x, tower.y - 0.5, `Lv${tower.level}`, '#ffe066', 0.9));
    this._noteSpecTier(tower);
    return [true, ''];
  }

  /** Test mode: force a built tower to an arbitrary level. */
  setTowerLevel(tower, level) {
    if (!tower || !tower.alive) return [false, 'No tower selected'];
    const applied = tower.setLevel(level, this.leveling);
    this.addText(Fx.text(tower.x, tower.y - 0.5, `Lv${applied}`, '#7fd6ff', 0.9));
    this._noteSpecTier(tower);
    return [true, ''];
  }

  /**
   * Nudge the player once a tower reaches a tier it has not committed to.
   *
   * Without this the choice sits in the inspector unnoticed -- and a pending
   * specialisation is a straight power loss until it is taken.
   */
  _noteSpecTier(tower) {
    const tier = this.pendingSpecTier(tower);
    if (tier === null) return;
    this.note(`${tower.d.name} reached Lv${tier.tier} — pick an upgrade`);
  }

  // ------------------------------------------------------ specialisations

  /** Tier definitions for a tower type, from data/specialisations.json. */
  specTiers(tower) {
    return this.config.specialisations[tower.key] ?? [];
  }

  /** Every tier this tower has reached, in order. */
  reachedSpecTiers(tower) {
    return this.specTiers(tower).filter((tier) => tower.level >= tier.tier);
  }

  /**
   * The lowest tier this tower has reached but not yet committed to, or null.
   *
   * Returns the tier itself rather than a flag so the UI can render the choices
   * without knowing anything about how tiers are structured.
   */
  pendingSpecTier(tower) {
    for (const tier of this.specTiers(tower)) {
      if (tower.level >= tier.tier && !tower.specs.has(tier.tier)) return tier;
    }
    return null;
  }

  /** What taking a specialisation would cost right now (0 in test mode). */
  specialisationCost(tower) {
    if (!tower) return 0;
    return this.test.enabled ? 0 : tower.specCost(this.leveling);
  }

  chooseSpecialisation(tower, optionKey) {
    if (!tower || !tower.alive) return [false, 'No tower selected'];

    const tier = this.pendingSpecTier(tower);
    if (tier === null) return [false, 'Nothing to choose at this level'];

    const option = tier.options.find((o) => o.key === optionKey);
    if (!option) return [false, 'Unknown specialisation'];

    const cost = tower.specCost(this.leveling);
    if (!this.test.enabled) {
      if (!this.economy.canAfford(cost)) return [false, `Needs ${cost.toFixed(0)} coins`];
      this.economy.spend(cost);
      tower.invested += cost;
    }

    tower.chooseSpec(tier.tier, option, this.leveling);
    this.addText(Fx.text(tower.x, tower.y - 0.6, option.name, '#c8a2ff', 1.6));
    this.note(`${tower.d.name} took ${option.name}`);
    return [true, ''];
  }

  sellTower(tower) {
    if (!tower.alive) return 0.0;
    const refund = tower.sellValue(this.sellRefundRate());
    tower.alive = false;
    this.towers.delete(World.tileKey(tower.tx, tower.ty));
    this.economy.refund(refund);
    this.stats.towersSold += 1;
    this.addText(Fx.text(tower.x, tower.y - 0.4, `+${refund.toFixed(0)}`, '#ffd166', 0.8));
    // Removing a tower frees a slot but can also drop another tower out of an
    // aura if this one was the only reason it was covered.
    this.refreshSupport();
    return refund;
  }

  cycleTargeting(tower) {
    // The list is imported rather than repeated: the previous local copy had
    // already drifted out of the parser's order, and a mode added to the data
    // but not to a hand-maintained duplicate is unreachable from the UI.
    const index = TARGETING_MODES.indexOf(tower.mode);
    tower.mode = TARGETING_MODES[(index + 1) % TARGETING_MODES.length];
    return tower.mode;
  }

  /** Cheap summary of the upcoming wave, for the HUD. */
  nextWavePreview() {
    const wave = this.waves.wave + 1;
    const orders = this.waves.buildWave(wave);
    const counts = {};
    for (const order of orders) {
      counts[order.key] = (counts[order.key] ?? 0) + 1;
    }
    return {
      wave,
      count: orders.length,
      counts,
      hp_mult: this.waves.hpMult(wave),
      is_boss: this.waves.isBossWave(wave),
      is_mini_boss: this.waves.isMiniBossWave(wave),
    };
  }

  /** Build a tower on the cheapest affordable spot, for auto-play/testing. */
  totalDps() {
    let total = 0;
    for (const tower of this.towers.values()) {
      if (tower.alive) total += tower.dps();
    }
    return total;
  }

  // ------------------------------------------------------------------- step

  update(dt) {
    if (this.paused || this.gameOver) return;

    // The step is used exactly as given. Game speed is applied by the loop, by
    // taking *more* steps of this size -- see loop.js for why stretching the
    // step instead would change the simulation rather than just speed it up.
    let step = dt;
    if (step <= 0.0) return;
    // Clamp so a stalled frame can never teleport enemies through a wave.
    if (step > 0.25) step = 0.25;

    this.time += step;

    this.waves.update(step, this);

    const enemies = this.enemies;
    for (let i = 0; i < enemies.length; i += 1) {
      enemies[i].update(step, this);
    }

    for (const tower of this.towers.values()) {
      if (tower.alive) tower.update(step, this);
    }

    const aircraft = this.aircraft;
    for (let i = 0; i < aircraft.length; i += 1) aircraft[i].update(step, this);

    this._updateProjectiles(step);
    this._updateEffects(step);
    this._cleanup();
  }

  _updateProjectiles(dt) {
    const projectiles = this.projectiles;
    for (let i = 0; i < projectiles.length; i += 1) {
      const projectile = projectiles[i];
      if (projectile.alive) projectile.update(dt, this);
    }
  }

  _updateEffects(dt) {
    tickEffects(this.fx, dt);
    tickEffects(this.texts, dt);
  }

  _cleanup() {
    const enemies = this.enemies;
    let anyDead = false;
    for (let i = 0; i < enemies.length; i += 1) {
      if (!enemies[i].alive) {
        anyDead = true;
        break;
      }
    }
    if (anyDead) this.enemies = enemies.filter((enemy) => enemy.alive);
  }

  // ---------------------------------------------------------------- summary

  summary() {
    return {
      wave: this.wave,
      kills: this.stats.kills,
      leaked: this.stats.leaked,
      damage: this.stats.damageDealt,
      coins_earned: this.economy.earned,
      towers_built: this.stats.towersBuilt,
      towers_sold: this.stats.towersSold,
      base_hp: Math.max(0.0, this.economy.baseHp),
      time: this.time,
      dps: this.totalDps(),
    };
  }
}

export { OVER, PREP };
