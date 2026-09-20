/**
 * Weather.
 *
 * A spell lasts a few waves and shifts every tower and every enemy on the board
 * at once. That is the point of it: it changes what an existing build is *worth*
 * without changing the build, which is the one thing a difficulty multiplier
 * cannot do. A player who has leaned entirely on range has a bad time in fog and
 * a good time in the sun, and neither cost them a coin.
 *
 * ## Own RNG stream
 *
 * Seeded separately from the crit stream and the wave-composition stream. Rolling
 * weather from the wave stream would shift every subsequent wave's composition,
 * which would turn a balance sweep into a measurement of the weather generator.
 *
 * Pure simulation: no three.js, no DOM.
 */

import { Rng } from './rng.js';

/** The type used before the first spell, and between spells. */
export const CLEAR = 'clear';

/** A neutral effect bag. Shared, because nothing ever mutates it. */
const NEUTRAL = Object.freeze({ damage: 1.0, rate: 1.0, range: 1.0 });

export class WeatherManager {
  /**
   * @param {object|null} config parsed `data/weather.json`, or null to disable
   * @param {number} seed distinct from the crit and wave seeds
   */
  constructor(config, seed) {
    this.config = config && Array.isArray(config.types) && config.types.length > 0 ? config : null;
    this.rng = new Rng(seed);

    this.type = this._find(CLEAR) ?? null;
    this.wavesLeft = 0;
    this.tower = NEUTRAL;
    this.enemySpeed = 1.0;

    /**
     * Bumped on every change.
     *
     * The renderer and the save format both need "has the weather changed?"
     * without comparing strings, and a counter is cheaper and cannot miss a
     * change back to a type seen before.
     */
    this.serial = 0;
  }

  get key() {
    return this.type?.key ?? CLEAR;
  }

  get name() {
    return this.type?.name ?? 'Clear';
  }

  get description() {
    return this.type?.description ?? '';
  }

  /** Board wash colour and strength, for the renderer. */
  get tint() {
    return this.type?.tint ?? '#ffffff';
  }

  get alpha() {
    return this.type?.alpha ?? 0.0;
  }

  get particles() {
    return this.type?.particles ?? 'none';
  }

  /**
   * Whether this spell changes anything at all.
   *
   * Compared by value, not against the shared NEUTRAL bag by identity: `_apply`
   * builds a fresh object every time, so an identity check is never true and
   * "Clear" would show up as a weather effect with no effects.
   */
  get isCalm() {
    const t = this.tower;
    return (
      this.alpha <= 0.0
      && this.enemySpeed === 1.0
      && t.damage === 1.0
      && t.rate === 1.0
      && t.range === 1.0
    );
  }

  /**
   * The effect list as display strings, for the badge.
   *
   * Read off the same numbers the simulation uses rather than from a
   * hand-written label, so the badge cannot drift away from what is happening.
   * @returns {string[]}
   */
  describe() {
    const parts = [];
    const pct = (value) => `${value > 1 ? '+' : '−'}${Math.round(Math.abs(value - 1) * 100)}%`;

    const t = this.tower;
    if (t.damage !== 1.0) parts.push(`Towers ${pct(t.damage)} damage`);
    if (t.rate !== 1.0) parts.push(`Towers ${pct(t.rate)} rate`);
    if (t.range !== 1.0) parts.push(`Towers ${pct(t.range)} range`);
    if (this.enemySpeed !== 1.0) parts.push(`Enemies ${pct(this.enemySpeed)} speed`);

    return parts;
  }

  _find(key) {
    if (!this.config) return null;
    return this.config.types.find((t) => t.key === key) ?? null;
  }

  /**
   * Advance at the start of a wave.
   *
   * @returns {boolean} whether the weather changed, so the caller can broadcast
   */
  onWave(wave) {
    if (!this.config) return false;
    if (wave < this.config.first_wave) return false;

    // A spell that has run out is replaced this wave; one still running is not
    // re-rolled, so weather reads as a period rather than as noise.
    if (this.wavesLeft > 0) {
      this.wavesLeft -= 1;
      if (this.wavesLeft > 0) return false;
    }

    this.pick();
    return true;
  }

  /** Choose a type at random and apply it. */
  pick() {
    if (!this.config) return;

    let total = 0;
    for (const type of this.config.types) total += type.weight;

    let roll = this.rng.next() * total;
    let chosen = this.config.types[this.config.types.length - 1];
    for (const type of this.config.types) {
      roll -= type.weight;
      if (roll <= 0) {
        chosen = type;
        break;
      }
    }

    this._apply(chosen);
  }

  /**
   * Force a specific type. Used by the save format, and by tests.
   *
   * @param {string} key
   * @param {number|null} wavesLeft null keeps whatever the current spell has,
   *   which is what restoring a save wants -- a loaded run should finish the
   *   spell it was in the middle of, not restart its clock.
   */
  set(key, wavesLeft = null) {
    const type = this._find(key);
    if (!type) return false;
    this._apply(type, wavesLeft);
    return true;
  }

  _apply(type, wavesLeft = null) {
    this.type = type;

    const tower = type.effects?.tower ?? {};
    this.tower = {
      damage: Number.isFinite(tower.damage) ? tower.damage : 1.0,
      rate: Number.isFinite(tower.rate) ? tower.rate : 1.0,
      range: Number.isFinite(tower.range) ? tower.range : 1.0,
    };
    const speed = type.effects?.enemy?.speed;
    this.enemySpeed = Number.isFinite(speed) ? speed : 1.0;

    if (wavesLeft === null) {
      const min = this.config?.min_waves ?? 2;
      const max = this.config?.max_waves ?? 4;
      this.wavesLeft = this.rng.randint(Math.min(min, max), Math.max(min, max));
    } else {
      this.wavesLeft = Math.max(0, Math.floor(wavesLeft));
    }

    this.serial += 1;
  }

  /** The RNG state travels with a save so weather does not re-roll on load. */
  get state() {
    return this.rng.state;
  }

  set state(value) {
    this.rng.state = value;
  }
}
