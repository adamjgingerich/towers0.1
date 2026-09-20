/**
 * Assembles the scene and pushes simulation state into the instanced batches
 * every frame.
 *
 * Reading order mirrors the simulation's step order, and the paint order is set
 * explicitly via renderOrder rather than left to depth sorting, so a projectile
 * always draws over an enemy and a turret always draws over its base.
 */

import * as THREE from 'three';

import { BUILDABLE, Grid } from '../sim/grid.js';
import { BARRACKS_KEY } from '../sim/barracks.js';
import { mulberry32 } from '../sim/rng.js';
import { hashText } from '../sim/terrain.js';
import { Tower } from '../sim/tower.js';
import { PROJECTILE_CAPACITY } from '../sim/world.js';
import { Atlas, WHITE } from './atlas.js';
import { SpriteBatch } from './batch.js';
import { ParticleSystem } from './particles.js';
import { Stage } from './stage.js';
import { buildPlaceholderSheets } from './textures.js';

export const LAYER = {
  board: 0,
  decor: 1,
  fxGround: 2,
  enemies: 3,
  // Health bars ride directly above the enemies they belong to, but below
  // projectiles and towers so the play layer always wins.
  health: 4,
  projectiles: 5,
  towerBase: 6,
  turret: 7,
  fxTop: 8,
  lines: 9,
  //
  // Weather sits over the whole play layer, because it is air and air is in
  // front of everything on the board -- but under the placement ghost and the
  // range ring, which are UI rather than scenery.
  weather: 9.5,
  ghost: 10,
  ring: 11,
};

/** Share of buildable tiles that get a background mark. */
const DECOR_CHANCE = 0.6;
const DECOR_CAPACITY = 1024;

/** Two quads per damaged enemy, against `max_concurrent` of 300. */
const HEALTH_BAR_CAPACITY = 700;
const HEALTH_BAR_HEIGHT = 0.07;
const HEALTH_BAR_LIFT = 0.3;
const HEALTH_BAR_WIDTH_SCALE = 2.4;
const HEALTH_BAR_MIN_WIDTH = 0.44;
const HEALTH_BAR_MAX_WIDTH = 1.5;

/**
 * How far above the road a flyer floats, in tiles.
 *
 * Enough to read as airborne and to lift it clear of the health bars of the
 * ground units it is passing over, but not so much that it looks detached from
 * the path it is following.
 */
const FLYER_LIFT = 0.42;
const FLYER_BOB = 0.045;
const FLYER_BOB_RATE = 3.4;

/** Vertical offset of an enemy's sprite, and of anything anchored to it. */
function enemyLift(enemy, time) {
  if (!enemy.d.flying) return 0;
  return FLYER_LIFT + Math.sin(time * FLYER_BOB_RATE + enemy.eid * 0.9) * FLYER_BOB;
}

/** Green through amber to red, as a linear multiplier for the white bar. */
function healthTint(fraction) {
  if (fraction > 0.6) return [0.42, 1.0, 0.48];
  if (fraction > 0.3) return [1.0, 0.78, 0.32];
  return [1.0, 0.34, 0.34];
}

/**
 * Effects drawn under the units rather than over them.
 *
 * `spawn` and `leak` are deliberately absent: those two mark the path itself
 * and read better on top.
 */
const GROUND_FX = new Set([
  'impact',
  'splash',
  'pop',
  'boom',
  'goo',
  'burn',
  'zap',
  'shatter',
  'coins',
]);

/**
 * Turn a level's base colour into a linear multiplier.
 *
 * Normalised so the brightest channel lands on `strength`. That keeps every map
 * at a similar overall brightness, so the tint reads as a change of hue rather
 * than of exposure -- otherwise a dark palette would also be a darker board and
 * change how legible the units are.
 */
function parseTint(hex, strength = 1.12) {
  if (typeof hex !== 'string' || !/^#?[0-9a-f]{6}$/i.test(hex.trim())) {
    return [1, 1, 1];
  }
  const value = parseInt(hex.trim().replace('#', ''), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const scale = strength / Math.max(1, r, g, b);
  return [r * scale, g * scale, b * scale];
}

const TILE_SPRITE = {
  '#': 'road',
  '.': 'buildable',
  X: 'blocked',
  S: 'spawn',
  E: 'base',
  '*': 'bonus',
};

const SLOW_TINT = [0.70, 0.88, 1.25];
const POISON_TINT = [0.78, 1.20, 0.80];

/**
 * A tower standing inside a barracks aura.
 *
 * A warm lift, subtle enough not to read as a status effect but enough that the
 * supported guns are distinguishable at a glance. Without it the only evidence
 * that an aura is doing anything is a number in the inspector, and placement --
 * which is the whole decision -- has no visible feedback.
 */
const SUPPORT_TINT = [1.18, 1.20, 1.06];

const ENEMY_CAPACITY = 384;
const FX_CAPACITY = 192;
const TOWER_CAPACITY = 320;

/**
 * Beam segments per frame.
 *
 * A tesla chain draws one segment per hop, so four chained teslas firing
 * together is already a dozen segments, and beams overlap for their whole
 * lifetime. Sizing this like FX_CAPACITY would start dropping segments in
 * exactly the fights where the arcs matter most.
 */
const BEAM_CAPACITY = 512;
/** How thick a beam / chain is drawn, in tiles. */
const BEAM_WIDTH = 0.11;
const CHAIN_WIDTH = 0.09;

/** Weather particles get their own pool, for the same reason atmosphere does. */
const WEATHER_PARTICLE_CAPACITY = 460;

/**
 * Aircraft on screen at once.
 *
 * Nine barracks can each field a Strike Group plus a Second Wing, which is
 * eighty aircraft, so this is sized for a full board of the best air power in
 * the game rather than for one wing.
 */
const AIRCRAFT_CAPACITY = 128;

/**
 * Weather emission, in particles per second.
 *
 * A rate rather than a per-frame count, so the same spell does not look like a
 * drizzle on a fast machine and a downpour on a slow one.
 */
const WEATHER_RATE = {
  rain: 170,
  snow: 60,
  sleet: 130,
  sun: 26,
  storm: 230,
  fog: 16,
};

/** Cool, because rain is not snow and neither is dust. */
const RAIN_TINT = [0.72, 0.82, 1.0];

/**
 * Particle pool size per layer.
 *
 * Two pools, split by depth rather than by kind: dust and ground smoke belong
 * under the units, muzzle flashes and rising plumes over them. Each is large
 * enough that a busy wave never visibly truncates, and because particles cannot
 * touch `world.fx`, overspill costs only atmosphere -- see particles.js.
 */
const PARTICLE_CAPACITY = 512;

/**
 * Where each tower's muzzle actually is, in tiles from the tower centre.
 *
 * Measured off the turret art rather than derived, because barrel lengths are an
 * art decision: the sniper's is nearly a whole tile, the mortar's is a stubby
 * wide tube. These track `TURRET_SCALE` in textures.js -- a flash that starts
 * inside the barrel, or floats a barrel's length past it, looks broken.
 */
const MUZZLE_REACH = {
  basic: 0.46,
  cannon: 0.58,
  frost: 0.48,
  tesla: 0.38,
  venom: 0.5,
  sniper: 0.68,
  gatling: 0.46,
  flamethrower: 0.5,
  missile: 0.54,
  mortar: 0.32,
};

/**
 * Recoil throw, in tiles, for a given tower.
 *
 * Derived from damage rather than tabulated: the impulse a gun imparts is what
 * makes it kick, and damage is the simulation's own measure of how big a hit it
 * throws. Clamped so the heaviest guns do not visibly detach from their mounts.
 */
function recoilFor(tower) {
  return Math.min(0.17, 0.025 + tower.d.damage / 720);
}

/** Death flourishes that should throw a puff of smoke as well as their sprite. */
const SMOKY_FX = new Set(['boom', 'splash', 'impact', 'burn', 'goo', 'shatter']);

function circleGeometry(segments = 96) {
  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function squareGeometry() {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, -0.5, 0),
    new THREE.Vector3(0.5, -0.5, 0),
    new THREE.Vector3(0.5, 0.5, 0),
    new THREE.Vector3(-0.5, 0.5, 0),
  ]);
}

export class GameRenderer {
  constructor(stage, config, grid, terrain) {
    this.stage = stage;
    this.config = config;
    /** Elevation field, shared with the world so art and gameplay agree. */
    this.terrain = terrain;
    /** This level's base colour, as a linear multiplier. */
    this.mapTint = parseTint(config.mapTint);

    const sheets = buildPlaceholderSheets(config.atlas);
    const sizes = {};
    for (const [name, sheet] of Object.entries(sheets)) {
      sizes[name] = { width: sheet.width, height: sheet.height };
    }
    this.atlas = new Atlas(config.atlas, sizes);
    this.sheets = sheets;

    this._addBatches();
    this._addOverlays();
    this._buildBoard(grid);
    this._buildDecor(grid);

    // Cache the tile UVs: the board never changes, so nor do they.
    this._tileUv = {};
    for (const key of Object.values(TILE_SPRITE)) {
      this._tileUv[key] = this.atlas.frame('tiles', key, 0) ?? Atlas.missingFrame();
    }

    /**
     * Presentation-only bookkeeping, all keyed by identity so nothing has to be
     * cleaned up when a tower is sold or an enemy dies.
     *
     * `_lastShots` is how a firing edge is detected. `_seenFx` is the same trick
     * the floating-text layer uses: effect objects are created fresh per event,
     * so seeing one for the first time *is* the event.
     */
    this._lastShots = new WeakMap();
    this._seenFx = new WeakSet();
    this._lastBaseHp = null;
    /** Seconds since each projectile last emitted exhaust, indexed by slot. */
    this._trailClock = new Float32Array(PROJECTILE_CAPACITY);
    /** Sim time at the previous sync, so particles advance with the game. */
    this._prevTime = null;

    /**
     * Atmosphere gets its own PRNG. Using the world's would let a puff of smoke
     * change the crit rolls, because every draw advances the shared stream.
     */
    this._rand = mulberry32(0x9e3779b9);

    /** Scratch colour for tinting beam quads; parsing a string per segment
     *  would allocate in the hot render path. */
    this._beamColor = new THREE.Color();
  }

  _addBatches() {
    const stage = this.stage;
    const tex = (name) => this.sheets[name].texture;

    this.board = new SpriteBatch(tex('tiles'), 2048, LAYER.board);
    this.decor = new SpriteBatch(tex('decor'), DECOR_CAPACITY, LAYER.decor);
    // Supply pathways between bases, drawn as dashed beam quads on the ground.
    this.links = new SpriteBatch(tex('fx'), 1024, LAYER.decor);
    this.bars = new SpriteBatch(tex('bars'), HEALTH_BAR_CAPACITY, LAYER.health);
    this.shadows = new SpriteBatch(tex('fx'), ENEMY_CAPACITY, LAYER.fxGround);
    // Its own batch rather than sharing `shadows`: a flying shielded enemy needs
    // both at once, and overfilling a batch drops draws silently.
    this.shields = new SpriteBatch(tex('fx'), ENEMY_CAPACITY, LAYER.fxGround);
    this.fxGround = new SpriteBatch(tex('fx'), FX_CAPACITY, LAYER.fxGround);
    this.enemies = new SpriteBatch(tex('enemies'), ENEMY_CAPACITY, LAYER.enemies);

    /**
     * Aircraft, drawn on the enemy layer rather than its own.
     *
     * They are units, not effects: they should sort against enemies by the same
     * rule, and a separate layer would only be a second place to get that wrong.
     */
    this.aircraftUnits = new SpriteBatch(tex('aircraft'), AIRCRAFT_CAPACITY, LAYER.enemies);
    this.projectiles = new SpriteBatch(tex('projectiles'), PROJECTILE_CAPACITY, LAYER.projectiles);
    this.towerBases = new SpriteBatch(tex('towers_base'), TOWER_CAPACITY, LAYER.towerBase);
    this.turrets = new SpriteBatch(tex('towers_turret'), TOWER_CAPACITY, LAYER.turret);
    this.fxTop = new SpriteBatch(tex('fx'), FX_CAPACITY, LAYER.fxTop);

    // Beams and chains are drawn as stretched quads rather than GL lines.
    // WebGL ignores `linewidth`, so a LineBasicMaterial beam is always exactly
    // one pixel wide -- which is why the sniper's tracer and the tesla's arcs
    // were invisible in practice, and why players reported "no projectiles" for
    // the two towers that fire instantly.
    this.beams = new SpriteBatch(tex('fx'), BEAM_CAPACITY, LAYER.lines);

    // Atmosphere, split by depth: dust and ground smoke behind the units,
    // muzzle flashes and rising plumes in front of them.
    this.particlesBack = new ParticleSystem(tex('fx'), PARTICLE_CAPACITY, LAYER.fxGround);
    this.particlesFront = new ParticleSystem(tex('fx'), PARTICLE_CAPACITY, LAYER.fxTop);

    /**
     * Weather, on its own pool and its own layer.
     *
     * Separate from the atmosphere pools on purpose: a storm emits hundreds of
     * drops a second and would otherwise evict every muzzle flash and plume on
     * the board, which are gameplay feedback rather than decoration.
     */
    this.weatherParticles = new ParticleSystem(tex('fx'), WEATHER_PARTICLE_CAPACITY, LAYER.weather);

    for (const batch of [
      this.board,
      this.decor,
      this.links,
      this.shadows,
      this.shields,
      this.fxGround,
      this.enemies,
      this.aircraftUnits,
      this.bars,
      this.projectiles,
      this.towerBases,
      this.turrets,
      this.particlesBack.batch,
      this.fxTop,
      this.particlesFront.batch,
      this.beams,
      this.weatherParticles.batch,
    ]) {
      stage.scene.add(batch.mesh);
    }
  }

  _addOverlays() {
    const stage = this.stage;

    this.ghost = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x6ee7a8,
        transparent: true,
        opacity: 0.26,
        depthTest: false,
      }),
    );
    this.ghost.renderOrder = LAYER.ghost;
    this.ghost.visible = false;
    stage.scene.add(this.ghost);

    this.ghostEdge = new THREE.LineLoop(
      squareGeometry(),
      new THREE.LineBasicMaterial({ color: 0x6ee7a8, transparent: true, depthTest: false }),
    );
    this.ghostEdge.renderOrder = LAYER.ghost + 1;
    this.ghostEdge.visible = false;
    stage.scene.add(this.ghostEdge);

    this.ring = new THREE.LineLoop(
      circleGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x9fd8ff,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
      }),
    );
    this.ring.renderOrder = LAYER.ring;
    this.ring.visible = false;
    stage.scene.add(this.ring);

    this._ghostOk = new THREE.Color(0x6ee7a8);
    this._ghostBad = new THREE.Color(0xff6b6b);

    /**
     * The weather wash: one translucent quad over the whole board.
     *
     * A wash rather than a per-pixel effect, because the point is to make the
     * spell legible at a glance without ever hiding the lane -- and because it
     * costs one draw call no matter what the weather is doing. Opacity comes
     * straight from the data and is clamped in the parser, so a data mistake
     * cannot black the board out.
     */
    this.weatherWash = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.weatherWash.renderOrder = LAYER.weather;
    this.weatherWash.visible = false;
    stage.scene.add(this.weatherWash);

    /** Carry for the fractional part of an emission rate. */
    this._weatherClock = 0;
    /** Countdown to the next lightning flash, and its current brightness. */
    this._stormTimer = 1.5;
    this._stormFlash = 0;
  }

  /** Static tile layer, drawn once. */
  _buildBoard(grid) {
    this.board.begin();

    for (let ty = 0; ty < grid.height; ty += 1) {
      for (let tx = 0; tx < grid.width; tx += 1) {
        const key = TILE_SPRITE[grid.at(tx, ty)] ?? 'blocked';
        const uv = this.atlas.frame('tiles', key, 0);
        if (!uv) continue;
        const [wx, wy] = Stage.worldFromTile(tx + 0.5, ty + 0.5);

        // Elevation relief, tinted by the level's own palette. Baked into the
        // static board, so it costs one multiply per tile, once.
        const shade = this.terrain.shadeAt(tx, ty);
        this.board.push(wx, wy, 0, 1, uv, [
          this.mapTint[0] * shade,
          this.mapTint[1] * shade,
          this.mapTint[2] * shade,
        ]);
      }
    }

    this.board.end();
  }

  /**
   * Scatter landscape linework over the buildable tiles.
   *
   * Seeded from the map text, so a level always looks the same: a reload, a
   * loaded save and a second player all see an identical board. Randomising per
   * session instead would make the marks read as noise rather than as part of
   * the level.
   *
   * Only plain buildable tiles are stamped. Road, spawn, base and bonus tiles
   * all carry meaning the player has to read at a glance, so they stay clean.
   */
  _buildDecor(grid) {
    this.decor.begin();

    const keys = this.sheets.decor?.keys ?? [];
    if (keys.length === 0) return;

    const rand = mulberry32(hashText(this.config.waves.map));

    for (let ty = 0; ty < grid.height; ty += 1) {
      for (let tx = 0; tx < grid.width; tx += 1) {
        if (grid.at(tx, ty) !== BUILDABLE) continue;
        if (rand() > DECOR_CHANCE) continue;

        const key = keys[Math.floor(rand() * keys.length)];
        const uv = this.atlas.frame('decor', key, 0);
        if (!uv) continue;

        const [wx, wy] = Stage.worldFromTile(tx + 0.5, ty + 0.5);
        // Exactly one tile, no jitter: the motifs are drawn edge to edge so the
        // same mark on two neighbouring tiles lines up and reads as one
        // continuous landscape rather than a scattered pattern.
        this.decor.push(wx, wy, 0, 1, uv);
      }
    }

    this.decor.end();
  }

  _frame(sheet, key, t) {
    const sprite = this.atlas.spriteDef(sheet, key);
    if (!sprite) return 0;
    const frames = sprite.frames ?? 1;
    if (frames <= 1) return 0;
    return Math.floor(t * (sprite.fps ?? 8)) % frames;
  }

  /**
   * @param {import('../sim/world.js').World} world
   * @param {{hover: number[]|null, placingKey: string|null, selected: object|null}} view
   */
  sync(world, view) {
    const time = world.time;
    const dt = this._sampleDt(time);

    this._syncLinks(world);
    this._syncEnemies(world, time);
    this._syncAircraft(world, time);
    this._syncHealthBars(world);
    this._syncTowers(world, time);
    this._syncProjectiles(world, time, dt);
    this._syncFx(world);
    this._emitWeather(world, dt);
    this._updateWeatherWash(world, dt);
    this._emitAtmosphere(world, dt);
    this._advanceParticles(dt);
    this._syncOverlays(world, view);
  }

  /**
   * Simulation time since the previous frame.
   *
   * Derived from the world clock rather than the frame clock, so pausing freezes
   * the smoke along with everything else and 3x speed makes the whole scene move
   * at 3x rather than leaving a leisurely plume drifting over a frantic board.
   */
  _sampleDt(time) {
    let dt = this._prevTime === null ? 0 : time - this._prevTime;
    this._prevTime = time;
    // A pause-and-resume or a level swap must not teleport every particle.
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    this._dt = Math.min(dt, 0.05);
    return this._dt;
  }

  /** Advance and draw every particle pool. */
  _advanceParticles(dt) {
    this.particlesBack.update(dt);
    this.particlesFront.update(dt);
    this.weatherParticles.update(dt);
    this.particlesBack.sync(this.atlas);
    this.particlesFront.sync(this.atlas);
    this.weatherParticles.sync(this.atlas);
  }

  /**
   * Draw the weather.
   *
   * Emitted across the *visible* rectangle rather than the whole board, so a
   * zoomed-in view gets a dense spell instead of scattering most of its drops
   * off-screen. Particles are in tile space with y pointing down, which is why
   * `visibleTileRect` flips the camera's y.
   */
  _emitWeather(world, dt) {
    const weather = world.weather;
    if (!weather || dt <= 0) return;

    const rate = WEATHER_RATE[weather.particles];
    if (!rate) return;

    const pool = this.weatherParticles;
    const rect = this.stage.visibleTileRect();
    const rand = this._rand;
    const spanX = rect.x1 - rect.x0;
    const spanY = rect.y1 - rect.y0;
    const kind = weather.particles;

    this._weatherClock += dt * rate;
    let count = Math.floor(this._weatherClock);
    this._weatherClock -= count;
    // A long frame (a tab regaining focus) must not dump a second's worth of
    // drops in one frame and flood the pool.
    if (count > 60) count = 60;

    for (let i = 0; i < count; i += 1) {
      // Spread over the whole visible height rather than spawning at the top:
      // an effect that starts empty and fills in reads as a glitch on the
      // frame the weather changes.
      const x = rect.x0 + rand() * spanX;
      const y = rect.y0 + rand() * spanY;

      if (kind === 'rain' || kind === 'storm') {
        const fast = kind === 'storm' ? 1.3 : 1.0;
        pool.emit({
          x,
          y,
          vx: 1.4 * fast,
          vy: (15 + rand() * 6) * fast,
          life: 1.1,
          size0: 0.34,
          size1: 0.34,
          angle: 0.1,
          sprite: 'rain',
          tint: RAIN_TINT,
        });
      } else if (kind === 'snow') {
        pool.emit({
          x,
          y,
          vx: (rand() - 0.5) * 0.5,
          vy: 1.5 + rand() * 0.9,
          life: 4.0,
          size0: 0.2,
          size1: 0.2,
          spin: (rand() - 0.5) * 1.4,
          sprite: 'flake',
        });
      } else if (kind === 'sleet') {
        // Half rain, half flakes: sleet has to read as neither.
        if (rand() < 0.55) {
          pool.emit({
            x,
            y,
            vx: 1.0,
            vy: 13 + rand() * 5,
            life: 1.0,
            size0: 0.28,
            size1: 0.28,
            angle: 0.08,
            sprite: 'rain',
            tint: RAIN_TINT,
          });
        } else {
          pool.emit({
            x,
            y,
            vx: (rand() - 0.5) * 0.4,
            vy: 2.4,
            life: 3.2,
            size0: 0.18,
            size1: 0.18,
            sprite: 'flake',
          });
        }
      } else if (kind === 'sun') {
        // Dust and pollen lifting in the heat, which is what sells a still hot
        // day better than a tint alone.
        pool.emit({
          x,
          y,
          vx: (rand() - 0.5) * 0.35,
          vy: -0.35 - rand() * 0.4,
          life: 3.4,
          size0: 0.1,
          size1: 0.22,
          sprite: 'mote',
          tint: [1.0, 0.94, 0.72],
        });
      } else if (kind === 'fog') {
        // Wide, slow, nearly transparent bands rather than droplets.
        pool.emit({
          x,
          y,
          vx: 0.5 + rand() * 0.5,
          vy: (rand() - 0.5) * 0.12,
          life: 5.0,
          size0: 1.5,
          size1: 2.6,
          sprite: 'mote',
          tint: [0.86, 0.89, 0.93],
        });
      }
    }
  }

  /** Tint and fade the board wash, and run the storm's lightning. */
  _updateWeatherWash(world, dt) {
    const weather = world.weather;
    const wash = this.weatherWash;
    if (!weather || weather.alpha <= 0) {
      wash.visible = false;
      this._stormFlash = 0;
      return;
    }

    const grid = world.grid;
    wash.position.set(grid.width / 2, -grid.height / 2, 0);
    wash.scale.set(grid.width, grid.height, 1);

    // Lightning: a brief spike in the wash. Cheaper and far less obtrusive than
    // drawing bolts, which at gameplay zoom would hide the lane they strike.
    if (weather.key === 'storm') {
      this._stormTimer -= dt;
      if (this._stormTimer <= 0) {
        this._stormTimer = 2.4 + this._rand() * 3.6;
        this._stormFlash = 1;
      }
      this._stormFlash = Math.max(0, this._stormFlash - dt * 4.5);
    } else {
      this._stormFlash = 0;
    }

    wash.visible = true;
    wash.material.color.set(weather.tint);
    wash.material.opacity = Math.min(0.42, weather.alpha + this._stormFlash * 0.2);
  }

  /**
   * Everything the board does when nothing in particular is happening.
   *
   * All of it is rate-limited. Ambient effects that fire on every frame look
   * like a rendering fault rather than like life, and the pool they come from
   * is shared, so one runaway emitter would starve every other one.
   */
  _emitAtmosphere(world, dt) {
    if (dt <= 0) return;
    const rand = this._rand;
    const back = this.particlesBack;
    const front = this.particlesFront;

    for (let i = 0; i < world.enemies.length; i += 1) {
      const enemy = world.enemies[i];
      if (!enemy.alive) continue;

      // Anything on fire smoulders. This is the strongest "alive" cue on the
      // board: damage that keeps visibly burning reads as ongoing.
      let burning = false;
      for (let d = 0; d < enemy.dots.length; d += 1) {
        if (enemy.dots[d][3] === 'fire') { burning = true; break; }
      }
      if (burning && rand() < dt * 22) {
        front.emit({
          x: enemy.x + (rand() - 0.5) * 0.2,
          y: enemy.y + (rand() - 0.5) * 0.2,
          vx: (rand() - 0.5) * 0.25,
          vy: -0.35 - rand() * 0.4,
          life: 0.7 + rand() * 0.6,
          size0: 0.16,
          size1: 0.5,
          sprite: 'smoke',
        });
      }

      // Heavy things kick up dust as they walk.
      if ((enemy.key === 'heavy' || enemy.key === 'boss') && rand() < dt * 6) {
        back.emit({
          x: enemy.x - Math.cos(enemy.angle) * enemy.d.radius,
          y: enemy.y - Math.sin(enemy.angle) * enemy.d.radius,
          vx: (rand() - 0.5) * 0.3,
          vy: (rand() - 0.5) * 0.3,
          life: 0.5 + rand() * 0.4,
          size0: 0.14,
          size1: 0.36,
          sprite: 'dust',
        });
      }
    }

    // A wounded base smoulders, and smoulders harder the closer it is to
    // falling. It is the one place on the board where the scenery reports the
    // score, so it earns the extra particles.
    const economy = world.economy;
    if (economy.baseHpMax > 0) {
      const health = economy.baseHp / economy.baseHpMax;
      if (health < 0.6) {
        const severity = 1 - health;
        const [bx, by] = Grid.tileCenter(world.grid.base[0], world.grid.base[1]);
        if (rand() < dt * (4 + severity * 26)) {
          front.emit({
            x: bx + (rand() - 0.5) * 0.8,
            y: by + (rand() - 0.5) * 0.8,
            vx: (rand() - 0.5) * 0.3,
            vy: -0.5 - rand() * 0.6 * severity,
            life: 0.9 + rand() * 0.9,
            size0: 0.25,
            size1: 0.9 + severity * 0.6,
            sprite: 'smoke',
          });
        }
      }
    }
  }

  /**
   * Smoke and grit thrown by an already-happening blast.
   *
   * Keyed off the effect that caused it rather than off the damage flow, so it
   * stays purely decorative: if a blast is drawn, it smokes, and nothing here
   * can change what the blast did.
   */
  _emitBlastSmoke(effect) {
    if (!SMOKY_FX.has(effect.key)) return;

    const rand = this._rand;
    const ground = this.particlesBack;
    const top = this.particlesFront;
    const scale = effect.scale ?? 1;
    const big = effect.key === 'boom';
    const puffs = big ? 3 : 2;

    for (let i = 0; i < puffs; i += 1) {
      top.emit({
        x: effect.x + (rand() - 0.5) * 0.3 * scale,
        y: effect.y + (rand() - 0.5) * 0.3 * scale,
        vx: (rand() - 0.5) * 0.5,
        vy: -0.25 - rand() * 0.45,
        life: 0.5 + rand() * 0.6,
        size0: 0.16 * scale,
        size1: (big ? 0.8 : 0.5) * scale,
        sprite: 'smoke',
      });
    }

    // Grit kicked along the ground, which is what sells the blast as having
    // *hit* something rather than merely flashed.
    ground.emit({
      x: effect.x,
      y: effect.y,
      vx: (rand() - 0.5) * 0.8,
      vy: (rand() - 0.5) * 0.8,
      life: 0.4 + rand() * 0.3,
      size0: 0.12 * scale,
      size1: 0.4 * scale,
      sprite: 'dust',
    });
  }

  /** A muzzle flash and its smoke, thrown out along the barrel. */
  _emitMuzzle(tower, front) {    const rand = this._rand;
    const reach = MUZZLE_REACH[tower.key] ?? 0.3;
    const cos = Math.cos(tower.angle);
    const sin = Math.sin(tower.angle);
    const mx = tower.x + cos * reach;
    const my = tower.y + sin * reach;

    front.emit({
      x: mx,
      y: my,
      vx: cos * 1.4,
      vy: sin * 1.4,
      life: 0.11,
      size0: 0.26,
      size1: 0.44,
      sprite: 'muzzle',
      angle: tower.angle,
      drag: 3.0,
    });

    // Sparks for the powder guns. Energy and ice towers flash without them.
    const d = tower.d;
    if (d.damage_type === 'physical' || d.damage_type === 'fire') {
      front.emit({
        x: mx,
        y: my,
        vx: cos * 1.9 + (rand() - 0.5),
        vy: sin * 1.9 + (rand() - 0.5),
        life: 0.2,
        size0: 0.14,
        size1: 0.3,
        sprite: 'spark',
        angle: tower.angle,
        drag: 4.0,
      });
    }

    // Big guns also blow a curl of smoke off the muzzle.
    if (d.damage >= 40) {
      front.emit({
        x: mx,
        y: my,
        vx: cos * 0.5,
        vy: sin * 0.5 - 0.15,
        life: 0.6 + rand() * 0.4,
        size0: 0.14,
        size1: 0.46,
        sprite: 'smoke',
      });
    }
  }

  /**
   * Supply pathways between linked bases, drawn as a dashed line on the ground.
   *
   * A dashed beam quad per step rather than a GL line, for the same reason the
   * tesla arcs are: WebGL ignores `linewidth`, so a LineBasicMaterial would be a
   * one-pixel hairline that reads as a scratch rather than as a road.
   */
  _syncLinks(world) {
    const batch = this.links;
    const beamUv = this.atlas.frame('fx', 'beam', 0);
    if (!beamUv) return;
    batch.begin();

    const DASH = 0.34;
    const GAP = 0.22;
    for (const base of world.barracks.values()) {
      if (!base.alive) continue;
      for (const key of base.links) {
        const other = world.barracks.get(key);
        if (!other || !other.alive) continue;
        // Each pair once: only draw when this base's key sorts first.
        if (`${base.tx},${base.ty}` > key) continue;

        const [ax, ay] = Stage.worldFromTile(base.x, base.y);
        const [bx, by] = Stage.worldFromTile(other.x, other.y);
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;
        const ux = dx / len;
        const uy = dy / len;
        const angle = Math.atan2(dy, dx);
        for (let t = DASH / 2; t < len; t += DASH + GAP) {
          batch.push(ax + ux * t, ay + uy * t, angle, DASH, beamUv, [0.36, 0.52, 0.78], 0.09);
        }
      }
    }

    batch.end();
  }

  /**
   * Aircraft, and their shadows.
   *
   * The shadow is drawn from the aircraft sheet rather than the shared `fx` one
   * on purpose. A SpriteBatch is bound to a single texture, and the shadow has
   * to land under the aircraft -- pushing it into the enemy shadow batch would
   * mean a second begin/end over that batch, and the second `begin()` resets its
   * count and wipes every enemy shadow drawn earlier in the frame.
   */
  _syncAircraft(world, time) {
    const batch = this.aircraftUnits;
    const shadowUv = this.atlas.frame('aircraft', 'shadow', 0);
    batch.begin();

    const list = world.aircraft;
    for (let i = 0; i < list.length; i += 1) {
      const craft = list[i];
      if (!craft.alive) continue;

      const uv = this.atlas.frame(
        'aircraft',
        craft.kind,
        this._frame('aircraft', craft.kind, time + craft.id * 0.07),
      );
      if (!uv) continue;

      const [wx, wy] = Stage.worldFromTile(craft.x, craft.y);
      // Altitude is shown the same way it is for flyers: a shadow pinned to the
      // ground with the sprite lifted off it. A ground vehicle has no altitude,
      // so it gets no shadow -- one drawn on top of the sprite it belongs to
      // just reads as a dark smudge around the tank.
      const lift = craft.d.altitude;
      const size = craft.d.scale ?? 1;
      if (lift > 0 && shadowUv) batch.push(wx, wy, 0, size, shadowUv);
      batch.push(wx, wy - lift, -craft.angle, size, uv);
    }

    batch.end();
  }

  _syncEnemies(world, time) {
    const batch = this.enemies;
    const shadows = this.shadows;
    const shields = this.shields;
    const shadowUv = this.atlas.frame('fx', 'shadow', 0);
    const shieldUv = this.atlas.frame('fx', 'shield', 0);
    batch.begin();
    shadows.begin();
    shields.begin();

    for (let i = 0; i < world.enemies.length; i += 1) {
      const enemy = world.enemies[i];
      if (!enemy.alive) continue;

      // Stagger the walk cycle so a crowd does not march in lockstep. Each
      // enemy carries a visual variant (`_v1`/`_v2` atlas rows) so a crowd of
      // one type reads as a population rather than a clone stamp.
      const variantKey = enemy.variant > 0 ? `${enemy.key}_v${enemy.variant}` : enemy.key;
      const uv = this.atlas.frame('enemies', variantKey, this._frame('enemies', variantKey, time + enemy.eid * 0.05));
      if (!uv) continue;

      let tint = null;
      if (enemy.slowTime > 0) tint = SLOW_TINT;
      if (enemy.dots.length > 0) tint = tint ? [0.7, 1.1, 0.85] : POISON_TINT;

      const [wx, wy] = Stage.worldFromTile(enemy.x, enemy.y);

      // Flyers walk the road now, so altitude has to be shown rather than
      // implied: a bobbing sprite plus a shadow pinned to the ground beneath
      // it. Without this a flyer is indistinguishable from a ground unit.
      const lift = enemyLift(enemy, time);
      if (lift > 0 && shadowUv) shadows.push(wx, wy, 0, 1, shadowUv);

      // A live barrier is drawn under the unit. Without it the health bar sits
      // still while the enemy shrugs off everything, which reads as a bug rather
      // than as a shield -- the size and brightness of the ring are the only
      // feedback the player gets that they are making progress against it.
      if (enemy.shield > 0.0 && shieldUv) {
        const frac = enemy.shieldMax > 0.0
          ? Math.max(0, Math.min(1, enemy.shield / enemy.shieldMax))
          : 0.0;
        const tone = 0.35 + frac * 0.65;
        shields.push(wx, wy, 0, 1.45 + frac * 0.4, shieldUv, [tone, tone, tone]);
      }

      batch.push(wx, wy - lift, -enemy.angle, 1, uv, tint ?? undefined);
    }

    batch.end();
    shadows.end();
    shields.end();
  }

  /**
   * Health bars, shown only once an enemy has taken damage.
   *
   * Two tinted quads per enemy rather than anything added to the enemy sprite:
   * the bar then keeps a constant on-screen size regardless of the enemy's own
   * scale, and a full-health enemy costs no draw calls at all.
   */
  _syncHealthBars(world) {
    const batch = this.bars;
    const bgUv = this.atlas.frame('bars', 'bg', 0);
    const fillUv = this.atlas.frame('bars', 'fill', 0);

    batch.begin();
    // No early return between begin() and end(): that would leave the batch
    // showing the previous frame's count.
    if (bgUv && fillUv) {
      const enemies = world.enemies;
      for (let i = 0; i < enemies.length; i += 1) {
        const enemy = enemies[i];
        if (!enemy.alive) continue;

        const fraction = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0;
        // "Below 100%" -- an undamaged enemy shows nothing.
        if (fraction >= 1.0 || fraction <= 0.0) continue;

        const [wx, wy] = Stage.worldFromTile(enemy.x, enemy.y);
        // worldFromTile negates y, so +y is up the screen. The lift has to
        // match the sprite, or a flyer's bar hangs through its own belly.
        const barY = wy + enemyLift(enemy, world.time) + enemy.d.radius + HEALTH_BAR_LIFT;
        const width = Math.min(
          HEALTH_BAR_MAX_WIDTH,
          Math.max(HEALTH_BAR_MIN_WIDTH, enemy.d.radius * HEALTH_BAR_WIDTH_SCALE),
        );

        // A wider, taller backing so the bar reads over both road and ground.
        batch.push(wx, barY, 0, width, bgUv, WHITE, HEALTH_BAR_HEIGHT * 1.9);

        // Grow the fill from the left edge rather than shrinking to the centre.
        const fillWidth = width * fraction;
        batch.push(
          wx - width / 2 + fillWidth / 2,
          barY,
          0,
          fillWidth,
          fillUv,
          healthTint(fraction),
          HEALTH_BAR_HEIGHT,
        );
      }
    }

    batch.end();
  }

  _syncTowers(world, time) {
    const bases = this.towerBases;
    const turrets = this.turrets;
    bases.begin();
    turrets.begin();

    for (const tower of world.towers.values()) {
      if (!tower.alive) continue;

      // Offset the animation phase per tower, or a row of identical guns pulses
      // in perfect unison and reads as one object rather than as many.
      const phase = tower.tx * 0.17 + tower.ty * 0.11;
      const baseUv = this.atlas.frame(
        'towers_base',
        tower.key,
        this._frame('towers_base', tower.key, time + phase),
      );
      const turretUv = this.atlas.frame(
        'towers_turret',
        tower.key,
        this._frame('towers_turret', tower.key, time + phase),
      );
      if (!baseUv || !turretUv) continue;

      const [wx, wy] = Stage.worldFromTile(tower.x, tower.y);

      // Recoil: the turret is thrown back along its own barrel and eases home.
      // The sprite is drawn facing +x and placed with rotation -angle, so the
      // barrel points along (cos angle, sin -angle) in world space.
      const kick = tower.muzzle * recoilFor(tower);
      const taper = kick === 0 ? 0 : kick * kick;
      const tx = wx - Math.cos(-tower.angle) * taper;
      const ty = wy - Math.sin(-tower.angle) * taper;

      bases.push(wx, wy, 0, 1, baseUv, tower.supportSources.length > 0 ? SUPPORT_TINT : undefined);
      turrets.push(tx, ty, -tower.angle, 1, turretUv, tower.supportSources.length > 0 ? SUPPORT_TINT : undefined);

      // Firing edge, detected on a monotonic counter rather than a timer: at 3x
      // speed a gatling can fire again before a decaying flash would reach zero,
      // and a timer-based test would silently skip every other shot.
      const seen = this._lastShots.get(tower);
      if (seen !== undefined && seen !== tower.shots) {
        const shots = tower.shots - seen;
        // Cap the burst so a tower that was off-screen for a while does not
        // dump fifty flashes into the pool on the frame it returns.
        if (shots > 0 && shots <= 4) this._emitMuzzle(tower, this.particlesFront);
      }
      this._lastShots.set(tower, tower.shots);
    }

    // Barracks share the base sheet but have no turret: they never aim at
    // anything, so there is nothing to rotate. The sprite row follows the
    // structure's rank, so a promotion visibly rebuilds it on the board.
    for (const barracks of world.barracks.values()) {
      if (!barracks.alive) continue;
      const key = `barracks_${barracks.rankArt}`;
      const frame = this._frame(
        'towers_base',
        key,
        time + barracks.tx * 0.13 + barracks.ty * 0.07,
      );
      // Falling back rather than skipping: a missing rank sprite would leave a
      // hole in the board that reads as "the barracks disappeared", which is a
      // worse failure than drawing the wrong building.
      const uv =
        this.atlas.frame('towers_base', key, frame) ??
        this.atlas.frame('towers_base', 'barracks_1', frame);
      if (!uv) continue;
      const [wx, wy] = Stage.worldFromTile(barracks.x, barracks.y);
      bases.push(wx, wy, 0, 1, uv);
    }

    bases.end();
    turrets.end();
  }

  _syncProjectiles(world, time, dt) {
    const batch = this.projectiles;
    const front = this.particlesFront;
    const rand = this._rand;
    batch.begin();

    const projectiles = world.projectiles;
    for (let i = 0; i < projectiles.length; i += 1) {
      const projectile = projectiles[i];
      if (!projectile.alive) {
        this._trailClock[i] = 0;
        continue;
      }

      const uv = this.atlas.frame(
        'projectiles',
        projectile.sprite,
        this._frame('projectiles', projectile.sprite, time + i * 0.03),
      );
      if (!uv) continue;

      const [wx, wy] = Stage.worldFromTile(projectile.x, projectile.y);
      // Projectile frames are half a tile wide.
      batch.push(wx, wy, -projectile.angle, 0.5, uv);

      // Exhaust, on a per-projectile clock rather than once per frame. At 60fps
      // a long-lived rocket would otherwise shed sixty puffs a second and eat
      // the whole pool by itself.
      const smoky = projectile.sprite === 'rocket' || projectile.sprite === 'flame';
      if (!smoky) {
        this._trailClock[i] = 0;
        continue;
      }

      this._trailClock[i] -= dt;
      if (this._trailClock[i] > 0) continue;
      this._trailClock[i] = projectile.sprite === 'flame' ? 0.055 : 0.035;

      const tail = projectile.sprite === 'flame' ? 0.14 : 0.18;
      front.emit({
        x: projectile.x - Math.cos(projectile.angle) * tail,
        y: projectile.y - Math.sin(projectile.angle) * tail,
        vx: (rand() - 0.5) * 0.25,
        vy: (rand() - 0.5) * 0.25 - (projectile.sprite === 'flame' ? 0.25 : 0.08),
        life: projectile.sprite === 'flame' ? 0.32 : 0.42,
        size0: 0.08,
        size1: projectile.sprite === 'flame' ? 0.34 : 0.3,
        sprite: 'smoke',
      });
    }

    batch.end();
  }

  _syncFx(world) {
    const ground = this.fxGround;
    const top = this.fxTop;
    const beams = this.beams;
    const beamUv = this.atlas.frame('fx', 'beam', 0);
    ground.begin();
    top.begin();
    beams.begin();

    for (let i = 0; i < world.fx.length; i += 1) {
      const effect = world.fx[i];
      const progress = effect.progress;

      if (effect.kind === 'sprite') {
        const sprite = this.atlas.spriteDef('fx', effect.key);
        if (!sprite) continue;
        const frames = sprite.frames ?? 1;
        const uv = this.atlas.frame('fx', effect.key, Math.min(frames - 1, Math.floor(progress * frames)));
        if (!uv) continue;

        const [wx, wy] = Stage.worldFromTile(effect.x, effect.y);
        // Death flourishes and impacts belong on the ground, beneath the units
        // and towers: a wave's worth of them must never hide the board.
        const target = GROUND_FX.has(effect.key) ? ground : top;
        target.push(wx, wy, 0, effect.scale, uv);

        // A blast throws smoke as well as light. Effect objects are new per
        // event, so failing to find one in the WeakSet *is* the first sighting.
        if (!this._seenFx.has(effect)) {
          this._seenFx.add(effect);
          this._emitBlastSmoke(effect);
        }
        continue;
      }

      if (effect.kind === 'beam' || effect.kind === 'chain') {
        if (!beamUv) continue;
        const alpha = 1 - progress;
        // Tinted rather than coloured: the sprite is white, so the effect's own
        // colour rides in on the instance tint and one sprite serves them all.
        const c = this._beamColor.set(effect.color);
        const tint = [c.r * alpha, c.g * alpha, c.b * alpha];
        const thickness = effect.kind === 'beam' ? BEAM_WIDTH : CHAIN_WIDTH;
        const points = effect.points;
        for (let p = 0; p < points.length - 1; p += 1) {
          const [ax, ay] = Stage.worldFromTile(points[p][0], points[p][1]);
          const [bx, by] = Stage.worldFromTile(points[p + 1][0], points[p + 1][1]);
          const dx = bx - ax;
          const dy = by - ay;
          const len = Math.hypot(dx, dy);
          if (len < 1e-4) continue;
          // The quad is centred on the segment midpoint and rotated onto it, so
          // its local x axis spans the beam and its local y is the thickness.
          beams.push(
            (ax + bx) / 2,
            (ay + by) / 2,
            Math.atan2(dy, dx),
            len,
            beamUv,
            tint,
            thickness,
          );
        }
      }
      // 'text' effects are drawn by the DOM overlay, not here.
    }

    // Persistent beams: a laser mid-pulse keeps its line from the emitter to
    // the target rather than a one-shot flash, and the charge ramp widens and
    // brightens it so the player can see the damage climbing.
    for (const tower of world.towers.values()) {
      if (!tower.alive) continue;
      const target = tower.beamTarget;
      if (!target || !target.alive) continue;
      const [ax, ay] = Stage.worldFromTile(tower.x, tower.y);
      const [bx, by] = Stage.worldFromTile(target.x, target.y);
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-4) continue;
      const charge = tower.beamCharge ?? 0.0;
      const alpha = Math.min(0.95, 0.45 + charge * 0.16);

      // The beam's colour is the tower's rank badge: it walks the hue wheel as
      // the laser levels up, and the elite few levels stop holding still
      // altogether -- a fresh random hue every second, seeded by position and
      // the current second so each laser shimmers on its own beat.
      const level = tower.level;
      const maxLevel = world.leveling.max_level;
      let h;
      let s;
      if (level >= maxLevel - 2) {
        const second = Math.floor(world.time);
        h = (hashText(`${tower.tx},${tower.ty}:${second}`) % 360) / 360;
        s = 1.0;
      } else {
        h = ((350 + (level - 1) * 13) % 360) / 360;
        s = 0.95;
      }
      const c = this._beamColor.setHSL(h, s, 0.62);
      const tint = [c.r * alpha, c.g * alpha, c.b * alpha];
      beams.push(
        (ax + bx) / 2,
        (ay + by) / 2,
        Math.atan2(dy, dx),
        len,
        beamUv,
        tint,
        BEAM_WIDTH * (1.0 + charge * 0.35),
      );
    }

    ground.end();
    top.end();
    beams.end();
  }

  _syncOverlays(world, view) {
    const hover = view.hover;

    // Placement ghost.
    if (hover && view.placingKey) {
      const [tx, ty] = hover;
      const [ok] = view.placingKey === BARRACKS_KEY
        ? world.canPlaceBarracks(tx, ty)
        : world.canPlace(view.placingKey, tx, ty);
      const [wx, wy] = Stage.worldFromTile(tx + 0.5, ty + 0.5);
      const color = ok ? this._ghostOk : this._ghostBad;

      this.ghost.position.set(wx, wy, 0);
      this.ghost.material.color.copy(color);
      this.ghost.visible = true;

      this.ghostEdge.position.set(wx, wy, 0);
      this.ghostEdge.material.color.copy(color);
      this.ghostEdge.visible = true;
    } else {
      this.ghost.visible = false;
      this.ghostEdge.visible = false;
    }

    // Range ring: the selected structure, or a preview of what is being placed.
    let ringX = null;
    let ringY = null;
    let ringRange = 0;

    const selected = view.selected;
    if (selected && selected.alive) {
      ringX = selected.x;
      ringY = selected.y;
      // A barracks has no range, but it does have an aura, and showing it is the
      // only way the player can see what it is actually covering.
      ringRange = selected.kind === 'barracks' ? selected.radius : selected.range;
    } else if (hover && view.placingKey === BARRACKS_KEY) {
      // Previewing a barracks shows the aura it would provide, so the player can
      // judge placement before committing.
      const cfg = world.config.barracks;
      if (cfg) {
        const level = world.test.enabled ? world.test.barracksLevel ?? 1 : 1;
        ringX = hover[0] + 0.5;
        ringY = hover[1] + 0.5;
        ringRange = cfg.aura.radius + (level - 1) * cfg.aura.radius_per_level;
      }
    } else if (hover && view.placingKey) {
      const def = world.config.towers[view.placingKey];
      if (def) {
        // Preview the range the tower will *actually* have: level scaling plus
        // whatever the ground under the cursor grants. Moving the mouse across
        // a ridge visibly changes the circle, which is how the player learns
        // the terrain rule without being told.
        const level = world.test.enabled ? world.test.level : 1;
        const band = world.terrain.bandAt(hover[0], hover[1]);
        ringX = hover[0] + 0.5;
        ringY = hover[1] + 0.5;
        ringRange = Tower.statsAtLevel(def, level, world.leveling).range * band.tower.range;
      }
    }

    if (ringX !== null) {
      const [wx, wy] = Stage.worldFromTile(ringX, ringY);
      this.ring.position.set(wx, wy, 0);
      this.ring.scale.set(ringRange, ringRange, 1);
      this.ring.visible = true;
    } else {
      this.ring.visible = false;
    }
  }

  /**
   * Release every GPU resource this renderer owns.
   *
   * Switching maps builds a whole new renderer, and without this the previous
   * board mesh, instance buffers and generated sprite textures would stay
   * resident in the scene -- leaked silently, once per map change.
   */
  dispose() {
    for (const batch of [
      this.board,
      this.decor,
      this.links,
      this.shadows,
      this.fxGround,
      this.enemies,
      this.bars,
      this.shields,
      this.aircraftUnits,
      this.projectiles,
      this.towerBases,
      this.turrets,
      this.fxTop,
      this.beams,
    ]) {
      this.stage.scene.remove(batch.mesh);
      batch.dispose();
    }

    for (const particles of [this.particlesBack, this.particlesFront, this.weatherParticles]) {
      this.stage.scene.remove(particles.batch.mesh);
      particles.dispose();
    }

    this.stage.scene.remove(this.weatherWash);
    this.weatherWash.geometry.dispose();
    this.weatherWash.material.dispose();

    for (const overlay of [this.ghost, this.ghostEdge, this.ring]) {
      this.stage.scene.remove(overlay);
      overlay.geometry.dispose();
      overlay.material.dispose();
    }

    // Sprite sheets are generated per renderer, so they are ours to free.
    // One texture is shared by the ground and top fx batches, so guard the
    // double dispose rather than relying on it being harmless.
    const freed = new Set();
    for (const sheet of Object.values(this.sheets)) {
      if (sheet.texture && !freed.has(sheet.texture)) {
        freed.add(sheet.texture);
        sheet.texture.dispose();
      }
    }
  }
}
