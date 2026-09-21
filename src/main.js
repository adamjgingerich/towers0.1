/**
 * Bootstrap and glue.
 *
 * Owns the wiring: one World, one renderer, one overlay, one input handler, and
 * the single place where user intent turns into world mutations. Keeping the
 * "what should happen" decisions here means neither the UI nor the input layer
 * needs to know the rules.
 */

import { loadConfig, loadLevelIndex } from './data-loader.js';
import { Loop } from './loop.js';
import { MusicEngine } from './audio.js';
import { GameRenderer } from './render/renderer.js';
import { Stage } from './render/stage.js';
import { Grid } from './sim/grid.js';
import { BARRACKS_KEY } from './sim/barracks.js';
import { applySave, describeSave, serializeWorld, validateSave } from './sim/save.js';
import { Terrain } from './sim/terrain.js';
import { World } from './sim/world.js';
import { readSave, writeSave } from './storage.js';
import {
  UNLOCK_WAVE,
  blankPlayer,
  mapUnlocked,
  migrateLegacyBest,
  readActiveName,
  readRoster,
  sanitiseName,
  savePlayer,
  unlockedCount,
  writeActiveName,
  writeRoster,
} from './storage.js';
import { resolveMeta, skillCost, skillNode, skillUnlocked } from './sim/skills.js';
import { isShared, mergeRosters, pullRoster, pushPlayer, pushRoster } from './sync.js';
import { applyTheme, readTheme, writeTheme } from './themes.js';
import { FloatingText } from './ui/floating-text.js';
import { Input } from './ui/input.js';
import { Overlay } from './ui/overlay.js';
import { ViewControls } from './ui/view-controls.js';

const SEED = 12345;
const DEFAULT_MAP = 'level_01';
const DIFFICULTY_KEY = 'towers.difficulty';
const MUSIC_VOL_KEY = 'towers.musicVolume';
const SFX_VOL_KEY = 'towers.sfxVolume';
const SPEED_STEPS = [0.25, 0.5, 1, 2, 3, 4, 5];

/**
 * Remembered across sessions: nobody wants to re-pick it every reload.
 *
 * The `raw === null` check is load-bearing. `Number(null)` is `0`, so reading an
 * absent key straight into a number silently returns the *first* difficulty
 * instead of the configured default -- which is exactly how this shipped
 * opening on Relaxed when the data asks for Normal.
 */
function readDifficulty(fallback) {
  try {
    const raw = window.localStorage.getItem(DIFFICULTY_KEY);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persist a deliberate choice.
 *
 * Only ever called from the slider, never at boot: writing during startup would
 * create a preference out of the default and then treat it as the player's
 * choice forever after.
 */
function writeDifficulty(index) {
  try {
    window.localStorage.setItem(DIFFICULTY_KEY, String(index));
  } catch {
    // Private browsing.
  }
}

/** Volume is a preference, remembered the same way difficulty is. */
function readVolume(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  } catch {
    return fallback;
  }
}

function writeVolume(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Private browsing.
  }
}

class Game {
  constructor(config, stage, floatLayer) {
    this.config = config;
    this.stage = stage;
    this.mapId = DEFAULT_MAP;

    this.grid = Grid.fromText(config.waves.map);
    // One terrain, shared by the renderer and every world built from it.
    this.terrain = new Terrain(this.grid.width, this.grid.height, config.terrain, config.waves.map);
    stage.fitToGrid(this.grid, { defaultZoom: config.mapZoom });

    this.renderer = new GameRenderer(stage, config, this.grid, this.terrain);
    this.floats = new FloatingText(floatLayer, stage);
    this.viewControls = new ViewControls(stage);

    this.view = { hover: null, placingKey: null, selected: null, paused: false, linkingBase: null };

    /**
     * Characters and their per-map progress.
     *
     * Loaded here but shaped in `setLevels`, because the unlock rule needs the
     * level list and that arrives with the boot fetch. An empty name means the
     * name gate is showing and nothing is being recorded yet.
     */
    this.levels = [];
    this.roster = readRoster();
    this.playerName = readActiveName();
    /** Skill-tree wallet + owned ranks, and the buffs they resolve to. */
    this.metaState = { cores: 0, nodes: {} };
    this.meta = this.resolveMeta();
    /** Highest wave already written for the current map, so recording is
     *  per-wave rather than per-frame. */
    this._trackedWave = 0;
    /** Maps whose unlock has already been announced this session. */
    this._announcedUnlocks = new Set();

    this.gameOverShown = false;
    this._seenText = new WeakSet();

    /**
     * Test-mode settings belong to the session, not the run, so one object is
     * handed to every world and the settings survive a restart. Declared here
     * because newWorld() is what installs it.
     */
    this.test = { enabled: false, level: 1, barracksLevel: 1 };

    /**
     * Difficulty is a session setting like test mode, not run state: it is
     * chosen once, survives restarts and map changes, and is deliberately kept
     * out of the save file so loading a save cannot silently change how hard the
     * game is.
     */
    const levels = config.waves.difficulty.levels;
    this.difficultyIndex = Math.min(
      levels.length - 1,
      Math.max(0, readDifficulty(config.waves.difficulty.default)),
    );

    /** Colour theme, a preference remembered like difficulty and volume. */
    this.themeId = readTheme();
    applyTheme(this.themeId);

    this.world = this.newWorld();
    this.overlay = null;
    this.input = null;

    this.handlers = this._makeHandlers();
    // The loop reads the speed each frame and takes that many fixed steps, so
    // every speed runs the identical simulation -- see loop.js.
    this.loop = new Loop(
      (dt) => this.world.update(dt),
      (dtReal) => this.frame(dtReal),
      { speed: () => this.world.speedScale },
    );

    // Procedural chiptune, one theme per level. AudioContext refuses to start
    // before a user gesture, so the engine is armed on the first tap or keypress
    // and the level id decides the melody from then on.
    this.music = new MusicEngine();
    this.musicVolume = readVolume(MUSIC_VOL_KEY, 0.7);
    this.sfxVolume = readVolume(SFX_VOL_KEY, 0.5);
    this.music.setMusicVolume(this.musicVolume);
    this.music.setSfxVolume(this.sfxVolume);
    const unlockMusic = () => this.music.start(this.mapId);
    window.addEventListener('pointerdown', unlockMusic, { once: true });
    window.addEventListener('keydown', unlockMusic, { once: true });
  }

  newWorld() {
    // Battle-sfx bookkeeping is per run, reset here so a restart starts quiet.
    this._lastKills = 0;
    this._lastLeaks = 0;
    this._sfxCooldown = 0;
    const world = new World(this.config, this.config.waves.map, {
      seed: SEED,
      terrain: this.terrain,
      difficulty: this.difficultyLevel(),
      meta: this.meta,
    });
    // Same object every time, so the sandbox settings outlive a restart.
    world.test = this.test;
    /*
      Secret weapons are the character's, not the run's. A fresh world starts
      with an empty unlock set, so the drops this character already earned have
      to be handed over or a restart would take their guns away.
    */
    this.seedWeapons(world);
    /*
      A boss drop is recorded against the character the moment it happens rather
      than when the run ends: a run that is abandoned, reloaded or restarted
      still earned it, and losing a rare drop to a browser refresh would be the
      worst bug in this file.
    */
    world.onWeaponDropped = (key) => this.recordWeapon(key);
    return world;
  }

  /**
   * The selected difficulty, including the ramp length.
   *
   * `powerRampWaves` lives on the difficulty block rather than on each level, so
   * the two have to be put back together before the wave manager can use it.
   */
  difficultyLevel() {
    const block = this.config.waves.difficulty;
    const levels = block.levels;
    const index = Math.min(levels.length - 1, Math.max(0, this.difficultyIndex));
    this.difficultyIndex = index;
    return { ...levels[index], powerRampWaves: block.powerRampWaves };
  }

  /**
   * Push the current selection onto the live world.
   *
   * Used both at boot and when the slider moves, but says nothing and writes
   * nothing: boot must not manufacture a stored preference, and must not put a
   * "difficulty changed" line in the notes feed before the first wave.
   */
  applyDifficulty() {
    this.world.setDifficulty(this.difficultyLevel());
  }

  /** The player moved the slider: apply, announce, and remember. */
  setDifficulty(index) {
    this.difficultyIndex = index;
    const level = this.difficultyLevel();
    writeDifficulty(this.difficultyIndex);
    this.applyDifficulty();
    this.world.note(
      `Difficulty: ${level.name} — wave size x${level.size}, ` +
        `enemy power x${level.power}, growth x${level.growth} (from next wave)`,
    );
  }

  /** Change the colour theme, apply it, and remember it. */
  setTheme(id) {
    const theme = applyTheme(id);
    this.themeId = theme.id;
    writeTheme(theme.id);
    if (this.overlay) this.overlay.flash(`Theme: ${theme.name}`);
  }

  /**
   * The active character's record.
   *
   * Returns an empty record rather than null when no name is chosen, so every
   * caller can read `best` without a guard. Nothing is written back to it in
   * that state, which is what keeps "no character" from silently becoming one.
   */
  player() {
    if (!this.playerName) return blankPlayer('');
    return this.roster[this.playerName] ?? blankPlayer(this.playerName);
  }

  /**
   * Persist a change to the active character.
   *
   * Everything a character owns -- best waves, Cores, skill ranks, secret
   * weapons -- goes through here, so there is exactly one place that decides how
   * a record is written and one place to hook a shared store into later.
   */
  saveActive(patch) {
    if (!this.playerName) return;
    const saved = savePlayer(this.playerName, patch);
    if (saved) this.roster[this.playerName] = saved;
    // Fire-and-forget: sharing is a background nicety and the game keeps
    // playing whether or not it lands.
    if (saved && isShared()) {
      pushPlayer(saved).then((ok) => {
        this.sharedOnline = ok;
        this._scheduleShareRefresh();
      });
    }
  }

  /**
   * Pull the shared roster and fold it into this browser's copy.
   *
   * Never rejects and never blocks: `pullRoster` resolves to null on any
   * failure, which is treated as "no news" rather than "nobody exists". A
   * dropped connection must not be able to empty the character list.
   */
  async syncRoster() {
    if (!isShared()) return false;
    const rows = await pullRoster();
    if (rows === null) {
      this.sharedOnline = false;
      return false;
    }
    const { roster, changed } = mergeRosters(this.roster, rows);
    this.roster = roster;
    writeRoster(roster);
    this.sharedOnline = true;
    if (this.playerName) {
      this.loadActiveMeta();
      this.meta = this.resolveMeta();
    }
    // Characters this browser had but the shared store did not are uploaded, so
    // a player who started offline still appears to everyone else.
    const missing = Object.values(roster).filter((p) => !rows.some((r) => r.name === p.name));
    if (missing.length > 0) pushRoster(missing);
    if (changed.length > 0 && this.overlay) this.overlay.refreshRoster?.();
    return true;
  }

  /** Coalesce roster refreshes, so a busy wave does not hammer the overlay. */
  _scheduleShareRefresh() {
    if (this._shareTimer) return;
    this._shareTimer = setTimeout(() => {
      this._shareTimer = null;
      if (this.overlay) this.overlay.refreshRoster?.();
    }, 400);
  }

  /** Pull the active character's skill tree into the live state. */
  loadActiveMeta() {
    const record = this.roster[this.playerName];
    this.metaState = {
      cores: Math.max(0, Math.floor(Number(record?.cores) || 0)),
      nodes: { ...(record?.nodes ?? {}) },
    };
  }

  /**
   * Record that the active character has earned a secret weapon.
   *
   * Held on the character rather than in the run save, because the run save is
   * a single slot: two characters sharing one browser used to share one set of
   * drops, so a boss kill by either of them unlocked the gun for both.
   *
   * @returns {boolean} whether this was a new unlock
   */
  recordWeapon(key) {
    if (!this.playerName || !key) return false;
    const owned = this.player().weapons ?? [];
    if (owned.includes(key)) return false;
    this.saveActive({ weapons: [...owned, key] });
    return true;
  }

  /** Hand the active character's earned weapons to a freshly built world. */
  seedWeapons(world) {
    for (const key of this.player().weapons ?? []) {
      if (world.config.towers[key]) world.unlockedTowers.add(key);
    }
  }

  /** Furthest wave survived on a map by the active character. */
  bestFor(mapId = this.mapId) {
    return this.player().best?.[mapId] ?? 0;
  }

  /** Fold the owned skill ranks into the buff bag every world reads. */
  resolveMeta() {
    return resolveMeta(this.config.skills, this.metaState?.nodes ?? {});
  }

  /** Add Cores to the wallet and persist them. */
  addCores(n) {
    if (!this.playerName || n <= 0) return;
    this.metaState = this.metaState ?? { cores: 0, nodes: {} };
    this.metaState.cores += n;
    this.saveActive({ cores: this.metaState.cores, nodes: this.metaState.nodes });
  }

  /**
   * Buy one or more ranks of a skill, as far as the wallet allows.
   *
   * `count` exists because a five-rank node with a growing cost is a tedious
   * thing to buy one click at a time, and the buyer already knows how many they
   * want. Ranks are bought in order and the loop stops at the first one it
   * cannot afford, so a partial purchase still lands rather than failing whole.
   *
   * Buffs are mostly run-start values (coins, health, capacity, starting
   * level), so a purchase restarts the run rather than silently rewinding a
   * live board.
   *
   * @returns {[boolean, string]} ok, message
   */
  buySkill(id, count = 1) {
    if (!this.playerName) return [false, 'Choose a character first'];
    const node = skillNode(this.config.skills, id);
    if (!node) return [false, 'Unknown skill'];

    const nodes = this.metaState?.nodes ?? {};
    if (!skillUnlocked(node, this.config.skills, nodes)) {
      return [false, 'Locked — prerequisites missing'];
    }

    const wanted = Math.max(1, Math.min(Math.floor(count), node.maxRank));
    let rank = nodes[id] ?? 0;
    let bought = 0;

    while (bought < wanted && rank < node.maxRank) {
      const cost = skillCost(node, rank);
      if ((this.metaState?.cores ?? 0) < cost) break;
      this.metaState.cores -= cost;
      rank += 1;
      bought += 1;
    }

    if (bought === 0) {
      const cost = skillCost(node, rank);
      return [false, `Needs ${cost} Cores`];
    }

    this.metaState.nodes = { ...nodes, [id]: rank };
    this.saveActive({ cores: this.metaState.cores, nodes: this.metaState.nodes });
    this.meta = this.resolveMeta();
    this.restart();
    return [true, bought > 1
      ? `${node.name} — ${bought} ranks, now ${rank}/${node.maxRank}`
      : `${node.name} — rank ${rank}/${node.maxRank}`];
  }

  /** Everything the overlay needs to draw the tree. */
  skillProgress() {
    const nodes = this.metaState?.nodes ?? {};
    return {
      currency: this.config.skills.currency,
      branches: this.config.skills.branches,
      cores: this.metaState?.cores ?? 0,
      hasName: Boolean(this.playerName),
      nodes: this.config.skills.nodes.map((node) => ({
        ...node,
        rank: nodes[node.id] ?? 0,
        nextCost: skillCost(node, nodes[node.id] ?? 0),
        unlocked: skillUnlocked(node, this.config.skills, nodes),
      })),
    };
  }

  /** Where a map sits in the level list, or -1 if it is not in it. */
  mapIndex(mapId = this.mapId) {
    return this.levels.findIndex((level) => level.id === mapId);
  }

  isMapUnlocked(mapId) {
    const index = this.mapIndex(mapId);
    if (index < 0) return false;
    return mapUnlocked(this.levels, this.player().best, index);
  }

  /**
   * The map this one opens into, or null when it is still locked or absent.
   *
   * Derived from the recorded best rather than tracked as a separate flag, so
   * there is no second copy of "has the player earned this" to fall out of step.
   */
  nextMap() {
    const index = this.mapIndex();
    if (index < 0) return null;
    const next = this.levels[index + 1];
    if (!next) return null;
    if (!mapUnlocked(this.levels, this.player().best, index + 1)) return null;
    return { index: index + 1, id: next.id, name: next.name ?? next.id };
  }

  /** Everything the overlay needs to draw progression. */
  progress() {
    return {
      best: this.bestFor(),
      name: this.playerName,
      levels: this.levels,
      players: this.roster,
      roster: this.rosterList(),
      playerBest: this.player().best ?? {},
      weapons: this.player().weapons ?? [],
      activeMap: this.mapId,
      nextMap: this.nextMap(),
      skills: this.skillProgress(),
      /** Whether a shared store is configured, and whether it answered. */
      shared: isShared(),
      sharedOnline: this.sharedOnline === true,
    };
  }

  /**
   * Record a wave against the active character and the active map.
   * @returns {boolean} whether it beat the previous best
   */
  recordBest(wave) {
    if (!this.playerName) return false;
    const player = this.player();
    const previous = player.best?.[this.mapId] ?? 0;
    if (wave <= previous) return false;

    this.saveActive({
      best: { ...(player.best ?? {}), [this.mapId]: Math.floor(wave) },
    });
    return true;
  }

  /**
   * Every character this browser knows, newest activity first.
   *
   * Returned as a sorted array rather than the raw map because this is what the
   * roster list draws, and a list that reshuffles between frames is unreadable.
   */
  rosterList() {
    return Object.values(this.roster)
      .map((p) => ({ ...p, active: p.name === this.playerName }))
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }

  /**
   * Record the current wave as it advances.
   *
   * Not left until the run ends: the next map has to open the moment the unlock
   * wave is behind the player, because that is what makes the next-level button
   * appear mid-run. Guarded by the last recorded wave so this is one write per
   * wave rather than one per frame.
   */
  _trackProgress() {
    if (!this.playerName || this.test.enabled) return;
    const wave = this.world.wave;
    if (wave <= this._trackedWave) return;
    this._trackedWave = wave;
    if (this.recordBest(wave)) this._announceUnlock();
    /*
      Cores are the persistent currency and they are deliberately scarce: one
      drop every third wave, worth a little more on a harder difficulty and a
      little more as the run goes deeper. Paying out on EVERY wave (the previous
      rule) banked roughly 184 Cores for a wave-40 run against a tree that costs
      about 1100 to complete, so a player maxed the whole thing in seven runs and
      the tree stopped being a long-term goal. The same run now banks ~35, which
      puts a full clear somewhere around thirty runs.
    */
    if (wave % 3 === 0) {
      this.addCores(1 + Math.floor(this.difficultyIndex / 2) + Math.floor(wave / 20));
    }
  }

  /** Say it once, the first time a map's unlock wave is cleared. */
  _announceUnlock() {
    if (this._announcedUnlocks.has(this.mapId)) return;
    if (this.bestFor() < UNLOCK_WAVE) return;
    this._announcedUnlocks.add(this.mapId);

    const next = this.nextMap();
    if (next && this.overlay) this.overlay.flash(`${next.name} unlocked — open Maps`);
  }

  /**
   * Switch characters.
   *
   * A character owns their own map unlocks, so landing on a map the new name
   * has not earned would be unplayable. The run restarts on the furthest map
   * they *have* earned instead.
   */
  setPlayerName(raw) {
    const name = sanitiseName(raw);
    if (!name) return [false, 'Enter a name first'];

    this.playerName = name;
    writeActiveName(name);

    /*
      A brand new name starts from nothing, so it needs a record before anything
      reads it. `savePlayer` is a read-modify-write of the whole roster, so the
      fresh copy is loaded first -- writing straight from the in-memory map would
      persist whatever this tab last saw and could drop a character added in
      another tab.
    */
    this.roster = readRoster();
    if (!this.roster[name]) {
      const created = savePlayer(name, {});
      if (created) this.roster[name] = created;
    } else {
      savePlayer(name, {});
    }
    this.roster = readRoster();

    // A new character climbs the tree from nothing, like their map unlocks.
    this.metaState = { cores: 0, nodes: {} };
    this.loadActiveMeta();
    this.meta = this.resolveMeta();

    // The name gate is closed by the overlay on the next frame; reset the run
    // so it starts fresh on a map this character can actually reach.
    if (this.overlay) this.overlay.setMapsOpen(false);

    if (!this.isMapUnlocked(this.mapId)) {
      const reachable = unlockedCount(this.levels, this.player().best) - 1;
      const fallback = this.levels[reachable] ?? this.levels[0];
      if (fallback && fallback.id !== this.mapId) {
        this.goToMap(fallback.id);
        return [true, `Playing as ${name}`];
      }
    }

    this.restart();
    return [true, `Playing as ${name}`];
  }

  /** Move on to another map, keeping the character's progress. */
  goToMap(id) {
    if (this.overlay) this.overlay.setMapsOpen(false);
    if (id === this.mapId) return;

    this.setMap(id)
      .then(() => {
        if (!this.overlay) return;
        const level = this.levels.find((l) => l.id === id);
        this.overlay.flash(`Moved on to ${level?.name ?? id}`);
      })
      .catch((error) => {
        if (this.overlay) this.overlay.flash(`Could not load ${id}`);
        console.error(error);
      });
  }

  /** Called once the level index has loaded, since unlocking needs it. */
  setLevels(levels) {
    this.levels = Array.isArray(levels) ? levels : [];

    // Carry a pre-progression best wave onto the first map. Only fires when
    // there are no characters at all, so it cannot overwrite real progress.
    if (migrateLegacyBest(this.roster, this.levels[0]?.id)) writeRoster(this.roster);

    // A remembered name can be missing after storage is cleared, or if it was
    // created by a build with a different sanitiser.
    this.roster = readRoster();
    if (this.playerName && !this.roster[this.playerName]) {
      const created = savePlayer(this.playerName, {});
      if (created) this.roster[this.playerName] = created;
    }
    this.loadActiveMeta();
    this.meta = this.resolveMeta();
  }

  /**
   * Swap to another map.
   *
   * This rebuilds the whole render pipeline rather than just the world: the
   * tile grid feeds the static board batch and the camera fit, so a new map
   * means a new GameRenderer. The old one is disposed or its instance buffers
   * and generated sprite textures leak on every switch.
   */
  async setMap(id) {
    const config = await loadConfig(id);

    // Parse the map *before* tearing anything down, so a malformed map leaves
    // the current game running instead of half-swapped with no renderer.
    const grid = Grid.fromText(config.waves.map);

    this.renderer.dispose();
    this.config = config;
    this.mapId = id;
    this._trackedWave = 0;
    if (this.music) this.music.setTheme(id);

    this.grid = grid;
    this.terrain = new Terrain(grid.width, grid.height, config.terrain, config.waves.map);
    this.stage.fitToGrid(grid, { defaultZoom: config.mapZoom });
    this.renderer = new GameRenderer(this.stage, config, grid, this.terrain);
    this.world = this.newWorld();

    this.view.placingKey = null;
    this.view.selected = null;
    this.view.hover = null;
    this.gameOverShown = false;
    this._seenText = new WeakSet();

    this.floats.clear();
    this.stage.resetView();

    if (this.overlay) {
      this.overlay.setMapId(id);
      this.overlay.reset();
      this.overlay.update(this.world, this.view, this.progress());
    }
    this.stage.resize();
  }

  attach(overlay, input) {
    this.overlay = overlay;
    this.input = input;
  }

  start() {
    this.loop.start();
  }

  frame(dtReal) {
    // Ease the view first: picking and the DOM overlays both read the camera,
    // so it has to be settled before anything else runs this frame.
    this.stage.update(dtReal);

    // Progression is recorded as the run advances, not only when it ends.
    this._trackProgress();

    this.renderer.sync(this.world, this.view);
    this.floats.update(dtReal);
    this._emitFloatingText();
    if (this.overlay) this.overlay.update(this.world, this.view, this.progress());
    if (this.viewControls) this.viewControls.update();
    this._checkGameOver();
    this._emitBattleSfx(dtReal);
    this.stage.render();
  }

  /**
   * Quiet battle feedback: a soft thud per kill and a deeper one on a leak.
   *
   * Read from the run stats rather than an event stream, so it costs nothing
   * on a quiet board and works no matter how many sim steps ran this frame.
   * Rate-limited so a late-game clear is a low rumble, not a wall of noise.
   */
  _emitBattleSfx(dtReal) {
    const music = this.music;
    if (!music) return;
    const stats = this.world.stats;

    this._sfxCooldown = Math.max(0, this._sfxCooldown - dtReal);

    // A leak is always audible: it is the moment the run is being lost.
    if (stats.leaked > this._lastLeaks) {
      music.boom(1.5);
      this._lastLeaks = stats.leaked;
    }

    const kills = stats.kills;
    if (kills > this._lastKills && this._sfxCooldown <= 0) {
      const gained = kills - this._lastKills;
      music.boom(0.5 + Math.min(0.7, gained * 0.06));
      this._sfxCooldown = 0.09;
    }
    this._lastKills = kills;
  }

  /**
   * Turn new `Fx.text` effects into DOM popups.
   *
   * Effects live for several frames, so a WeakSet tracks which ones have been
   * emitted -- identity is the right key here, and it needs no cleanup.
   */
  _emitFloatingText() {
    // Floating numbers live in their own pool, so this is a short list rather
    // than a scan of every explosion on screen.
    const effects = this.world.texts;
    for (let i = 0; i < effects.length; i += 1) {
      const effect = effects[i];
      if (this._seenText.has(effect)) continue;
      this._seenText.add(effect);
      this.floats.emit(
        effect.label,
        effect.x,
        effect.y,
        effect.color,
        Math.max(0.45, effect.duration),
      );
    }
  }

  _checkGameOver() {
    if (!this.world.gameOver || this.gameOverShown) return;
    this.gameOverShown = true;
    this.view.placingKey = null;
    this.view.selected = null;

    // The wave was already recorded as the run advanced, so this only asks
    // whether the *final* wave was the record.
    const previous = this.bestFor();
    const isRecord = !this.test.enabled && this.world.wave > previous;
    if (isRecord) this.recordBest(this.world.wave);
    this._announceUnlock();

    if (this.music) this.music.stop();
    if (this.overlay) this.overlay.showGameOver(this.world, this.bestFor(), isRecord);
  }

  restart() {
    this.world = this.newWorld();
    this.view.placingKey = null;
    this.view.selected = null;
    this.view.paused = false;
    this.gameOverShown = false;
    this._seenText = new WeakSet();
    this.floats.clear();
    if (this.overlay) this.overlay.reset();
    if (this.music) {
      this.music.setTheme(this.mapId);
      this.music.resume();
    }
  }

  /**
   * Restart the current level.
   *
   * Confirms when there is a run worth losing, but never after a defeat -- the
   * defeat panel's "Play again" is the obvious way forward there, and a
   * confirmation on top of it would only be friction.
   *
   * @returns {boolean} false when the player backed out
   */
  restartLevel() {
    const atRisk = this.world.towers.size > 0 && !this.world.gameOver;
    if (atRisk && !window.confirm('Restart this level? The current run will be lost.')) {
      return false;
    }
    this.restart();
    return true;
  }

  // ---------------------------------------------------------------- saves

  /** @returns {[boolean, string]} ok, message */
  saveGame() {
    const data = serializeWorld(this.world, {
      mapId: this.mapId,
      testEnabled: this.test.enabled,
    });

    if (!writeSave(data)) return [false, 'Could not write the save'];

    this.refreshSaveInfo();
    return [true, `Saved — ${describeSave(data)}`];
  }

  /**
   * Restore the saved run.
   *
   * Validated first and rebuilt onto the saved map second, so a save naming a
   * deleted tower or map fails with a message instead of leaving a half-loaded
   * run behind.
   *
   * @returns {Promise<[boolean, string]>} ok, message
   */
  async loadGame() {
    const data = readSave();
    if (!data) return [false, 'No saved run'];

    try {
      validateSave(data, this.config);
    } catch (error) {
      return [false, error.message];
    }

    if (data.mapId && data.mapId !== this.mapId) {
      await this.setMap(data.mapId);
    }

    applySave(this.world, this.config, data);

    /*
      A save carries the towers that were unlocked during its run. Those were
      earned on this character, so loading a save adopts them rather than
      discarding them -- otherwise a weapon dropped in a run that was saved and
      resumed would vanish, and the shop would relock a tower the player is
      already using.
    */
    for (const key of this.world.unlockedTowers) this.recordWeapon(key);

    // The sandbox flag travels with the save, so a run built with free level-20
    // towers cannot be loaded as if it were legitimate.
    this.test.enabled = Boolean(data.testMode);

    this.view.placingKey = null;
    this.view.selected = null;
    this.view.hover = null;
    this.gameOverShown = Boolean(this.world.gameOver);
    this._seenText = new WeakSet();

    this.floats.clear();
    this.stage.resetView();

    if (this.overlay) {
      this.overlay.hideGameOver();
      this.overlay.update(this.world, this.view, this.progress());
    }

    return [true, `Loaded — ${describeSave(data)}`];
  }

  refreshSaveInfo() {
    if (!this.overlay) return;
    const data = readSave();
    this.overlay.setSaveInfo({
      exists: data !== null,
      savedAt: data ? data.savedAt : null,
      summary: data ? describeSave(data) : '',
    });
  }

  _makeHandlers() {
    const byHotkey = new Map();
    for (const key of this.config.towerKeys()) {
      const hotkey = this.config.towers[key].hotkey;
      if (hotkey) byHotkey.set(hotkey, key);
    }
    if (this.config.barracks?.hotkey) {
      byHotkey.set(this.config.barracks.hotkey, BARRACKS_KEY);
    }

    const togglePlacing = (key) => {
      this.view.selected = null;
      this.view.placingKey = this.view.placingKey === key ? null : key;
    };

    return {
      onHover: (tile) => {
        this.view.hover = tile;
      },

      onPrimary: (tile) => {
        const [tx, ty] = tile;

        // Linking mode: the next base clicked is the far end of the pathway.
        if (this.view.linkingBase) {
          const source = this.view.linkingBase;
          const target = this.world.structureAt(tx, ty);
          if (target && target.kind === 'barracks' && target !== source) {
            this.world.linkBases(source, target);
          }
          this.view.linkingBase = null;
          return;
        }

        const key = this.view.placingKey;

        if (key) {
          // Clicking an existing structure while placing inspects it rather than
          // rejecting the placement.
          const existing = this.world.structureAt(tx, ty);
          if (existing) {
            this.view.selected = existing;
            this.view.placingKey = null;
            return;
          }
          const [ok, reason] = key === BARRACKS_KEY
            ? this.world.placeBarracks(tx, ty, this.test.barracksLevel)
            : this.world.placeTower(key, tx, ty, this.test.level);
          if (!ok) {
            // A failed placement is a click that did nothing, so it also clears
            // the inspector: the player was aiming at the panel, not at the
            // board, and leaving the panel up would trap them.
            if (this.overlay) this.overlay.flash(reason);
            this.view.selected = null;
            return;
          }
          // One click, one tower. Staying armed after a build meant the next
          // click on a blank square built another tower instead of dismissing
          // the panel that had just appeared, so there was no way to close the
          // panel by clicking the board at all.
          this.view.placingKey = null;
          this.view.selected = this.world.structureAt(tx, ty);
          return;
        }

        // A blank square clears the selection, which is what closes the
        // inspector. Deliberately unconditional: clicking the board is the
        // dismiss gesture.
        this.view.selected = this.world.structureAt(tx, ty);
      },

      onCancel: () => {
        this.view.placingKey = null;
        this.view.selected = null;
        this.view.linkingBase = null;
      },

      // The inspector's own exits: its close button, and a click on the dark
      // margin or the page background. Same effect as Escape, which is what a
      // player reaching for "get rid of this" will try first.
      onDeselect: () => {
        this.view.placingKey = null;
        this.view.selected = null;
        this.view.linkingBase = null;
      },

      // Arm a supply link from the selected base. The next base clicked becomes
      // the other end of the pathway; clicking anything else cancels.
      onConnect: () => {
        const structure = this.view.selected;
        if (!structure || structure.kind !== 'barracks' || !structure.alive) {
          if (this.overlay) this.overlay.flash('Select a base first');
          return;
        }
        this.view.linkingBase = this.view.linkingBase === structure ? null : structure;
      },

      // Re-home one wing kind from the selected base to a linked base.
      onTransfer: (targetKey, kind) => {
        const source = this.view.selected;
        if (!source || source.kind !== 'barracks') return;
        const target = this.world.barracks.get(targetKey);
        if (!target) return;
        this.world.transferAircraft(source, target, kind);
      },

      onSelectTower: togglePlacing,
      onHotkey: (key) => {
        const towerKey = byHotkey.get(key);
        if (towerKey) togglePlacing(towerKey);
      },

      onUpgrade: () => {
        const structure = this.view.selected;
        if (!structure || !structure.alive) {
          if (this.overlay) this.overlay.flash('Select a tower first');
          return;
        }
        if (structure.kind === 'barracks') {
          if (this.overlay) this.overlay.flash('Base evolves by supporting towers');
          return;
        }
        const [ok, reason] = this.world.upgradeTower(structure);
        if (!ok && this.overlay) this.overlay.flash(reason);
      },

      onSell: () => {
        const structure = this.view.selected;
        if (!structure || !structure.alive) {
          if (this.overlay) this.overlay.flash('Select a tower first');
          return;
        }
        if (structure.kind === 'barracks') this.world.sellBarracks(structure);
        else this.world.sellTower(structure);
        this.view.selected = null;
      },

      onCycleTargeting: () => {
        const structure = this.view.selected;
        if (!structure || !structure.alive) {
          if (this.overlay) this.overlay.flash('Select a tower first');
          return;
        }
        // A barracks has nothing to aim.
        if (structure.kind === 'barracks') return;
        this.world.cycleTargeting(structure);
      },

      // Named onTogglePause, not onPause: the overlay's button has always
      // called onTogglePause while the keyboard called onPause, and because
      // only onPause existed the button threw on every click and silently did
      // nothing. One name, so the two can no longer drift apart.
      onTogglePause: () => {
        this.world.paused = !this.world.paused;
        this.view.paused = this.world.paused;
        if (this.music) {
          if (this.world.paused) this.music.suspend();
          else this.music.resume();
        }
      },

      onSpeed: (n) => {
        this.world.speedScale = n;
      },

      onSpeedDelta: (delta) => {
        const index = SPEED_STEPS.indexOf(this.world.speedScale);
        const next = Math.max(0, Math.min(SPEED_STEPS.length - 1, (index < 0 ? 0 : index) + delta));
        this.world.speedScale = SPEED_STEPS[next];
      },

      onMusicVolume: (v) => {
        this.musicVolume = Math.max(0, Math.min(1, v));
        this.music.setMusicVolume(this.musicVolume);
        writeVolume(MUSIC_VOL_KEY, this.musicVolume);
      },

      onSfxVolume: (v) => {
        this.sfxVolume = Math.max(0, Math.min(1, v));
        this.music.setSfxVolume(this.sfxVolume);
        writeVolume(SFX_VOL_KEY, this.sfxVolume);
      },

      onDifficulty: (index) => {
        this.setDifficulty(index);
      },

      onTheme: (id) => {
        this.setTheme(id);
      },

      onCallEarly: () => {
        this.world.waves.callEarly(this.world);
      },

      onTestToggle: (enabled) => {
        this.test.enabled = Boolean(enabled);
      },

      /** Level used for towers built from now on. */
      onTestLevel: (level) => {
        this.test.level = level;
      },

      /** Level applied to the currently selected tower. */
      onTestSetLevel: (level) => {
        const tower = this.view.selected;
        if (!tower || !tower.alive) {
          if (this.overlay) this.overlay.flash('Select a tower first');
          return;
        }
        if (tower.kind === 'barracks') {
          tower.setLevel(level, this.config.barracks.levels);
          // The sandbox sets a level, not a build. Taking every power the level
          // has earned is the only reading that shows the player what the
          // structure actually does at that level.
          tower.autoChoose(0);
          this.world.refreshSupport();
          this.world.refreshAircraft();
          return;
        }
        this.world.setTowerLevel(tower, level);
      },

      onChooseSpec: (optionKey) => {
        const tower = this.view.selected;
        if (!tower || !tower.alive) {
          if (this.overlay) this.overlay.flash('Select a tower first');
          return;
        }
        if (tower.kind === 'barracks') return;
        const [ok, reason] = this.world.chooseSpecialisation(tower, optionKey);
        if (!ok && this.overlay) this.overlay.flash(reason);
      },

      onChoosePower: (key) => {
        const structure = this.view.selected;
        if (!structure || structure.kind !== 'barracks') return;
        const [ok, message] = this.world.chooseBarracksPower(structure, key);
        if (this.overlay) {
          this.overlay.flash(ok ? `${structure.rankName} — ${message}` : message);
        }
      },

      onSelectMap: (id) => {
        // Test mode is a sandbox and deliberately ignores progression; a real
        // run has to respect it, or the unlock rule means nothing.
        if (!this.test.enabled && !this.isMapUnlocked(id)) {
          if (this.overlay) this.overlay.flash('That map is still locked');
          return;
        }
        this.goToMap(id);
      },

      onNextLevel: () => {
        const next = this.nextMap();
        if (!next) return;
        this.goToMap(next.id);
      },

      onToggleMaps: (open) => {
        if (this.overlay) this.overlay.setMapsOpen(open);
      },

      /**
       * Open the name gate.
       *
       * Clearing the active name is what shows it -- there is no separate
       * "asking" flag that could drift out of step with the stored one.
       */
      onEditName: () => {
        this.playerName = '';
        writeActiveName('');
        if (this.overlay) this.overlay.setMapsOpen(false);
      },

      onSetName: (name) => {
        const [, message] = this.setPlayerName(name);
        if (this.overlay) this.overlay.flash(message);
      },

      onSave: () => {
        const [, message] = this.saveGame();
        if (this.overlay) this.overlay.flash(message);
      },

      onLoad: () => {
        // Loading discards the current run, so make it a deliberate choice when
        // there is actually something to lose.
        const atRisk = this.world.towers.size > 0 && !this.world.gameOver;
        if (atRisk && !window.confirm('Load the saved run? The current run will be lost.')) {
          return;
        }

        this.loadGame()
          .then(([ok, message]) => {
            if (this.overlay) this.overlay.flash(message);
          })
          .catch((error) => {
            if (this.overlay) this.overlay.flash('Could not load the save');
            console.error(error);
          });
      },

      onRestart: () => this.restartLevel(),

      onSkills: () => {
        if (this.overlay) this.overlay.setSkillsOpen();
      },

      onSkillsClose: () => {
        if (this.overlay) this.overlay.setSkillsOpen(false);
      },

      onBuySkill: (id, count) => {
        const [, message] = this.buySkill(id, count);
        if (this.overlay) this.overlay.flash(message);
      },
    };
  }
}

function showFatal(error) {
  const node = document.getElementById('fatal');
  if (!node) return;
  node.hidden = false;
  const detail = node.querySelector('.fatal-detail');
  if (detail) detail.textContent = error && error.message ? error.message : String(error);
}

async function boot() {
  const canvas = document.getElementById('game');
  const board = document.getElementById('board');
  const area = document.getElementById('board-area');
  const floatLayer = document.getElementById('float-layer');

  if (!canvas || !board || !area || !floatLayer) {
    showFatal(new Error('page markup is missing expected elements'));
    return;
  }

  let config;
  try {
    config = await loadConfig(DEFAULT_MAP);
  } catch (error) {
    // The usual cause is opening index.html directly from disk, where fetch is
    // blocked by the browser. The panel explains that.
    showFatal(error);
    return;
  }

  // A missing level index is not fatal -- the sandbox simply has no map picker.
  let levels = [];
  try {
    levels = await loadLevelIndex();
  } catch {
    levels = [];
  }

  const stage = new Stage(canvas, board, area);
  const game = new Game(config, stage, floatLayer);
  // Unlocking needs the level list, and that arrives with this fetch.
  game.setLevels(levels);
  const overlay = new Overlay(config, game.handlers, levels);
  const input = new Input(stage, game.handlers);
  game.attach(overlay, input);
  overlay.setMapId(game.mapId);
  overlay.setDifficulty(game.difficultyIndex);
  overlay.setTheme(game.themeId);
  overlay.setVolumes({ music: game.musicVolume, sfx: game.sfxVolume });

  // A stored preference may point past the end of the level list if the data
  // changed, so push the clamped index onto the world too -- silently, because
  // nothing has changed yet from the player's point of view.
  game.applyDifficulty();

  overlay.update(game.world, game.view, game.progress());
  game.refreshSaveInfo();

  /*
    Fetch the shared roster after the game is running rather than before it.
    Sharing is optional, so boot must not wait on the network: the player gets a
    playable board immediately and the character list fills in a moment later if
    the shared store is configured and reachable.
  */
  game.syncRoster().then((ok) => {
    if (ok) overlay.update(game.world, game.view, game.progress());
  });

  // Fit again now the overlay has sized the shop bar and inspector. The first
  // fit ran before either had content, so it measured the wrong available
  // height and would leave the canvas stretched for the first frame or two
  // until the ResizeObserver caught up.
  stage.resize();

  game.start();

  // Handy from the devtools console while tuning.
  window.game = game;
}

boot();
