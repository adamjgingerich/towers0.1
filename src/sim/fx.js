/**
 * Short-lived visual effects.
 *
 * The simulation owns these because their lifetimes are tied to sim time (so
 * they respect pause and the speed multiplier), but they carry no gameplay
 * meaning. The renderer reads them and draws whatever it likes.
 */

export class Fx {
  constructor(kind, {
    x = 0.0,
    y = 0.0,
    key = '',
    angle = 0.0,
    duration = 0.3,
    points = null,
    text = '',
    color = '#ffffff',
    scale = 1.0,
  } = {}) {
    this.kind = kind;
    this.key = key;
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.t = 0.0;
    this.duration = duration;
    this.points = points ?? [];
    this.label = text;
    this.color = color;
    this.scale = scale;
  }

  get progress() {
    if (this.duration <= 0.0) return 1.0;
    return Math.min(1.0, this.t / this.duration);
  }

  static sprite(key, x, y, duration = 0.3, scale = 1.0) {
    return new Fx('sprite', { key, x, y, duration, scale });
  }

  static beam(x0, y0, x1, y1, color = '#ffffff', duration = 0.12) {
    return new Fx('beam', {
      x: x0,
      y: y0,
      points: [
        [x0, y0],
        [x1, y1],
      ],
      color,
      duration,
    });
  }

  static chain(points, color = '#8fd8ff', duration = 0.18) {
    return new Fx('chain', { points: points.slice(), color, duration });
  }

  static text(x, y, text, color = '#ffffff', duration = 0.7) {
    return new Fx('text', { x, y, text, color, duration });
  }
}
