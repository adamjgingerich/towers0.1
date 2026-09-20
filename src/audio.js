/**
 * Procedural chiptune engine.
 *
 * Every level gets its own loop, generated from the level id so the same map
 * always plays the same theme. The shape is shared across all of them -- a
 * heroic minor melody, a driving arpeggio, a low bass and a slow pad -- which
 * is what makes them read as one game rather than a random jukebox.
 *
 * The palette is deliberately NES-flavoured: square and triangle leads, a
 * sawtooth pad rolled off with a lowpass, and noise drums. Nothing is sampled;
 * everything is an oscillator scheduled a little ahead of the cursor.
 *
 * Pure WebAudio, no assets, no DOM. The host owns the user-gesture call.
 */

import { mulberry32 } from './sim/rng.js';
import { hashText } from './sim/terrain.js';

/** A sixteenth note at 112 BPM. */
const STEP = 60 / 112 / 4;
/** Four bars of four beats, in sixteenths. */
const LOOP = 64;

/** A minor scale, in MIDI. */
const SCALE = [57, 59, 60, 62, 64, 65, 67, 69];
/** Chord progression per bar: i, VI, VII, iv. */
const CHORDS = [
  [57, 60, 64],
  [65, 69, 72],
  [67, 71, 74],
  [62, 65, 69],
];

const midiHz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Level 2's track: an original 90s alt-rock tune, Weezer-flavoured rather than
 * a cover of any one song. G – D – Em – C, one bar each, power chords and a
 * driving eighth-note bass.
 */
const ROCK_CHORDS = [
  [55, 59, 62], // G
  [50, 57, 62], // D
  [52, 55, 59], // Em
  [48, 52, 55], // C
];

// An original lead line (MIDI, null = rest), one eighth note per slot.
const ROCK_MELODY = [
  74, 71, 69, 67, null, 71, 74, 71,
  74, 74, 72, 69, null, 69, 71, 72,
  71, 67, 64, 67, 71, 74, 71, 67,
  72, 71, 67, 64, 72, 74, 72, null,
];

export class MusicEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._timer = null;
    this._step = 0;
    this._nextTime = 0;
    this._seed = 'level_01';
    this._melody = [];
    this._style = 'field';
    this._noise = null;
    this._running = false;
    /** User-facing levels, 0..1, applied to the buses on creation/fade. */
    this._musicVolume = 0.7;
    this._sfxVolume = 0.5;
  }

  /** Create the context lazily: browsers refuse one before a gesture. */
  _ensure() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();

    // Master feeds the output once; music and battle sounds ride separate
    // buses so their volume sliders act independently.
    this.master = this.ctx.createGain();
    this.master.gain.value = 1.0;
    this.master.connect(this.ctx.destination);

    this.music = this.ctx.createGain();
    this.music.gain.value = 0.0;
    this.music.connect(this.master);

    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = this._sfxVolume;
    this.sfx.connect(this.master);

    // One short noise buffer, reused for every drum hit and battle thud.
    const len = Math.floor(this.ctx.sampleRate * 0.2);
    this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this._noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    return true;
  }

  /**
   * Regenerate the melody for this level.
   *
   * Every other part -- arp, bass, pad, drums -- is fixed structure, so the
   * melody is the only thing the seed changes. That is the balance between
   * "procedural" and "a recognisable theme": the levels share a skeleton and
   * each one hums a different tune over it.
   */
  setTheme(seedLabel) {
    this._seed = String(seedLabel);
    // One level gets a hand-written track; the rest keep the seeded generator.
    this._style = this._seed === 'level_02' ? 'rock' : 'field';
    if (this._style === 'rock') {
      this._melody = ROCK_MELODY.slice();
      return;
    }

    const rng = mulberry32(hashText(this._seed));
    const melody = new Array(LOOP / 2);
    for (let i = 0; i < melody.length; i += 1) {
      if (rng() < 0.22) {
        melody[i] = null;
      } else {
        const degree = SCALE[Math.floor(rng() * SCALE.length)];
        // Occasional octave leap, for the adventure feel.
        melody[i] = degree + (rng() < 0.24 ? 12 : 0);
      }
    }
    this._melody = melody;
  }

  /** Start (or resume) playback. Safe to call from a user gesture. */
  start(seedLabel) {
    if (!this._ensure()) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.setTheme(seedLabel);
    if (this._running) return;
    this._running = true;
    this.music.gain.cancelScheduledValues(this.ctx.currentTime);
    this.music.gain.setTargetAtTime(this._musicVolume, this.ctx.currentTime, 1.5);
    this._nextTime = this.ctx.currentTime + 0.1;
    this._timer = setInterval(() => this._schedule(), 40);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  /** User-facing music level, 0..1. The fade-in in start() reads this, so the
   *  slider and the boot fade share one knob. */
  setMusicVolume(v) {
    this._musicVolume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.ctx && this.music) {
      const t = this.ctx.currentTime;
      this.music.gain.cancelScheduledValues(t);
      this.music.gain.setTargetAtTime(this._musicVolume, t, 0.08);
    }
  }

  /** User-facing battle-sound level, 0..1. */
  setSfxVolume(v) {
    this._sfxVolume = Math.max(0, Math.min(1, Number(v) || 0));
    if (this.ctx && this.sfx) {
      const t = this.ctx.currentTime;
      this.sfx.gain.cancelScheduledValues(t);
      this.sfx.gain.setTargetAtTime(this._sfxVolume, t, 0.08);
    }
  }

  /**
   * A quiet battle thud. `intensity` scales the pitch of the thump and its
   * loudness: a single kill is a soft tap, a base leak is a dull boom.
   *
   * Deliberately gentle -- the music carries the scene, the effects are
   * texture underneath it.
   */
  boom(intensity = 1.0) {
    if (!this._ensure()) return;
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const k = Math.max(0.25, Math.min(1.6, Number(intensity) || 1));
    const dur = 0.16 + 0.22 * k;

    // The low thump: a sine swept down, the "boom" half of the sound.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90 + 60 * k, t);
    osc.frequency.exponentialRampToValueAtTime(34, t + dur);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.34 * k, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(og);
    og.connect(this.sfx);
    osc.start(t);
    osc.stop(t + dur);

    // A soft noise crack, rolled off so it reads as a distant thud.
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.16 * k, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.6);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    src.connect(lp);
    lp.connect(ng);
    ng.connect(this.sfx);
    src.start(t);
    src.stop(t + dur * 0.6);
  }

  stop() {
    this._running = false;
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.ctx) {
      this.music.gain.cancelScheduledValues(this.ctx.currentTime);
      this.music.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.2);
    }
  }

  _schedule() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ahead = 0.3;
    while (this._nextTime < this.ctx.currentTime + ahead) {
      this._playStep(this._step, this._nextTime);
      this._nextTime += STEP;
      this._step = (this._step + 1) % LOOP;
    }
  }

  /** A pitched voice with a simple attack/release envelope. */
  _voice(type, hz, t, dur, gain, attack = 0.01, release = 0.04) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + Math.max(attack, dur - release));
    g.gain.linearRampToValueAtTime(0.0, t + dur);
    osc.connect(g);
    g.connect(this.music);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** A noise drum hit, highpassed for hats. */
  _drum(t, dur, gain, highpass = false) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    let node = src;
    if (highpass) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6000;
      src.connect(hp);
      node = hp;
    }
    node.connect(g);
    g.connect(this.music);
    src.start(t);
    src.stop(t + dur);
  }

  _playStep(step, t) {
    if (this._style === 'rock') {
      this._playRockStep(step, t);
      return;
    }

    const bar = Math.floor(step / 16);
    const chord = CHORDS[bar % CHORDS.length];

    // Pad: one slow, filtered chord per bar (the Blade Runner wash).
    if (step % 16 === 0) {
      for (const note of chord) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = midiHz(note - 12);
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(500, t);
        lp.frequency.linearRampToValueAtTime(900, t + STEP * 16);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0, t);
        g.gain.linearRampToValueAtTime(0.035, t + 0.5);
        g.gain.setValueAtTime(0.035, t + STEP * 14);
        g.gain.linearRampToValueAtTime(0.0, t + STEP * 16);
        osc.connect(lp);
        lp.connect(g);
        g.connect(this.music);
        osc.start(t);
        osc.stop(t + STEP * 16);
      }
    }

    // Bass: root of the chord on the eighths.
    if (step % 2 === 0) {
      this._voice('triangle', midiHz(chord[0] - 12), t, STEP * 1.7, 0.11, 0.005, 0.06);
    }

    // Melody on the eighths, from the seeded tune.
    const midx = Math.floor(step / 2);
    if (step % 2 === 0 && this._melody[midx] !== null && this._melody[midx] !== undefined) {
      this._voice('square', midiHz(this._melody[midx]), t, STEP * 1.8, 0.07, 0.004, 0.05);
    }

    // Arp: a shimmering sixteenth run up the chord (the Tron pulse).
    const arpNote = chord[step % 3] + 12;
    this._voice('square', midiHz(arpNote), t, STEP * 0.8, 0.04, 0.002, 0.03);

    // Drums: kick on the beat, hat on the offbeat.
    if (step % 8 === 0) {
      this._drum(t, 0.11, 0.5);
    } else if (step % 8 === 4) {
      this._drum(t, 0.04, 0.12, true);
    }
  }

  /**
   * The level-2 rock arrangement: power chords on the eighths, a driving
   * eighth bass, the composed lead, and a kick/snare/hat beat. Chiptune
   * through and through, but the shape of a garage band rather than a club.
   */
  _playRockStep(step, t) {
    const bar = Math.floor(step / 16);
    const chord = ROCK_CHORDS[bar % ROCK_CHORDS.length];
    const eighth = step % 2 === 0;

    // Rhythm guitar: palm-muted power chords, root and fifth, tight and short.
    if (eighth) {
      const root = chord[0];
      this._voice('square', midiHz(root + 12), t, STEP * 0.85, 0.045, 0.003, 0.03);
      this._voice('square', midiHz(root + 7 + 12), t, STEP * 0.85, 0.04, 0.003, 0.03);
    }

    // Bass: driving eighths, an octave under the guitar.
    if (eighth) {
      this._voice('square', midiHz(chord[0] - 12), t, STEP * 1.5, 0.09, 0.004, 0.05);
    }

    // Lead: the composed rock line, a singing fuzz square on the eighths.
    const midx = Math.floor(step / 2);
    const note = this._melody[midx];
    if (eighth && note !== null && note !== undefined) {
      this._voice('square', midiHz(note), t, STEP * 1.7, 0.06, 0.005, 0.08);
    }

    // Drums: kick on 1 & 3, snare on 2 & 4, hats on the offbeats.
    const s16 = step % 16;
    if (s16 === 0 || s16 === 8) {
      this._drum(t, 0.12, 0.45);
    } else if (s16 === 4 || s16 === 12) {
      this._drum(t, 0.07, 0.28);
    } else if (s16 % 4 === 2) {
      this._drum(t, 0.03, 0.06, true);
    }
  }
}
