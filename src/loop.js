/**
 * Fixed-timestep game loop.
 *
 * The simulation advances in fixed 1/60 s steps regardless of the display
 * rate, with the leftover time carried in an accumulator. That keeps the sim
 * deterministic and frame-rate independent: a 144 Hz monitor and a 30 Hz one
 * produce the same run from the same seed.
 *
 * Game speed multiplies the *number* of steps taken, never the size of a step.
 * Enlarging the step instead would make 5x a different game from 1x -- and it
 * did, before this: a tower's cooldown is decremented once per step, so a step
 * of 0.05 s silently caps every weapon at 20 shots per second, and a gatling
 * with a rate build was quietly firing at half speed on 3x. Advancing more
 * steps of the same size keeps 5x an *identical* run played faster, which also
 * means a run can be replayed at a different speed and still match.
 *
 * The cost is that 5x needs five times the CPU per frame. When the machine
 * cannot keep up, catch-up drops steps and the effective speed falls below the
 * selected one -- a slowdown, rather than a corrupted simulation.
 *
 * Two guards matter here, and both exist because of how browsers behave:
 *
 *  1. Catch-up is capped (MAX_STEPS). Without it, a long stall -- a GC pause,
 *     a slow texture upload -- would be repaid in one frame as hundreds of
 *     steps, which is far slower than the stall was.
 *  2. Background tabs throttle or stop requestAnimationFrame entirely, so the
 *     accumulator is reset on visibilitychange. Otherwise returning to the tab
 *     would fast-forward the whole time spent away.
 */

export const FIXED_DT = 1 / 60;

/**
 * Hard ceiling on steps in a single frame.
 *
 * Must leave room for 5x speed at 60 Hz (5 steps) plus catch-up, but stay low
 * enough that a stall is never repaid in one enormous frame. The accumulator
 * cap below is the real limiter; this is the backstop.
 */
const MAX_STEPS = 32;

/**
 * Give up on catching up beyond this much *simulated* time.
 *
 * Measured in simulation seconds rather than wall-clock, so the backlog is the
 * same size at every speed. A wall-clock cap would let 5x bank five times the
 * backlog of 1x before the guard noticed.
 */
const MAX_ACCUMULATED = 0.5;

export class Loop {
  /**
   * @param {(dt: number) => void} update fixed-step simulation advance
   * @param {(dtReal: number) => void} render once per displayed frame
   * @param {{speed?: () => number}} [opts] `speed` returns the current multiplier
   */
  constructor(update, render, opts = {}) {
    this.update = update;
    this.render = render;
    /** Read every frame, so changing speed applies immediately. */
    this.speed = opts.speed ?? (() => 1);

    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this._raf = 0;

    /** Diagnostics for the HUD: steps taken and frames dropped last second. */
    this.stepsLastFrame = 0;
    this.droppedSteps = 0;

    this._onVisibility = () => {
      if (document.hidden) {
        this.lastTime = 0;
      } else {
        // Forget the time spent hidden rather than repaying it.
        this.lastTime = performance.now();
        this.accumulator = 0;
      }
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    document.addEventListener('visibilitychange', this._onVisibility);

    const tick = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);

      if (this.lastTime === 0) this.lastTime = now;
      let elapsed = (now - this.lastTime) / 1000;
      this.lastTime = now;

      // Real time in, simulated time out. Every step below is still FIXED_DT.
      // Slower-than-realtime modes (0.5x, 0.25x) simply bank less simulated
      // time per frame; the accumulator handles the fraction naturally.
      const speed = Math.max(0, this.speed() || 1);
      let advance = elapsed * speed;
      if (advance > MAX_ACCUMULATED) advance = MAX_ACCUMULATED;
      this.accumulator += advance;

      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
        this.update(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps += 1;
      }

      // If we hit the step cap, the backlog is unrecoverable -- drop it and
      // report it, rather than letting it grow without bound.
      if (steps === MAX_STEPS && this.accumulator >= FIXED_DT) {
        this.droppedSteps += Math.floor(this.accumulator / FIXED_DT);
        this.accumulator = 0;
      }

      this.stepsLastFrame = steps;
      this.render(elapsed);
    };

    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    document.removeEventListener('visibilitychange', this._onVisibility);
  }
}
