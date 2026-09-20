/**
 * All DOM UI: top status bar, tower shop, tower inspector, notes and the
 * defeat panel.
 *
 * The HUD is DOM rather than drawn into the canvas because three.js has no text
 * primitive, and because CSS handles the fiddly parts (crisp small text, hover
 * states, disabled buttons, scrolling notes) far better than a texture atlas
 * would.
 *
 * Every setter is change-guarded: writing textContent or toggling a class on
 * every frame would invalidate layout 60 times a second for values that change
 * once a wave.
 */

import { CLEARING, OVER, PREP, SPAWNING } from '../sim/wave_manager.js';
import { BARRACKS_KEY } from '../sim/barracks.js';
import { TARGETING_LABELS } from '../sim/tower.js';
import { UNLOCK_WAVE, mapUnlocked } from '../storage.js';
import { THEMES } from '../themes.js';

const SPEEDS = [0.25, 0.5, 1, 2, 3, 4, 5];

/**
 * Targeting reach badge for a tower button: which half of the enemy roster it
 * can hit. A glyph beats a word here because the badge is seven pixels tall,
 * and "both" has to be signified too, not just the two restricted cases.
 * `def` is a tower definition; a placed tower's *current* state (after a
 * specialisation lifts a restriction) is rendered separately in the inspector.
 */
const REACH_BADGES = {
  gnd: { cls: 'treach gnd', glyph: '\u25BC', title: 'Cannot target flying enemies' },
  aa: { cls: 'treach aa', glyph: '\u25B2', title: 'Cannot target ground enemies' },
  both: { cls: 'treach both', glyph: '\u25B2\u25BC', title: 'Targets ground and air' },
};

function reachBadge(def) {
  if (def.ground_only) return REACH_BADGES.gnd;
  if (def.air_only) return REACH_BADGES.aa;
  return REACH_BADGES.both;
}

export class Overlay {
  /**
   * @param {object} callbacks
   *  onSelectTower(key) onUpgrade() onSell() onCycleTargeting()
   *  onSpeed(n) onTogglePause() onCallEarly() onRestart() onDeselect()
   *  onChoosePower(key)
   */
  constructor(config, callbacks, levels = []) {
    this.config = config;
    this.cb = callbacks;
    /** Playable levels for the test-mode map picker. */
    this.levels = levels;
    this.mapId = null;

    const $ = (id) => document.getElementById(id);
    this.el = {
      wave: $('stat-wave'),
      coins: $('stat-coins'),
      base: $('stat-base'),
      towers: $('stat-towers'),
      dps: $('stat-dps'),
      kills: $('stat-kills'),
      phase: $('phase'),
      early: $('btn-early'),
      pause: $('btn-pause'),
      speeds: $('speeds'),
      shop: $('shop'),
      preview: $('wave-preview'),
      inspector: $('inspector'),
      notes: $('notes'),
      gameover: $('gameover'),
      gameoverBody: $('gameover-body'),
      restart: $('btn-restart'),
      best: $('stat-best'),
      shopBar: $('shop-bar'),
      btnTest: $('btn-test'),
      btnFullscreen: $('btn-fullscreen'),
      testPanel: $('test-panel'),
      testClose: $('btn-test-close'),
      testBuildLevels: $('test-build-levels'),
      testMaps: $('test-maps'),
      testTowerGroup: $('test-tower-group'),
      testTowerLabel: $('test-tower-label'),
      testTowerLevels: $('test-tower-levels'),
      btnSave: $('btn-save'),
      btnLoad: $('btn-load'),
      btnRestartRun: $('btn-restart-run'),
      difficulty: $('difficulty'),
      difficultyRange: $('difficulty-range'),
      difficultyName: $('difficulty-name'),
      musicVol: $('volume-music-range'),
      sfxVol: $('volume-sfx-range'),
      pausedBadge: $('paused-badge'),
      btnMaps: $('btn-maps'),
      mapPanel: $('map-panel'),
      mapClose: $('btn-maps-close'),
      mapList: $('map-list'),
      mapHint: $('map-hint'),
      btnPlayer: $('btn-player'),
      playerName: $('player-name'),
      nextLevel: $('next-level'),
      nextLevelName: $('next-level-name'),
      nextLevelHint: $('next-level-hint'),
      nameGate: $('name-gate'),
      nameInput: $('name-input'),
      nameGo: $('btn-name-go'),
      nameExisting: $('name-existing'),
      nameExistingLabel: $('name-existing-label'),
      weatherBadge: $('weather-badge'),
      weatherName: $('weather-name'),
      weatherEffects: $('weather-effects'),
      btnSkills: $('btn-skills'),
      skillsPanel: $('skills-panel'),
      skillsList: $('skills-list'),
      skillsCores: $('skills-cores'),
      skillsHint: $('skills-hint'),
      btnSkillsClose: $('btn-skills-close'),
      themeSelect: $('theme-select'),
    };

    this.shopButtons = new Map();
    this.inspectorButtons = {};
    this._last = {};
    this._lastNotes = -1;
    /** Mirrors world.test.enabled so the toggle knows which way to flip. */
    this._testEnabled = false;
    /** Signature of the specialisation choices currently rendered. */
    this._specSig = null;
    /** Signature of the map list, so it is rebuilt only when it changes. */
    this._mapSig = null;
    /** Signature of the rendered skill list, rebuilt only when it changes. */
    this._skillsSig = null;

    this._buildShop();
    this._buildSpeeds();
    this._buildThemes();
    this._buildDifficulty();
    this._buildInspector();
    this._buildTest();
    this._buildMaps();
    this._buildSkills();
    this._buildNameGate();
    this._wire();
  }

  _buildShop() {
    const shop = this.el.shop;
    shop.innerHTML = '';

    // Barracks lead, because they set the ceiling on everything after them.
    const barracks = this.config.barracks;
    if (barracks) {
      const button = document.createElement('button');
      button.className = 'shop-item barracks';
      button.type = 'button';
      button.title = barracks.description;

      const hotkey = document.createElement('span');
      hotkey.className = 'hotkey';
      hotkey.textContent = barracks.hotkey ?? 'b';

      const name = document.createElement('span');
      name.className = 'tname';
      name.textContent = barracks.name;

      const cost = document.createElement('span');
      cost.className = 'tcost';
      cost.textContent = String(barracks.cost);

      button.append(hotkey, name, cost);
      button.addEventListener('click', () => this.cb.onSelectTower(BARRACKS_KEY));
      shop.appendChild(button);
      this.barracksButton = { button, cost };
    }

    // Price order, low to high. The boss-drop slots come last as dark "?"
    // mystery buttons that light up and take the weapon's identity when its
    // boss is felled.
    const keys = this.config.towerKeys();
    const byCost = (a, b) => this.config.towers[a].cost - this.config.towers[b].cost;
    const regular = keys.filter((key) => !this.config.towers[key].boss_drop).sort(byCost);

    for (const key of regular) this._addShopItem(shop, key, false);
    for (const key of this.config.dropTowers()) this._addShopItem(shop, key, true);
  }

  /** One shop button. `drop` buttons start as unlit mystery slots. */
  _addShopItem(shop, key, drop) {
    const def = this.config.towers[key];

    const button = document.createElement('button');
    button.className = 'shop-item';
    button.type = 'button';
    button.title = def.description || def.name;

    const hotkey = document.createElement('span');
    hotkey.className = 'hotkey';
    hotkey.textContent = def.hotkey ?? '';

    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = def.name;

    // A weapon that cannot shoot at half the enemies is a very different buy,
    // so the restriction travels with the price rather than living only in the
    // tooltip: a down-arrow for ground-only, an up-arrow for air-only, and both
    // for a tower that can hit either.
    const reach = document.createElement('span');
    const badge = reachBadge(def);
    reach.className = badge.cls;
    reach.textContent = badge.glyph;
    reach.title = badge.title;

    const cost = document.createElement('span');
    cost.className = 'tcost';
    cost.textContent = def.cost.toFixed(0);

    button.append(hotkey, name, reach, cost);
    button.addEventListener('click', () => this.cb.onSelectTower(key));

    if (drop) {
      button.classList.add('mystery');
      button.disabled = true;
      button.title = 'A felled boss drops a weapon here';
      hotkey.textContent = '?';
      name.textContent = '???';
      cost.textContent = '';
      reach.className = '';
      reach.textContent = '';
      reach.removeAttribute('title');
    }

    shop.appendChild(button);
    this.shopButtons.set(key, { button, hotkey, name, reach, cost, def, drop });
  }

  _buildSpeeds() {
    this.el.speeds.innerHTML = '';
    this.speedButtons = new Map();

    for (const speed of SPEEDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${speed}x`;
      button.addEventListener('click', () => this.cb.onSpeed(speed));
      this.el.speeds.appendChild(button);
      this.speedButtons.set(speed, button);
    }
  }

  /**
   * Difficulty slider.
   *
   * The stops come from data rather than being hard-coded, so adding a level to
   * `data/waves.json` needs no UI change. The numbers behind the selected level
   * go into the title rather than the label: a player wants to know *what*
   * changed, but the bar needs to stay narrow enough to sit in the top bar.
   */
  _buildDifficulty() {
    const range = this.el.difficultyRange;
    if (!range) return;

    this._difficultyLevels = this.config.waves.difficulty.levels;
    range.min = '0';
    range.max = String(Math.max(0, this._difficultyLevels.length - 1));
    range.step = '1';
    range.addEventListener('input', () => {
      const index = Number(range.value);
      this._setDifficultyLabel(this._difficultyLevels[index]);
      this.cb.onDifficulty(index);
    });

    this.setDifficulty(this.config.waves.difficulty.default);
  }

  /** Reflect an externally-chosen difficulty without re-firing the callback. */
  setDifficulty(index) {
    const levels = this._difficultyLevels ?? this.config.waves.difficulty.levels;
    const clamped = Math.min(levels.length - 1, Math.max(0, Number(index) || 0));
    if (this.el.difficultyRange) this.el.difficultyRange.value = String(clamped);
    this._setDifficultyLabel(levels[clamped]);
  }

  /** Sync the audio sliders with the volumes chosen at boot. */
  setVolumes({ music = 0.7, sfx = 0.5 } = {}) {
    if (this.el.musicVol) this.el.musicVol.value = String(Math.round(music * 100));
    if (this.el.sfxVol) this.el.sfxVol.value = String(Math.round(sfx * 100));
  }

  _setDifficultyLabel(level) {
    if (!level) return;
    this._set(this.el.difficultyName, level.name);
    if (this.el.difficulty) {
      const ramp = this.config.waves.difficulty.powerRampWaves;
      // The ramp matters to the player: it explains why a harder setting does not
      // make the first ten waves harder, which is deliberate.
      const rampNote = level.power > 1 && ramp > 1
        ? `, ramping in over the first ${ramp} waves`
        : '';
      this.el.difficulty.title =
        `${level.name} — wave size ×${level.size}, ` +
        `enemy power ×${level.power}${rampNote}, growth ×${level.growth}`;
    }
  }

  _buildInspector() {
    const inspector = this.el.inspector;
    inspector.innerHTML = `
      <div class="ins-head">
        <span class="ins-name"></span>
        <span class="ins-level"></span>
        <button type="button" class="ins-close" title="Close (Esc)" aria-label="Close">&times;</button>
      </div>
      <dl class="ins-stats"></dl>
      <div class="ins-progress" hidden>
        <div class="ip-head">
          <span class="ip-label">Evolution</span>
          <span class="ip-pct"></span>
        </div>
        <div class="ip-track"><div class="ip-fill"></div></div>
        <div class="ip-pips"></div>
      </div>
      <div class="ins-specs"></div>
      <div class="ins-spec-choices" hidden>
        <div class="spec-title"></div>
      </div>
      <div class="ins-links" hidden></div>
      <div class="ins-actions">
        <button type="button" class="ins-upgrade"></button>
        <button type="button" class="ins-target"></button>
        <button type="button" class="ins-sell"></button>
      </div>
    `;

    this.inspectorButtons = {
      name: inspector.querySelector('.ins-name'),
      level: inspector.querySelector('.ins-level'),
      stats: inspector.querySelector('.ins-stats'),
      specs: inspector.querySelector('.ins-specs'),
      specChoices: inspector.querySelector('.ins-spec-choices'),
      specTitle: inspector.querySelector('.spec-title'),
      links: inspector.querySelector('.ins-links'),
      progress: inspector.querySelector('.ins-progress'),
      progressFill: inspector.querySelector('.ip-fill'),
      progressPct: inspector.querySelector('.ip-pct'),
      progressPips: inspector.querySelector('.ip-pips'),
      progressLabel: inspector.querySelector('.ip-label'),
      upgrade: inspector.querySelector('.ins-upgrade'),
      target: inspector.querySelector('.ins-target'),
      sell: inspector.querySelector('.ins-sell'),
      close: inspector.querySelector('.ins-close'),
    };

    this.inspectorButtons.close.addEventListener('click', () => this.cb.onDeselect());
    this.inspectorButtons.upgrade.addEventListener('click', () => this.cb.onUpgrade());
    this.inspectorButtons.target.addEventListener('click', () => this.cb.onCycleTargeting());
    this.inspectorButtons.sell.addEventListener('click', () => this.cb.onSell());

    this._bindDismiss();
  }

  /**
   * Dismiss the inspector from anywhere that is neither the board nor a control.
   *
   * The inspector has to be closable by the same instinct that opened it -- a
   * click on empty space -- or it becomes something the player has to hunt for a
   * way out of. Three surfaces count as "empty space": a blank board tile, the
   * dark margin beside a zoomed-out board, and the page background. The board is
   * `Input`'s to interpret (it has to distinguish a blank tile from a structure),
   * so it is excluded here and only the other two are handled.
   *
   * Whichever element the click lands on, the rule is the same: if it is not part
   * of a control, close the panel.
   */
  _bindDismiss() {
    // Anything inside one of these is a deliberate act, not a click on the
    // background, and must not close the panel out from under the player.
    const LIVE_SURFACES = [
      '#inspector', '#topbar', '#shop-bar', '#shop', '#map-panel',
      '#test-panel', '#skills-panel', '#name-gate', '#gameover', '#next-level',
    ].join(',');

    document.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // The canvas is Input's, and it already resolves a click into "this tower"
      // or "blank tile". Acting on it here would clear the selection that click
      // had just made.
      if (target instanceof HTMLCanvasElement) return;
      if (target.closest(LIVE_SURFACES)) return;
      this.cb.onDeselect();
    });
  }

  /**
   * Test-mode panel: a toggle plus two level strips -- one for towers built
   * from now on, one for the tower currently selected.
   *
   * The strips are generated from `max_level` rather than hard-coded, so
   * raising the cap in data/waves.json adds buttons here for free.
   */
  _buildTest() {
    const maxLevel = this.config.waves.leveling.max_level;

    const buildStrip = (container, onPick) => {
      for (let level = 1; level <= maxLevel; level += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(level);
        button.title = `Level ${level}`;
        button.addEventListener('click', () => onPick(level));
        container.appendChild(button);
      }
    };

    buildStrip(this.el.testBuildLevels, (level) => this.cb.onTestLevel(level));
    buildStrip(this.el.testTowerLevels, (level) => this.cb.onTestSetLevel(level));

    this.el.btnTest.addEventListener('click', () => this.cb.onTestToggle(!this._testEnabled));
    this.el.testClose.addEventListener('click', () => this.cb.onTestToggle(false));

    // Map picker. Only meaningful in test mode, since a normal run always
    // starts on level 1.
    this.mapButtons = new Map();
    for (const level of this.levels) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tp-map';
      button.textContent = level.name ?? level.id;
      button.title = level.description ?? level.id;
      button.addEventListener('click', () => this.cb.onSelectMap(level.id));
      this.el.testMaps.appendChild(button);
      this.mapButtons.set(level.id, button);
    }
  }

  /** Told by the host whenever the active map changes. */
  setMapId(id) {
    this.mapId = id;
  }

  /**
   * The map list, and the character who owns the progress in it.
   *
   * Separate from the test-mode picker on purpose: test mode is a sandbox and
   * deliberately ignores progression, whereas this one is the real gate and
   * shows exactly what the character has earned.
   */
  _buildMaps() {
    this.mapRows = new Map();
    this.el.mapList.innerHTML = '';
    this.el.btnMaps.addEventListener('click', () => this.setMapsOpen());
    this.el.mapClose.addEventListener('click', () => this.setMapsOpen(false));
    this.el.btnPlayer.addEventListener('click', () => this.cb.onEditName());
    this.el.nextLevel.addEventListener('click', () => this.cb.onNextLevel());
  }

  /**
   * Show or hide the map panel.
   *
   * Passing a boolean sets it, passing nothing toggles. The test panel owns the
   * same corner of the board, so opening one closes the other rather than
   * leaving two panels stacked on top of each other.
   */
  setMapsOpen(open) {
    const next = typeof open === 'boolean' ? open : this.el.mapPanel.hidden;
    this.el.mapPanel.hidden = !next;
    if (!next) return;
    // Rebuilt on open, so the list is never stale from an earlier session of
    // play or from a map that unlocked while the panel was shut.
    this._mapSig = null;
    if (this._testEnabled) this.cb.onTestToggle(false);
  }

  /**
   * The persistent skill tree.
   *
   * Wired once here; the list itself is rebuilt by `_updateSkills` whenever the
   * wallet or the owned ranks change, because that is what a purchase touches.
   */
  _buildSkills() {
    this.el.btnSkills.addEventListener('click', () => this.cb.onSkills());
    this.el.btnSkillsClose.addEventListener('click', () => this.cb.onSkillsClose());
  }

  /** Populate the theme dropdown from the theme data, grouped by category. */
  _buildThemes() {
    const select = this.el.themeSelect;
    if (!select) return;
    const groups = new Map();
    for (const theme of THEMES) {
      const key = theme.group ?? 'Themes';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(theme);
    }
    for (const [group, themes] of groups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group;
      for (const theme of themes) {
        const option = document.createElement('option');
        option.value = theme.id;
        option.textContent = theme.name;
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }
    select.addEventListener('change', () => this.cb.onTheme(select.value));
  }

  /** Reflect the active theme in the dropdown without re-firing the callback. */
  setTheme(id) {
    if (this.el.themeSelect) this.el.themeSelect.value = id;
  }

  /**
   * Show or hide the skill tree.
   *
   * Passing a boolean sets it, passing nothing toggles. It shares the corner
   * with the map and test panels, so opening one closes the others.
   */
  setSkillsOpen(open) {
    const next = typeof open === 'boolean' ? open : this.el.skillsPanel.hidden;
    this.el.skillsPanel.hidden = !next;
    if (!next) return;
    this._skillsSig = null;
    this.setMapsOpen(false);
    if (this._testEnabled) this.cb.onTestToggle(false);
  }

  /**
   * Render the tree, but only when something it shows has changed.
   *
   * The list is rebuilt rather than patched because a purchase can flip any
   * node between locked, affordable and maxed at once, and diffing that by hand
   * is where stale-node bugs live.
   */
  _updateSkills(skills) {
    const panel = this.el.skillsPanel;
    if (!panel || panel.hidden) return;

    const nodes = skills?.nodes ?? [];
    const branches = skills?.branches ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const sig = `${skills?.cores ?? 0}:${skills?.hasName ? 1 : 0}:`
      + nodes.map((n) => `${n.id}:${n.rank}:${n.unlocked ? 1 : 0}`).join('|');
    if (sig === this._skillsSig) return;
    this._skillsSig = sig;

    this._set(this.el.skillsCores, String(skills?.cores ?? 0));
    this._set(this.el.skillsHint, skills?.hasName
      ? 'Earned every wave you survive, on every map. Buffs apply from the next run.'
      : 'Choose a character first — the tree belongs to a character.');

    const list = this.el.skillsList;
    list.innerHTML = '';

    for (const node of nodes) {
      const branch = branches.find((b) => b.key === node.branch);
      const color = branch?.color ?? '#ffffff';
      const maxed = node.rank >= node.maxRank;

      const row = document.createElement('div');
      row.className = 'skill-node';
      row.style.setProperty('--branch', color);
      if (!node.unlocked && !maxed) row.classList.add('locked');
      if (maxed) row.classList.add('maxed');

      const name = document.createElement('div');
      name.className = 'skill-name';
      const label = document.createElement('span');
      label.textContent = node.name;
      const tag = document.createElement('span');
      tag.className = 'skill-branch';
      tag.textContent = branch?.name ?? '';
      name.append(label, tag);
      row.appendChild(name);

      const pips = document.createElement('span');
      pips.className = 'skill-pips';
      for (let i = 0; i < node.maxRank; i += 1) {
        const pip = document.createElement('span');
        pip.className = 'skill-pip';
        if (i < node.rank) pip.classList.add('on');
        pips.appendChild(pip);
      }
      row.appendChild(pips);

      const desc = document.createElement('div');
      desc.className = 'skill-desc';
      desc.textContent = node.desc;
      row.appendChild(desc);

      const buy = document.createElement('button');
      buy.type = 'button';
      buy.className = 'skill-buy';
      if (maxed) {
        buy.textContent = 'Maxed';
        buy.disabled = true;
      } else if (!node.unlocked) {
        const missing = node.requires
          .filter((id) => (byId.get(id)?.rank ?? 0) < 1)
          .map((id) => byId.get(id)?.name ?? id);
        buy.textContent = 'Locked';
        buy.disabled = true;
        desc.textContent = missing.length > 0
          ? `${node.desc} Requires: ${missing.join(', ')}.`
          : node.desc;
      } else {
        buy.textContent = `\u25C6 ${node.nextCost}`;
        buy.title = `Buy the next rank for ${node.nextCost} Cores`;
        buy.disabled = (skills?.cores ?? 0) < node.nextCost;
        buy.addEventListener('click', () => this.cb.onBuySkill(node.id));
      }
      row.appendChild(buy);

      list.appendChild(row);
    }
  }

  /** Name entry. Existing characters are offered rather than retyped. */
  _buildNameGate() {
    const submit = () => this.cb.onSetName(this.el.nameInput.value);
    this.el.nameGo.addEventListener('click', submit);
    this.el.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }

  /**
   * Offer every character already on this machine.
   *
   * Rebuilt only when the gate opens, because the set of names changes rarely
   * and this is the one screen where a stale list would be actively confusing.
   */
  _showNameGate(progress) {
    const names = Object.keys(progress.players ?? {}).sort();
    const container = this.el.nameExisting;
    container.innerHTML = '';
    this.el.nameExistingLabel.hidden = names.length === 0;

    for (const name of names) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.addEventListener('click', () => this.cb.onSetName(name));
      container.appendChild(button);
    }

    if (names.length > 0 && !this.el.nameInput.value) {
      this.el.nameInput.value = names[0] === 'Default' ? '' : names[0];
    }
    this.el.nameInput.focus();
  }

  _updatePlayer(progress) {
    const name = progress.name || '—';
    this._set(this.el.playerName, name);
    this.el.btnPlayer.title = progress.name
      ? `${progress.name} — click to switch character`
      : 'Choose a character';

    const needName = !progress.name;
    const gate = this.el.nameGate;
    if (gate.hidden !== !needName) {
      gate.hidden = !needName;
      // Built on open, never per frame: rebuilding the list would steal focus
      // and wipe whatever the player has already typed.
      if (needName) this._showNameGate(progress);
    }
  }

  _updateMaps(progress) {
    const levels = progress.levels ?? [];
    const best = progress.playerBest ?? {};
    const inTest = Boolean(progress.testMode);

    // Signature covers everything a row draws, so the list is rebuilt only when
    // something it displays actually changes.
    const sig = levels
      .map((level) => `${level.id}:${best[level.id] ?? 0}:${mapUnlocked(levels, best, levels.indexOf(level)) ? 1 : 0}`)
      .join('|') + `#${progress.activeMap}#${inTest ? 1 : 0}`;

    if (sig !== this._mapSig) {
      this._mapSig = sig;
      this.mapRows = new Map();
      this.el.mapList.innerHTML = '';

      for (let i = 0; i < levels.length; i += 1) {
        const level = levels[i];
        const open = mapUnlocked(levels, best, i);
        const wave = best[level.id] ?? 0;
        const cleared = wave >= UNLOCK_WAVE;

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'map-row';
        if (open) row.classList.add('open');
        if (level.id === progress.activeMap) row.classList.add('active');
        row.disabled = !open;
        row.title = level.description ?? level.id;

        const mark = document.createElement('span');
        mark.className = 'mr-mark';
        mark.textContent = open ? (cleared ? '★' : '◆') : '·';

        const name = document.createElement('span');
        name.className = 'mr-name';
        const label = document.createElement('span');
        label.textContent = level.name ?? level.id;
        name.appendChild(label);
        if (!open) {
          // Say what is missing rather than just refusing: the reason is the
          // only thing that tells the player what to do next.
          const why = document.createElement('span');
          why.className = 'mr-why';
          const previous = levels[i - 1];
          why.textContent = `Reach wave ${UNLOCK_WAVE} on ${previous?.name ?? previous?.id ?? 'the map before'}`;
          name.appendChild(why);
        }

        const score = document.createElement('span');
        score.className = 'mr-best';
        score.textContent = wave > 0 ? `${wave}` : '—';

        row.append(mark, name, score);
        if (open) row.addEventListener('click', () => this.cb.onSelectMap(level.id));
        this.el.mapList.appendChild(row);
        this.mapRows.set(level.id, row);
      }
    }

    // "No next map" and "next map still locked" are different states, and
    // `nextMap` is null for both -- so whether a next level *exists* has to be
    // read off the list rather than inferred from the unlock.
    const activeIndex = levels.findIndex((level) => level.id === progress.activeMap);
    const hasNext = activeIndex >= 0 && activeIndex + 1 < levels.length;
    this._set(
      this.el.mapHint,
      hasNext
        ? `${UNLOCK_WAVE} waves opens the next map. Any map you have opened can be played for as long as you survive.`
        : `${UNLOCK_WAVE} waves opens the next map. This is the last one.`,
    );
  }

  /**
   * The next-level button.
   *
   * Appears the moment the unlock wave is behind the player rather than at
   * defeat, because the run does not end at 50 -- going on is a choice, and the
   * button is how it is offered. Hidden whenever the next map is not open, so
   * its presence itself means "you have earned something".
   */
  _updateNextLevel(progress) {
    const next = progress.nextMap;
    const show = Boolean(next && progress.wave >= UNLOCK_WAVE);
    const el = this.el.nextLevel;

    if (el.hidden !== !show) el.hidden = !show;
    if (!show) return;

    this._set(this.el.nextLevelName, next.name ?? next.id);
    this._set(this.el.nextLevelHint, `wave ${UNLOCK_WAVE} reached · keep playing or move on`);
    el.title = `Move on to ${next.name ?? next.id}. Your best on this map is already recorded.`;
  }

  _updateTest(world, view) {
    const on = world.test.enabled;
    this._testEnabled = on;

    if (this.el.testPanel.hidden !== !on) this.el.testPanel.hidden = !on;
    if (this.el.btnTest.classList.contains('active') !== on) {
      this.el.btnTest.classList.toggle('active', on);
    }
    if (this.el.shopBar.classList.contains('test') !== on) {
      this.el.shopBar.classList.toggle('test', on);
    }

    // The strips only mean anything while the sandbox is on.
    if (!on) return;

    this._markLevel(this.el.testBuildLevels, world.test.level);

    for (const [id, button] of this.mapButtons) {
      const active = id === this.mapId;
      if (button.classList.contains('active') !== active) {
        button.classList.toggle('active', active);
      }
    }

    const tower = view.selected;
    const hasTower = Boolean(tower) && tower.alive;
    if (this.el.testTowerGroup.hidden !== !hasTower) {
      this.el.testTowerGroup.hidden = !hasTower;
    }
    if (hasTower) {
      this._set(this.el.testTowerLabel, `Selected \u2014 ${tower.d.name}`);
      this._markLevel(this.el.testTowerLevels, tower.level);
    }
  }

  /** Highlight the chosen level in a strip, touching only what changed. */
  _markLevel(container, active) {
    const buttons = container.children;
    for (let i = 0; i < buttons.length; i += 1) {
      const isActive = i + 1 === active;
      if (buttons[i].classList.contains('active') !== isActive) {
        buttons[i].classList.toggle('active', isActive);
      }
    }
  }

  _wire() {
    this.el.early.addEventListener('click', () => this.cb.onCallEarly());
    this.el.pause.addEventListener('click', () => this.cb.onTogglePause());
    this.el.restart.addEventListener('click', () => this.cb.onRestart());
    this.el.btnSave.addEventListener('click', () => this.cb.onSave());
    this.el.btnLoad.addEventListener('click', () => this.cb.onLoad());
    this.el.btnRestartRun.addEventListener('click', () => this.cb.onRestart());
    this.el.btnFullscreen.addEventListener('click', () => this._toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this._syncFullscreen());
    this.el.musicVol.addEventListener('input', () => {
      this.cb.onMusicVolume(Number(this.el.musicVol.value) / 100);
    });
    this.el.sfxVol.addEventListener('input', () => {
      this.cb.onSfxVolume(Number(this.el.sfxVol.value) / 100);
    });
  }

  /**
   * Toggle the browser's fullscreen mode on the whole page.
   *
   * requestFullscreen must be called from a user gesture, which a click always
   * is, so the button cannot fail the way a keyboard shortcut could. Esc leaves
   * fullscreen natively, and `fullscreenchange` keeps the label honest either
   * way.
   */
  _toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  }

  _syncFullscreen() {
    if (!this.el.btnFullscreen) return;
    const active = Boolean(document.fullscreenElement);
    this._set(this.el.btnFullscreen, active ? 'Window' : 'Full');
    this.el.btnFullscreen.title = active ? 'Exit fullscreen (Esc)' : 'Toggle fullscreen';
  }

  /**
   * Reflect whether a save exists.
   *
   * Load stays disabled with no save, which is the only thing that makes the
   * button meaningful -- clicking it could otherwise only ever fail.
   */
  setSaveInfo({ exists, savedAt, summary } = {}) {
    const load = this.el.btnLoad;
    if (!load) return;

    const shouldDisable = !exists;
    if (load.disabled !== shouldDisable) load.disabled = shouldDisable;

    const when = savedAt ? new Date(savedAt).toLocaleString() : '';
    load.title = exists ? `Load the saved run — ${summary} (${when})` : 'No saved run';
  }

  _set(node, value) {
    if (!node) return;
    if (node.textContent !== value) node.textContent = value;
  }

  /**
   * @param {import('../sim/world.js').World} world
   * @param {{placingKey: string|null, selected: object|null, paused: boolean}} view
   * @param {{best:number, name:string, levels:object[], players:object,
   *          playerBest:object, activeMap:string, nextMap:object|null}} progress
   */
  update(world, view, progress = {}) {
    const eco = world.economy;
    const phase = world.waveState;

    this._set(this.el.wave, String(world.wave));
    this._set(this.el.coins, eco.coins.toFixed(0));
    this._set(this.el.base, `${Math.max(0, eco.baseHp).toFixed(0)}/${eco.baseHpMax.toFixed(0)}`);
    // Capacity first, because hitting it is the moment the player needs to know
    // why a placement was refused.
    const capacity = world.towerCapacity();
    const used = world.towers.size;
    this._set(
      this.el.towers,
      Number.isFinite(capacity) ? `${used}/${capacity}` : String(used),
    );
    this._set(this.el.dps, world.totalDps().toFixed(0));
    this._set(this.el.kills, String(world.stats.kills));
    this._set(this.el.best, String(progress.best ?? 0));

    // Phase line.
    let phaseText = '';
    if (phase === PREP) {
      phaseText = `Prep — next wave in ${Math.max(0, world.waves.prepRemaining).toFixed(1)}s`;
    } else if (phase === SPAWNING) {
      const queued = world.waves.queuedCount;
      phaseText = `Wave ${world.wave} — ${world.enemies.length} alive${
        queued > 0 ? `, ${queued} queued` : ''
      }`;
    } else if (phase === CLEARING) {
      phaseText = `Wave ${world.wave} — clearing`;
    } else if (phase === OVER) {
      phaseText = 'Defeat';
    }
    this._set(this.el.phase, phaseText);

    // Wave preview, only while in prep.
    if (phase === PREP) {
      const preview = world.nextWavePreview();
      const parts = Object.entries(preview.counts)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${this.config.enemies[key]?.name ?? key}×${count}`);
      const flag = preview.is_boss ? ' · BOSS' : preview.is_mini_boss ? ' · mini-boss' : '';
      this._set(this.el.preview, `${parts.join(', ')}${flag}`);
    } else {
      this._set(this.el.preview, '');
    }

    // Controls.
    this.el.early.disabled = phase !== PREP;
    this._set(
      this.el.pause,
      view.paused ? 'Resume' : 'Pause',
    );
    if (this.el.pause.classList.contains('active') !== view.paused) {
      this.el.pause.classList.toggle('active', view.paused);
    }

    // A paused game is indistinguishable from a slow one at a glance, so the
    // state gets announced on the board itself rather than only in the button.
    const badge = this.el.pausedBadge;
    if (badge && badge.hidden !== !view.paused) badge.hidden = !view.paused;

    for (const [speed, button] of this.speedButtons) {
      const active = Math.abs(world.speedScale - speed) < 0.001;
      if (button.classList.contains('active') !== active) {
        button.classList.toggle('active', active);
      }
    }

    // Shop affordability and selection. Test mode ignores cost, so nothing is
    // ever greyed out there.
    for (const [key, entry] of this.shopButtons) {
      if (entry.drop) {
        const won = world.test.enabled || world.unlockedTowers.has(key);
        const isMystery = entry.button.classList.contains('mystery');
        if (isMystery === won) {
          entry.button.classList.toggle('mystery', !won);
          if (won) {
            entry.hotkey.textContent = entry.def.hotkey ?? '';
            entry.name.textContent = entry.def.name;
            entry.cost.textContent = entry.def.cost.toFixed(0);
            entry.button.title = entry.def.description || entry.def.name;
            const rb = reachBadge(entry.def);
            entry.reach.className = rb.cls;
            entry.reach.textContent = rb.glyph;
            entry.reach.title = rb.title;
          } else {
            entry.hotkey.textContent = '?';
            entry.name.textContent = '???';
            entry.cost.textContent = '';
            entry.reach.className = '';
            entry.reach.textContent = '';
            entry.button.title = 'A felled boss drops a weapon here';
          }
        }
      }

      const mystery = entry.drop && entry.button.classList.contains('mystery');
      const affordable = world.test.enabled || eco.canAfford(entry.def.cost);
      const available = !mystery && affordable;
      const selected = view.placingKey === key && !mystery;
      if (entry.button.disabled === available) entry.button.disabled = !available;
      if (entry.button.classList.contains('selected') !== selected) {
        entry.button.classList.toggle('selected', selected);
      }
    }

    // The barracks button shows the price of the *next* one, which rises with
    // every barracks already standing -- so the label has to be refreshed rather
    // than set once at build time.
    const barracksButton = this.barracksButton;
    if (barracksButton) {
      const next = world.nextBarracksCost();
      const atLimit = next === null;
      const affordable = world.test.enabled || (!atLimit && eco.canAfford(next));

      if (barracksButton.button.disabled === affordable) {
        barracksButton.button.disabled = !affordable;
      }
      if (atLimit) {
        this._set(barracksButton.cost, 'max');
        barracksButton.button.title = `Maximum ${this.config.barracks.max_count} barracks`;
      } else {
        this._set(barracksButton.cost, String(next));
        barracksButton.button.title = this.config.barracks.description;
      }
      const selected = view.placingKey === BARRACKS_KEY;
      if (barracksButton.button.classList.contains('selected') !== selected) {
        barracksButton.button.classList.toggle('selected', selected);
      }
    }

    this._updateTest(world, view);
    this._updateInspector(world, view, view.selected);
    this._updateNotes(world);

    // Progression. The wave is read from the world rather than passed in, so
    // the next-level button appears on the frame the threshold is crossed
    // rather than a frame later.
    const full = { ...progress, wave: world.wave, testMode: world.test.enabled };
    this._updatePlayer(full);
    this._updateMaps(full);
    this._updateSkills(full.skills);
    this._updateNextLevel(full);
    this._updateWeather(world);
  }

  /**
   * The weather badge.
   *
   * Its numbers are read off the same bag the simulation multiplies by, not
   * from a hand-written label, so the badge cannot drift away from what is
   * actually happening to the board.
   */
  _updateWeather(world) {
    const weather = world.weather;
    const badge = this.el.weatherBadge;
    if (!weather) return;

    const show = !weather.isCalm;
    if (badge.hidden !== !show) badge.hidden = !show;
    if (!show) return;

    this._set(this.el.weatherName, weather.name);
    this._set(this.el.weatherEffects, weather.describe().join(' \u00b7 '));
    badge.title = weather.description;
  }

  _updateInspector(world, view, tower) {
    const ui = this.inspectorButtons;
    const hasTower = Boolean(tower) && tower.alive;

    // The panel floats over the board now, so it disappears outright when
    // nothing is selected rather than holding a column or covering the map.
    this.el.inspector.hidden = !hasTower;
    if (!hasTower) {
      this._specSig = null;
      return;
    }

    // Barracks are not towers: no target, no upgrade, no specialisations. They
    // get their own short panel rather than a tower panel full of dashes.
    if (tower.kind === 'barracks') {
      this._updateBarracksInspector(world, tower, view);
      return;
    }

    this._hideBarracksProgress();
    ui.links.hidden = true;

    this._set(ui.name, tower.d.name);
    this._set(ui.level, `Lv ${tower.level}/${world.leveling.max_level}`);

    const isBeam = tower.d.attack === 'beam';
    const rows = [
      ['Damage', `${tower.damage.toFixed(1)}${isBeam ? '/s' : ''} (${tower.d.damage_type})`],
    ];
    if (isBeam) {
      rows.push(
        ['Pulse', `${tower.pulseDuration.toFixed(1)}s on, ${tower.gapDuration.toFixed(1)}s off`],
        ['Ramp', `to ${(1 + tower.rampMax).toFixed(1)}× over ${(tower.rampMax / tower.rampPerSec).toFixed(1)}s on one target`],
      );
    } else {
      rows.push(['Rate', `${tower.rate.toFixed(2)}/s`]);
    }
    rows.push(
      ['Range', `${tower.range.toFixed(2)} tiles`],
      ['DPS', tower.dps().toFixed(1)],
      ['Damage dealt', tower.damageDealt.toFixed(0)],
      ['Kills', String(tower.kills)],
    );

    // Exotic stats only appear once a specialisation grants them, so an
    // unspecialised tower's panel stays as short as it has always been.
    if (tower.critChance > 0) {
      rows.push(['Crit', `${Math.round(tower.critChance * 100)}% x${tower.critMult}`]);
    }
    if (tower.burnDps > 0) {
      rows.push(['Burn', `${tower.burnDps.toFixed(0)}/s for ${tower.burnDuration}s`]);
    }
    if (tower.poisonDps > 0) {
      rows.push(['Poison', `${tower.poisonDps.toFixed(0)}/s x${tower.poisonStacks}`]);
    }
    if (tower.armorShred > 0) {
      rows.push(['Armour melt', `-${tower.armorShred} for ${tower.armorShredDuration}s`]);
    }
    if (tower.trueDamage) rows.push(['Armour', 'ignored']);

    // Targeting reach. Shown whenever the tower is restricted, and shown again
    // as an *unlocked* note when a specialisation has lifted the restriction --
    // that is the moment the player most wants to see it change.
    if (tower.groundOnly) {
      rows.push(['Targets', '\u25BC ground only']);
    } else if (tower.airOnly) {
      rows.push(['Targets', '\u25B2 air only']);
    } else if (tower.d.ground_only || tower.d.air_only) {
      rows.push(['Targets', '\u25B2\u25BC ground + air']);
    }

    // Ground the tower stands on, so the player can see why its numbers differ
    // from an identical tower a few tiles away.
    const band = tower.terrainBand;
    if (band) {
      const pct = (v) => `${v >= 1 ? '+' : '\u2212'}${Math.abs(Math.round((v - 1) * 100))}%`;
      rows.push(['Ground', band.name]);
      rows.push(['Terrain', `${pct(band.tower.range)} range, ${pct(band.tower.damage)} dmg`]);
    }

    const html = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join('');
    if (ui.stats.innerHTML !== html) ui.stats.innerHTML = html;

    this._updateSpecs(world, tower);

    const cost = tower.upgradeCost(world.leveling);
    if (cost === null) {
      ui.upgrade.disabled = true;
      this._set(ui.upgrade, 'Max level');
    } else {
      const free = world.test.enabled;
      const affordable = free || world.economy.canAfford(cost);
      ui.upgrade.disabled = !affordable;
      this._set(ui.upgrade, free ? 'Upgrade \u2014 free (U)' : `Upgrade \u2014 ${cost} (U)`);
    }

    // Re-enabled explicitly. The barracks branch disables this button, and
    // without setting it back the target control stayed dead for the rest of
    // the run the moment a barracks had ever been selected -- which, since a
    // barracks is the first thing most builds buy, meant almost always.
    ui.target.disabled = false;
    this._set(ui.target, `Target: ${TARGETING_LABELS[tower.mode] ?? tower.mode} (T)`);
    this._set(ui.sell, `Sell — +${Math.round(tower.sellValue(world.config.waves.sell_refund))} (X)`);
  }

  /**
   * The barracks panel: what it supports, and what it is about to become.
   *
   * The "next unlock" row is the whole progression in one line — it tells the
   * player what they are waiting for rather than only what they have, which is
   * what makes evolving feel like a goal instead of a number going up.
   */
  _updateBarracksInspector(world, barracks, view) {
    const ui = this.inspectorButtons;
    const cfg = world.config.barracks;

    // The header names the *rank*, not the structure. "Citadel" tells the player
    // what they have built; "Barracks" only tells them what it is, which they
    // already knew when they bought it.
    const rank = barracks.rank;
    this._set(ui.name, barracks.rankName);
    const rankTitle = rank?.description || cfg.description || '';
    if (ui.name.title !== rankTitle) ui.name.title = rankTitle;
    this._set(ui.level, `Lv ${barracks.level}/${cfg.levels.max_level}`);

    const rows = [
      ['Tower limit', `${world.towerCapacity()}`],
      ['Supporting', `${barracks.supported.length} tower${barracks.supported.length === 1 ? '' : 's'}`],
      ['Aura', `${barracks.radius.toFixed(1)} tiles`],
      ['Bonuses', barracks.describeBonuses()],
      ['Powers', barracks.describePowers()],
    ];

    const wing = barracks.fieldedRoster();
    if (wing.length > 0) {
      // Aircraft wear out and get shot down, so the roster alone would keep
      // promising a wing the player no longer has. The count is read back off
      // the live units and a rebuilding one is called out with its timer, which
      // is the only place the player can see that the loss is temporary.
      const live = world.aircraft.filter((craft) => craft.barracks === barracks);
      const parts = wing.map((w) => {
        const of = live.filter((craft) => craft.kind === w.kind);
        const ready = of.filter((craft) => craft.alive).length;
        return `${ready}/${w.count} × ${cfg.aircraft[w.kind]?.name ?? w.kind}`;
      });
      const rebuilding = live
        .filter((craft) => !craft.alive)
        .reduce((soonest, craft) => Math.min(soonest, craft.rebuildLeft), Infinity);
      if (Number.isFinite(rebuilding)) {
        parts.push(`next ready in ${Math.max(0, rebuilding).toFixed(1)}s`);
      }
      rows.push(['Air wing', parts.join(', ')]);
    }

    const promotes = barracks.nextRank();
    rows.push(
      promotes
        ? ['Next rank', `${promotes.name} (Lv${promotes.at})`]
        : ['Next rank', 'final rank'],
    );

    const html = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    if (ui.stats.innerHTML !== html) ui.stats.innerHTML = html;

    this._updateBarracksProgress(world, barracks);

    // Powers are presented through the same container the tower specialisation
    // choices use, so a choice looks and behaves the same wherever it appears.
    ui.specs.hidden = true;

    const options = barracks.pendingOptions();
    const level = barracks.pendingLevel();
    if (options.length === 0) {
      ui.specChoices.hidden = true;
      this._specSig = null;
    } else {
      ui.specChoices.hidden = false;
      const sig = `barracks:${barracks.tx},${barracks.ty}:${level}:${options.length}`;
      if (this._specSig !== sig) {
        this._specSig = sig;
        for (const node of [...ui.specChoices.querySelectorAll('.spec-option')]) node.remove();
        this._set(ui.specTitle, `Level ${level} — choose one`);

        for (const option of options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'spec-option';
          button.dataset.key = option.key;
          button.title = option.description;
          button.textContent = option.name;
          button.addEventListener('click', () => this.cb.onChoosePower(option.key));
          ui.specChoices.appendChild(button);
        }
      }
    }

    // Supply links and wing transfers. A base with no wing and no links still
    // gets the connect button, because linking is how a transfer becomes
    // possible in the first place.
    const linked = barracks.links
      .map((key) => world.barracks.get(key))
      .filter((b) => b && b.alive);
    const fielded = barracks.fieldedRoster();

    let linksHtml = '';
    const connecting = view.linkingBase === barracks;
    linksHtml += `<button type="button" class="link-connect">${
      connecting ? 'Connecting — click another base' : 'Connect pathway'
    }</button>`;

    if (linked.length > 0 && fielded.length > 0) {
      linksHtml += '<div class="link-moves">';
      for (const other of linked) {
        linksHtml += `<div class="link-target"><span class="link-name">↔ ${other.rankName} (${other.tx},${other.ty})</span>`;
        for (const spec of fielded) {
          const label = cfg.aircraft[spec.kind]?.name ?? spec.kind;
          linksHtml += `<button type="button" class="link-move" data-target="${other.tx},${other.ty}" data-kind="${spec.kind}">Move ${spec.count} × ${label}</button>`;
        }
        linksHtml += '</div>';
      }
      linksHtml += '</div>';
    } else if (linked.length > 0) {
      linksHtml += `<div class="link-target"><span class="link-name">Linked: ${linked.map((b) => `${b.rankName} (${b.tx},${b.ty})`).join(', ')}</span></div>`;
    }

    ui.links.hidden = false;
    if (ui.links.dataset.sig !== linksHtml) {
      ui.links.dataset.sig = linksHtml;
      ui.links.innerHTML = linksHtml;
      ui.links.querySelector('.link-connect').addEventListener('click', () => this.cb.onConnect());
      for (const button of ui.links.querySelectorAll('.link-move')) {
        button.addEventListener('click', () => {
          this.cb.onTransfer(button.dataset.target, button.dataset.kind);
        });
      }
    }

    // No targeting and no levelling by hand; the progress bar and the choice
    // buttons are the whole interaction.
    ui.upgrade.disabled = true;
    this._set(ui.upgrade, 'Experience only (from damage supported)');

    ui.target.disabled = true;
    this._set(ui.target, 'No targeting');

    const refund = Math.round(barracks.sellValue(world.config.waves.sell_refund));
    ui.sell.disabled = false;
    this._set(ui.sell, `Sell — +${refund} (X)`);
  }

  /**
   * The barracks' evolution display.
   *
   * A filling bar with a pip per level, rather than the text percentage it used
   * to be. The bar answers "how close am I" and the pips answer "what do I still
   * owe", which are two different questions the old one-line label conflated.
   */
  _updateBarracksProgress(world, barracks) {
    const ui = this.inspectorButtons;
    const cfg = world.config.barracks;
    const max = cfg.levels.max_level;
    const pending = barracks.pendingLevel();

    ui.progress.hidden = false;
    ui.progress.classList.toggle('pending', pending > 0);

    const fraction = barracks.progress(cfg.levels);
    const pct = Math.round(fraction * 100);
    const maxed = barracks.level >= max;

    ui.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    this._set(
      ui.progressPct,
      maxed ? 'maxed' : `${pct}%`,
    );
    this._set(
      ui.progressLabel,
      pending > 0 ? `Level ${pending} ready` : 'Evolution',
    );

    // One pip per level, rebuilt only when the picture changes -- this runs
    // every frame and the pips are the only part that is a list.
    const sig = `${barracks.level}:${pending}:${max}`;
    if (ui.progressPips.dataset.sig !== sig) {
      ui.progressPips.dataset.sig = sig;
      ui.progressPips.innerHTML = '';
      for (let level = 1; level <= max; level += 1) {
        const pip = document.createElement('span');
        pip.className = 'ip-pip';
        if (barracks.powers[level] !== undefined) pip.classList.add('taken');
        else if (level === pending) pip.classList.add('pending');
        ui.progressPips.appendChild(pip);
      }
    }
  }

  /** Hide the evolution display for anything that is not a barracks. */
  _hideBarracksProgress() {
    const ui = this.inspectorButtons;
    if (!ui.progress || ui.progress.hidden) return;
    ui.progress.hidden = true;
    ui.progress.classList.remove('pending');
    ui.progressPips.dataset.sig = '';
  }

  /**
   * The specialisation block: what has been taken, and what is still pending.
   *
   * The choice buttons are rebuilt only when the pending tier changes, because
   * this runs once a frame.
   */
  _updateSpecs(world, tower) {
    const ui = this.inspectorButtons;

    const taken = [...tower.specs.values()].map((o) => o.name).join('  ·  ');
    this._set(ui.specs, taken);
    ui.specs.hidden = taken === '';

    const tier = world.pendingSpecTier(tower);
    if (tier === null) {
      ui.specChoices.hidden = true;
      this._specSig = null;
      return;
    }

    const cost = world.specialisationCost(tower);
    const sig = `${tower.key}|${tier.tier}`;

    if (this._specSig !== sig) {
      this._specSig = sig;
      for (const node of [...ui.specChoices.querySelectorAll('.spec-option')]) node.remove();

      this._set(
        ui.specTitle,
        `Level ${tier.tier} — pick one${cost > 0 ? ` (${cost})` : ' (free)'}`,
      );

      for (const option of tier.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'spec-option';
        button.dataset.key = option.key;

        const name = document.createElement('span');
        name.className = 'spec-name';
        name.textContent = option.name;

        const blurb = document.createElement('span');
        blurb.className = 'spec-blurb';
        blurb.textContent = option.blurb ?? '';

        button.append(name, blurb);
        button.addEventListener('click', () => this.cb.onChooseSpec(option.key));
        ui.specChoices.appendChild(button);
      }
    }

    ui.specChoices.hidden = false;

    // Cost changes as coins come in, so affordability is rechecked every frame.
    const affordable = cost <= world.economy.coins;
    for (const button of ui.specChoices.querySelectorAll('.spec-option')) {
      if (button.disabled !== !affordable) button.disabled = !affordable;
    }
  }

  _updateNotes(world) {
    // Notes only ever append and trim, so compare length rather than rebuilding.
    if (world.notes.length === this._lastNotes) return;
    this._lastNotes = world.notes.length;

    this.el.notes.innerHTML = world.notes
      .slice(-4)
      .map((note) => `<div>${note}</div>`)
      .join('');
  }

  reset() {
    this._lastNotes = -1;
    this.el.notes.innerHTML = '';
    this.hideGameOver();
  }

  showGameOver(world, bestWave, isRecord) {
    const stats = world.summary();
    this.el.gameoverBody.innerHTML = `
      <div class="go-row"><span>Wave reached</span><strong>${stats.wave}</strong></div>
      <div class="go-row"><span>Kills</span><strong>${stats.kills}</strong></div>
      <div class="go-row"><span>Leaked</span><strong>${stats.leaked}</strong></div>
      <div class="go-row"><span>Damage dealt</span><strong>${Math.round(stats.damage)}</strong></div>
      <div class="go-row"><span>Coins earned</span><strong>${Math.round(stats.coins_earned)}</strong></div>
      <div class="go-row"><span>Survived</span><strong>${Math.floor(stats.time / 60)}m ${Math.floor(
        stats.time % 60,
      )}s</strong></div>
      <div class="go-row best"><span>Best wave</span><strong>${bestWave}${
        isRecord ? ' — new record' : ''
      }</strong></div>
    `;
    this.el.gameover.hidden = false;
  }

  hideGameOver() {
    this.el.gameover.hidden = true;
  }

  /** Transient message shown when a placement or action is rejected. */
  flash(message) {
    if (!message) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 1600);
  }
}
