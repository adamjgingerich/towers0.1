/**
 * Placeholder sprite sheets, generated at runtime with Canvas2D.
 *
 * data/atlas.json references six PNGs that do not exist yet. Rather than
 * shipping broken image warnings, this draws sheets whose layout matches the
 * atlas definition exactly -- same frame size, same rows, same frame counts.
 * Dropping real PNGs in later is a one-line change in the loader, because the
 * UV maths in atlas.js only cares about the declared layout.
 *
 * The art is deliberately flat and colour-coded so the game is readable before
 * any real art exists.
 */

import * as THREE from 'three';
import { hashHue, sheetLayout } from './atlas.js';

/** Hand-tuned hues so the palette reads deliberately rather than randomly. */
const ENEMY_HUES = {
  basic: 205,
  fast: 42,
  heavy: 8,
  armored: 272,
  flyer: 168,
  healer: 118,
  boss: 328,
  bulwark: 250,
  runner: 75,
  splitter: 145,
  warden: 300,
  // Late-game types. The wheel is crowded at sixteen entries, so silhouette is
  // doing more of the identifying work than hue is -- each of these reads as a
  // distinct shape before it reads as a distinct colour.
  sentinel: 232,
  wraith: 288,
  hive: 22,
  colossus: 352,
  swarmling: 96,
  // Second batch. Every hue here is picked to sit clear of its neighbours on the
  // wheel as well as clear of the roster: husk is a desaturated bone against the
  // purple armored, obsidian is a deep blue-violet that is not the sentinel's
  // blue, and the marauder is the only high-chroma magenta in the game so a leak
  // bomb reads instantly even in a crowd.
  husk: 34,
  overseer: 168,
  obsidian: 258,
  behemoth: 14,
  marauder: 318,
};

// Spread around the wheel so no two towers read as the same colour.
const TOWER_HUES = {
  basic: 205,
  cannon: 40,
  frost: 175,
  tesla: 62,
  venom: 288,
  sniper: 0,
  gatling: 130,
  flamethrower: 16,
  missile: 230,
  mortar: 320,
  laser: 348,
  sixshooter: 30,
  dynamite: 18,
  grapeshot: 210,
  harpoon: 190,
  raygun: 270,
  ioncannon: 140,
};

function hue(key, table) {
  return table[key] ?? hashHue(key);
}

function body(ctx, cx, cy, r, h, { lightness = 52, stroke = true } = {}) {
  ctx.fillStyle = `hsl(${h} 68% ${lightness}%)`;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = `hsl(${h} 60% 22%)`;
    ctx.stroke();
  }
}

/** Walk bob: two legs that alternate with the frame. */
function legs(ctx, cx, cy, r, frame, frames) {
  const phase = (frame / Math.max(1, frames)) * Math.PI * 2;
  const swing = Math.sin(phase) * r * 0.45;
  ctx.strokeStyle = 'rgba(10,12,16,0.75)';
  ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.45, cy + r * 0.6);
  ctx.lineTo(cx - r * 0.45 + swing, cy + r * 1.25);
  ctx.moveTo(cx + r * 0.45, cy + r * 0.6);
  ctx.lineTo(cx + r * 0.45 - swing, cy + r * 1.25);
  ctx.stroke();
}

/**
 * @param {string} sheetName
 * @param {object} sheet
 * @param {{fw:number, fh:number, rows:number, cols:number}} layout
 * @param {Function} drawCell (ctx, x, y, fw, fh, key, frame, frames) => void
 * @param {string[]} keys sprite keys in row order
 */
function makeSheet(sheetName, sheet, layout, drawCell, keys) {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  // Smoothing on: the sheets are drawn from arcs and curves, not pixel blocks,
  // so at art_scale 3 a hard-edged rasterisation looks like a mistake rather
  // than a style.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, layout.width, layout.height);

  for (const [key, sprite] of Object.entries(sheet.sprites)) {
    // Keys starting with `_` are authoring notes, not art. Drawing one would
    // silently stamp a fallback sprite over frame 0 of whatever shares its row.
    if (key.startsWith('_')) continue;

    const row = sprite.row ?? 0;
    const col = sprite.col ?? 0;
    const frames = sprite.frames ?? 1;
    for (let f = 0; f < frames; f += 1) {
      drawCell(
        ctx,
        (col + f) * sheet.fw,
        row * sheet.fh,
        sheet.fw,
        sheet.fh,
        key,
        f,
        frames,
        sheetName,
      );
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  // Mipmaps plus linear filtering, because this art is minified far more often
  // than it is magnified: a 96px frame drawn into a ~20px tile on screen.
  // Nearest sampling there would shimmer along every edge as the camera moves.
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  return {
    texture,
    width: layout.width,
    height: layout.height,
    keys,
    generated: true,
  };
}

/** Two eyes, set at the front of a body that faces +x. */
function eyes(ctx, cx, cy, r, spacing, size, hue) {
  for (const sy of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(cx + r * 0.42, cy + sy * spacing, size, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.94)';
    ctx.fill();
    ctx.beginPath();
    // Pupils look slightly ahead of the body, which reads as intent.
    ctx.arc(cx + r * 0.42 + size * 0.3, cy + sy * spacing, size * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${hue} 60% 14%)`;
    ctx.fill();
  }
}

/**
 * Enemy visual variants. Every type resolves to one of three looks -- the base
 * plus two mutants -- keyed by a `_v1`/`_v2` suffix on its atlas row. The
 * variant is picked per enemy from its eid, so a crowd of one type reads as a
 * population rather than a clone stamp, and the same run always draws the same
 * crowd.
 */
function splitVariant(key) {
  const m = /^(.*)_v([12])$/.exec(key);
  if (m) return { base: m[1], variant: Number(m[2]) };
  return { base: key, variant: 0 };
}

// Variant 1 is bigger and shifted warmer; variant 2 is smaller and shifted
// cooler, so the three reads are "normal / swollen / runt" at a glance.
const VARIANT_HUE = [0, 22, -16];
const VARIANT_SCALE = [1.0, 1.06, 0.92];

/**
 * Enemies. All of them face +x so the walk angle maps onto a z rotation.
 *
 * `frame` drives a walk cycle in every case, plus one idle tell per type --
 * flapping wings, a pulsing core, a wobbling antenna. That second, unrelated
 * motion is what stops a crowd of identical sprites reading as a texture: a
 * unit that breathes and blinks is alive even when it is not moving.
 */
function drawEnemy(ctx, x, y, fw, fh, key, frame = 0, frames = 6) {
  const { base, variant } = splitVariant(key);
  const cx = x + fw / 2;
  const cy = y + fh / 2;
  const h = (hue(base, ENEMY_HUES) + VARIANT_HUE[variant] + 360) % 360;

  const scale =
    base === 'boss' ? 0.4
      : base === 'behemoth' ? 0.39
        : base === 'colossus' ? 0.38
          : base === 'sentinel' ? 0.33
            : base === 'heavy' ? 0.32
              : base === 'hive' ? 0.32
                : base === 'bulwark' ? 0.3
                  : base === 'splitter' ? 0.3
                    : base === 'husk' ? 0.28
                      : base === 'obsidian' ? 0.26
                        : base === 'overseer' ? 0.27
                          : base === 'marauder' ? 0.2
                            : base === 'runner' ? 0.2
                              : base === 'swarmling' ? 0.14
                                : base === 'wraith' ? 0.24
                                  : 0.26;
  const r = fw * scale * VARIANT_SCALE[variant];
  const phase = (frame / Math.max(1, frames)) * Math.PI * 2;

  const shell = `hsl(${h} 68% 52%)`;
  const shellDark = `hsl(${h} 60% 24%)`;
  const shellLight = `hsl(${h} 72% 68%)`;

  /**
   * An armoured plate: a wedge laid over the body with a dark seam under it.
   * Used by everything that should read as built rather than as grown.
   */
  const plate = (ax, ay, bx, by) => {
    ctx.beginPath();
    ctx.moveTo(cx + ax, cy + ay);
    ctx.lineTo(cx + bx, cy + by);
    ctx.strokeStyle = shellDark;
    ctx.lineWidth = r * 0.12;
    ctx.stroke();
  };

  if (base === 'flyer' || base === 'warden' || base === 'wraith') {
    const flap = Math.sin(phase);
    const wraith = base === 'wraith';

    /*
      The wraith gets blades, not wings. It shares an airframe with the flyer
      and warden so it reads as the same family of threat, but a straight-edged
      silhouette is the one thing the player can identify at gameplay zoom --
      and it is the tell that this one is not going to be slowed.
    */
    for (const sy of [-1, 1]) {
      const lift = flap * r * 0.22 * sy;
      ctx.beginPath();
      if (wraith) {
        ctx.moveTo(cx - r * 0.05, cy + sy * r * 0.1);
        ctx.lineTo(cx - r * 0.85, cy + sy * (r * 1.35 + lift));
        ctx.lineTo(cx - r * 1.45, cy + sy * (r * 0.62 + lift * 0.6));
        ctx.lineTo(cx - r * 0.7, cy + sy * (r * 0.34 + lift * 0.4));
      } else {
        ctx.moveTo(cx - r * 0.1, cy + sy * r * 0.12);
        ctx.quadraticCurveTo(
          cx - r * 0.55,
          cy + sy * (r * 1.2 + lift),
          cx - r * 1.2,
          cy + sy * (r * 0.8 + lift),
        );
        ctx.quadraticCurveTo(
          cx - r * 0.6,
          cy + sy * (r * 0.42 + lift * 0.5),
          cx - r * 0.06, cy + sy * r * 0.3,
        );
      }
      ctx.closePath();
      ctx.fillStyle = `hsl(${h} 62% ${wraith ? 44 : 56}%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 55% 30%)`;
      ctx.lineWidth = r * 0.1;
      ctx.stroke();
    }

    if (wraith) {
      // A trailing wisp instead of a rotor. Nothing about it should suggest
      // machinery, so the rotor blur that separates the flyer from a bird is
      // deliberately absent here.
      ctx.strokeStyle = `hsla(${h} 70% 76% / 0.35)`;
      ctx.lineWidth = r * 0.14;
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.8, cy);
      ctx.quadraticCurveTo(
        cx - r * (1.5 + Math.sin(phase) * 0.12),
        cy - r * 0.45,
        cx - r * (2.0 + Math.cos(phase) * 0.14),
        cy + r * 0.1,
      );
      ctx.stroke();
    } else {
      // Rotor blur above the body: an ellipse that squashes as it spins, which
      // is what separates powered flight from a bird at this size.
      const spin = 0.25 + 0.75 * Math.abs(Math.sin(phase * 3));
      ctx.strokeStyle = `hsla(${h} 45% 88% / 0.6)`;
      ctx.lineWidth = r * 0.1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 0.9, r * 0.9 * spin, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    body(ctx, cx, cy, r * 0.72, h);

    if (wraith) {
      // A hollow core with the light *behind* the shell, which is the whole
      // visual grammar for "this thing is not solid": a flyer has a canopy,
      // a warden has a visor, and a wraith has a hole.
      const glow = 0.5 + 0.5 * Math.sin(phase * 2);
      ctx.beginPath();
      ctx.ellipse(cx + r * 0.2, cy, r * 0.3, r * 0.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 15% 8%)`;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + r * 0.2, cy, r * (0.2 + glow * 0.06), r * (0.28 + glow * 0.07), 0, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 92% ${62 + glow * 16}%)`;
      ctx.fill();
      return;
    }

    // A canopy, so there is something readable as a cockpit at this size.
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.26, cy, r * 0.32, r * 0.24, 0, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${h} 80% 84%)`;
    ctx.fill();

    if (base === 'warden') {
      // Plated over the same airframe as a flyer, so a shielded flyer reads as
      // a tougher version of a unit the player already knows rather than as a
      // new species. Its barrier is drawn by the renderer.
      plate(0.1, -0.72, 0.1, 0.72);
      plate(-0.42, -0.6, -0.42, 0.6);
      ctx.strokeStyle = `hsl(${h} 30% 24%)`;
      ctx.lineWidth = r * 0.14;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }

  // Ground types: legs first, so the body covers where they attach.
  if (
    base === 'heavy' || base === 'boss' || base === 'colossus'
    || base === 'behemoth' || base === 'husk'
  ) {
    // Four stubby legs, two pairs out of phase, for a lumbering gait.
    for (let i = 0; i < 4; i += 1) {
      const sy = i < 2 ? -1 : 1;
      const off = (i % 2 === 0 ? 1 : -1) * Math.sin(phase) * r * 0.3;
      ctx.strokeStyle = `hsl(${h} 40% 18%)`;
      ctx.lineWidth = Math.max(2, r * 0.26);
      ctx.beginPath();
      ctx.moveTo(cx + off + (i < 2 ? -r * 0.4 : r * 0.3), cy + sy * r * 0.6);
      ctx.lineTo(cx + off + (i < 2 ? -r * 0.45 : r * 0.35), cy + sy * r * 1.25);
      ctx.stroke();
    }
  } else if (base === 'marauder') {
    // Deliberately legless. It skims, and the absence of legs is half of why it
    // reads as fast even in a still frame.
  } else {
    legs(ctx, cx, cy, r, frame, frames);
  }

  body(ctx, cx, cy, r, h);

  // A lighter upper surface gives the flat disc some volume from above.
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.1, cy - r * 0.12, r * 0.62, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = `hsla(${h} 70% 66% / 0.5)`;
  ctx.fill();

  if (base === 'armored') {
    // Segmented plates with seams, plus a visor slit: visibly manufactured.
    plate(0.05, -0.75, 0.05, 0.75);
    plate(-0.45, -0.7, -0.45, 0.7);
    ctx.beginPath();
    ctx.roundRect(cx + r * 0.45, cy - r * 0.34, r * 0.5, r * 0.68, r * 0.16);
    ctx.fillStyle = `hsl(${h} 30% 12%)`;
    ctx.fill();
    ctx.fillStyle = `hsl(${h} 85% 66%)`;
    ctx.beginPath();
    ctx.roundRect(cx + r * 0.52, cy - r * 0.24, r * 0.36, r * 0.48, r * 0.12);
    ctx.fill();
  } else if (base === 'healer') {
    // A halo that breathes, and a cross that pulses with it.
    const glow = 0.5 + 0.5 * Math.sin(phase * 2);
    ctx.strokeStyle = `hsla(120 70% 70% / ${0.28 + glow * 0.35})`;
    ctx.lineWidth = Math.max(1.5, r * 0.13);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1.2 + glow * 0.16), 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = `hsl(0 0% ${88 + glow * 10}%)`;
    const arm = r * 0.5;
    const thick = r * 0.22;
    ctx.fillRect(cx - arm, cy - thick / 2, arm * 2, thick);
    ctx.fillRect(cx - thick / 2, cy - arm, thick, arm * 2);
  } else if (base === 'boss') {
    // Crown of spikes and a glowing core. It has to be identifiable from the
    // silhouette alone, because at gameplay zoom that is all the player gets.
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2 + 0.2;
      const inner = r * 0.85;
      const outer = r * 1.45 + Math.sin(phase + i) * r * 0.08;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a - 0.16) * inner, cy + Math.sin(a - 0.16) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.lineTo(cx + Math.cos(a + 0.16) * inner, cy + Math.sin(a + 0.16) * inner);
      ctx.closePath();
      ctx.fillStyle = `hsl(${h} 64% 30%)`;
      ctx.fill();
    }
    const glow = 0.5 + 0.5 * Math.sin(phase * 2);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.42 + glow * 0.07), 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${h} 95% ${56 + glow * 22}%)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 70% 22%)`;
    ctx.lineWidth = r * 0.14;
    ctx.stroke();
    // Four eyes rather than two: it should not read as a bigger basic.
    eyes(ctx, cx, cy, r * 1.02, r * 0.34, r * 0.12, h);
    eyes(ctx, cx - r * 0.5, cy, r * 0.5, r * 0.24, r * 0.09, h);
  } else if (base === 'bulwark') {
    // A slab front with a lit visor and a shoulder yoke. The barrier itself is
    // drawn by the renderer at runtime, because it has to shrink and dim as the
    // pool drains -- this sprite is only the thing wearing it.
    ctx.fillStyle = `hsl(${h} 24% 28%)`;
    ctx.beginPath();
    ctx.roundRect(cx - r * 0.95, cy - r * 0.98, r * 0.72, r * 1.96, r * 0.2);
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 34% 66%)`;
    ctx.lineWidth = r * 0.1;
    ctx.stroke();

    plate(0.22, -0.86, 0.22, 0.86);
    plate(-0.28, -0.8, -0.28, 0.8);

    ctx.beginPath();
    ctx.roundRect(cx + r * 0.5, cy - r * 0.3, r * 0.44, r * 0.6, r * 0.14);
    ctx.fillStyle = `hsl(${h} 94% 76%)`;
    ctx.fill();
  } else if (base === 'heavy') {
    // Tusks at the front, and armour bands across the back.
    ctx.fillStyle = `hsl(${h} 30% 88%)`;
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.6, cy + sy * r * 0.3);
      ctx.lineTo(cx + r * 1.25, cy + sy * r * 0.62);
      ctx.lineTo(cx + r * 0.72, cy + sy * r * 0.58);
      ctx.closePath();
      ctx.fill();
    }
    plate(-0.3, -0.8, -0.3, 0.8);
    plate(-0.72, -0.6, -0.72, 0.6);
    eyes(ctx, cx, cy, r * 0.55, r * 0.28, r * 0.1, h);
  } else if (base === 'splitter') {
    // A bloated sac with three pods showing through the skin. It has to look
    // like it is going to burst, because that is the whole information the
    // player needs: kill it away from the pack, or the children join it.
    for (const [ox, oy] of [[-0.3, -0.42], [-0.3, 0.42], [0.28, 0]]) {
      ctx.beginPath();
      ctx.arc(cx + r * ox, cy + r * oy, r * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 55% 34%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 45% 66%)`;
      ctx.lineWidth = r * 0.07;
      ctx.stroke();
    }
    // A breathing seam across the middle, so it is never quite static.
    const swell = 0.5 + 0.5 * Math.sin(phase * 2);
    ctx.strokeStyle = `hsla(${h} 60% 78% / ${0.35 + swell * 0.4})`;
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.9 + swell * 0.1), -0.6, 0.6);
    ctx.stroke();
  } else if (base === 'runner') {
    // Nothing but a nose and a pair of swept fins: at four tiles a second there
    // is no time to read detail, so the silhouette has to do all the work.
    ctx.fillStyle = `hsl(${h} 72% 46%)`;
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.1, cy + sy * r * 0.44);
      ctx.lineTo(cx - r * 0.95, cy + sy * r * 0.82);
      ctx.lineTo(cx - r * 0.5, cy + sy * r * 0.28);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.42, cy, r * 0.5, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = shellLight;
    ctx.fill();
    // A dust plume behind it, which is what sells the speed at this size.
    ctx.fillStyle = `hsla(${h} 40% 80% / 0.28)`;
    ctx.beginPath();
    ctx.ellipse(cx - r * 1.15, cy, r * 0.5, r * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    eyes(ctx, cx, cy, r * 0.46, r * 0.14, r * 0.07, h);
  } else if (base === 'sentinel') {
    /*
      A broad shield face and a lit core. The shield is the information: this
      is the type whose barrier refills faster than chip damage can strip it,
      so it needs to read as armoured from the front the way the bulwark does,
      but with a core that looks *powered* -- the core is what the player
      learns to shoot through with energy or true damage.
    */
    ctx.fillStyle = `hsl(${h} 28% 30%)`;
    ctx.beginPath();
    ctx.roundRect(cx - r * 0.92, cy - r * 1.02, r * 0.66, r * 2.04, r * 0.22);
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 44% 70%)`;
    ctx.lineWidth = r * 0.1;
    ctx.stroke();

    // Shoulder ridge, angled back so the mass reads as leaning into a push.
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.2, cy + sy * r * 0.5);
      ctx.lineTo(cx + r * 0.55, cy + sy * r * 0.95);
      ctx.lineTo(cx + r * 0.6, cy + sy * r * 0.55);
      ctx.closePath();
      ctx.fillStyle = `hsl(${h} 34% 44%)`;
      ctx.fill();
    }

    // A hexagonal core rather than a round one, so it differs from every visor
    // in the roster at a glance.
    const pulse = 0.5 + 0.5 * Math.sin(phase * 2);
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const px = cx + r * 0.16 + Math.cos(a) * r * 0.42;
      const py = cy + Math.sin(a) * r * 0.42;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = `hsl(${h} 88% ${52 + pulse * 24}%)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 60% 20%)`;
    ctx.lineWidth = r * 0.09;
    ctx.stroke();
  } else if (base === 'husk') {
    /*
      A scorched carapace. The fissures are the tell: they glow the colour of a
      fire that has already been through it, which is what the player is meant
      to read as "this one is not going to burn". The plate covers the back and
      leaves the front bare, like the armored, so the two read as the same
      family of ground brute with different reasons for being tough.
    */
    const ember = 0.5 + 0.5 * Math.sin(phase * 2);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.95, cy - r * 0.6);
    ctx.lineTo(cx - r * 0.15, cy - r * 1.05);
    ctx.lineTo(cx + r * 0.75, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.55, cy + r * 0.68);
    ctx.lineTo(cx - r * 0.6, cy + r * 0.86);
    ctx.closePath();
    ctx.fillStyle = `hsl(${h} 16% 24%)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 26% 12%)`;
    ctx.lineWidth = r * 0.1;
    ctx.stroke();

    ctx.strokeStyle = `hsla(${h} 94% ${56 + ember * 20}% / 0.9)`;
    ctx.lineWidth = Math.max(1.5, r * 0.085);
    for (let i = -1; i <= 1; i += 1) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.8, cy + i * r * 0.44);
      ctx.lineTo(cx - r * 0.1, cy + i * r * 0.24);
      ctx.lineTo(cx + r * 0.5, cy + i * r * 0.52);
      ctx.stroke();
    }
    eyes(ctx, cx, cy, r * 0.8, r * 0.22, r * 0.09, h);
  } else if (base === 'overseer') {
    /*
      The support read. A wide halo rather than the healer's cross, because the
      radius is the thing that matters here and the halo can be drawn at the
      size of the aura it stands for. Three motes orbit it so the eye is pulled
      to the unit that is keeping everything else alive -- which is exactly the
      reaction the type is designed to provoke.
    */
    const spin = phase;
    const glow = 0.5 + 0.5 * Math.sin(phase * 2);

    ctx.strokeStyle = `hsla(${h} 74% 76% / ${0.34 + glow * 0.4})`;
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.beginPath();
    ctx.ellipse(cx, cy - r * 1.05, r * 1.15, r * 0.34, 0, 0, Math.PI * 2);
    ctx.stroke();

    // The staff, and the mote it is holding up.
    ctx.strokeStyle = `hsl(${h} 34% 28%)`;
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.36, cy + r * 0.74);
    ctx.lineTo(cx + r * 0.36, cy - r * 0.76);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + r * 0.36, cy - r * 0.96, r * 0.2 * (1 + glow * 0.14), 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${h} 95% ${62 + glow * 22}%)`;
    ctx.fill();

    ctx.fillStyle = `hsla(${h} 90% 80% / 0.9)`;
    for (let i = 0; i < 3; i += 1) {
      const a = spin + (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.5, r * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }
    eyes(ctx, cx, cy, r * 0.72, r * 0.2, r * 0.085, h);
  } else if (base === 'obsidian') {
    /*
      Faceted rather than curved. Every other tough type in the roster is a
      slab; this one is a set of sharp planes, so the silhouette says "glass"
      before the colour says "resistant" -- and a dark, glossy surface is what
      the player reads as energy sliding off it. The polygon is drawn slightly
      wider than the body disc so no rounded edge survives underneath it.
    */
    const facets = [
      [-0.93, -0.22], [-0.32, -1.03], [0.37, -0.84],
      [0.99, -0.06], [0.54, 0.86], [-0.26, 1.04], [-0.86, 0.56],
    ];
    ctx.beginPath();
    for (let i = 0; i < facets.length; i += 1) {
      const px = cx + facets[i][0] * r;
      const py = cy + facets[i][1] * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = `hsl(${h} 44% 18%)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 72% 74%)`;
    ctx.lineWidth = Math.max(1.5, r * 0.09);
    ctx.stroke();

    // Interior facet lines, so it reads as a cut gem and not a black blob.
    ctx.strokeStyle = `hsla(${h} 60% 62% / 0.5)`;
    ctx.lineWidth = Math.max(1, r * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.93, cy - r * 0.22);
    ctx.lineTo(cx + r * 0.2, cy + r * 0.12);
    ctx.lineTo(cx + r * 0.99, cy - r * 0.06);
    ctx.moveTo(cx - r * 0.32, cy - r * 1.03);
    ctx.lineTo(cx + r * 0.2, cy + r * 0.12);
    ctx.lineTo(cx - r * 0.26, cy + r * 1.04);
    ctx.stroke();

    // One thin bright core: the only thing on it that is not absorbing.
    const spark = 0.5 + 0.5 * Math.sin(phase * 2);
    ctx.beginPath();
    ctx.arc(cx + r * 0.44, cy, r * 0.14 * (1 + spark * 0.3), 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${h} 96% ${62 + spark * 22}%)`;
    ctx.fill();
  } else if (base === 'behemoth') {
    /*
      The barrier is drawn by the renderer at runtime, so this sprite is only
      the thing underneath it. Broader and squarer than the colossus, with a
      vent bank across the back rather than that type's plate rows: slabs say
      armour, vents say something is feeding the pool. The two have to be
      separable at a glance because they ask for opposite answers.
    */
    ctx.beginPath();
    ctx.roundRect(cx - r * 1.02, cy - r * 0.94, r * 1.88, r * 1.88, r * 0.3);
    ctx.fillStyle = `hsl(${h} 18% 22%)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 34% 58%)`;
    ctx.lineWidth = r * 0.13;
    ctx.stroke();

    const vent = 0.5 + 0.5 * Math.sin(phase * 2);
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath();
      ctx.roundRect(cx - r * 0.88, cy - r * 0.52 + i * r * 0.3, r * 0.48, r * 0.16, r * 0.06);
      ctx.fillStyle = `hsl(${h} 94% ${28 + vent * 36}%)`;
      ctx.fill();
    }

    // Blast visor, set square to the front and wider than the colossus'.
    ctx.beginPath();
    ctx.roundRect(cx + r * 0.38, cy - r * 0.44, r * 0.52, r * 0.88, r * 0.14);
    ctx.fillStyle = `hsl(${h} 28% 12%)`;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(cx + r * 0.46, cy - r * 0.3, r * 0.36, r * 0.6, r * 0.1);
    ctx.fillStyle = `hsl(${h} 90% 62%)`;
    ctx.fill();

    // Four eyes, so it is never mistaken for a heavy.
    eyes(ctx, cx - r * 0.22, cy, r * 0.9, r * 0.34, r * 0.1, h);
  } else if (base === 'marauder') {
    /*
      Built to be identified in the half-second it spends inside a tower's
      range. A hard arrowhead, a swept tail, and a heat haze streaming off it --
      no round edges anywhere, because round is what the rest of the roster
      looks like and this one has to stand out the moment it arrives.
    */
    ctx.beginPath();
    ctx.moveTo(cx + r * 1.28, cy);
    ctx.lineTo(cx - r * 0.1, cy - r * 0.74);
    ctx.lineTo(cx - r * 0.64, cy - r * 0.3);
    ctx.lineTo(cx - r * 0.64, cy + r * 0.3);
    ctx.lineTo(cx - r * 0.1, cy + r * 0.74);
    ctx.closePath();
    ctx.fillStyle = `hsl(${h} 88% 56%)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 70% 20%)`;
    ctx.lineWidth = r * 0.1;
    ctx.stroke();

    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy + sy * r * 0.28);
      ctx.lineTo(cx - r * 1.34, cy + sy * r * 0.88);
      ctx.lineTo(cx - r * 0.72, cy + sy * r * 0.16);
      ctx.closePath();
      ctx.fillStyle = `hsl(${h} 74% 42%)`;
      ctx.fill();
    }

    // Heat haze. At this size it is what actually sells the speed.
    ctx.fillStyle = `hsla(${h} 70% 84% / 0.3)`;
    for (let i = 1; i <= 3; i += 1) {
      ctx.beginPath();
      ctx.ellipse(
        cx - r * (0.9 + i * 0.34), cy,
        r * (0.34 - i * 0.06), r * (0.2 - i * 0.04), 0, 0, Math.PI * 2,
      );
      ctx.fill();
    }
    eyes(ctx, cx, cy, r * 0.5, r * 0.16, r * 0.07, h);
  } else if (base === 'colossus') {
    /*
      The armour wall. It has to look like the shots are not landing: layered
      slabs over the whole body, a chunky blast visor, and four eyes rather
      than two so it is never mistaken for a heavy at a glance.
    */
    ctx.fillStyle = `hsl(${h} 22% 26%)`;
    ctx.beginPath();
    ctx.roundRect(cx - r * 0.85, cy - r * 1.05, r * 1.5, r * 2.1, r * 0.26);
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 38% 62%)`;
    ctx.lineWidth = r * 0.12;
    ctx.stroke();

    plate(0.3, -0.92, 0.3, 0.92);
    plate(-0.22, -0.88, -0.22, 0.88);
    plate(-0.62, -0.74, -0.62, 0.74);

    // A heavy blast visor, scored across so it reads as thick rather than dark.
    ctx.beginPath();
    ctx.roundRect(cx + r * 0.42, cy - r * 0.36, r * 0.5, r * 0.72, r * 0.14);
    ctx.fillStyle = `hsl(${h} 30% 10%)`;
    ctx.fill();
    ctx.fillStyle = `hsl(${h} 90% 62%)`;
    ctx.beginPath();
    ctx.roundRect(cx + r * 0.5, cy - r * 0.26, r * 0.34, r * 0.52, r * 0.12);
    ctx.fill();
    ctx.strokeStyle = `hsl(${h} 30% 8%)`;
    ctx.lineWidth = r * 0.05;
    for (let i = -1; i <= 1; i += 1) {
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.5, cy + i * r * 0.16);
      ctx.lineTo(cx + r * 0.84, cy + i * r * 0.16);
      ctx.stroke();
    }

    eyes(ctx, cx, cy, r * 0.9, r * 0.62, r * 0.1, h);
    eyes(ctx, cx - r * 0.34, cy, r * 0.48, r * 0.3, r * 0.075, h);
  } else if (base === 'hive') {
    /*
      A brood sac. Where the splitter shows three pods through the skin, the
      hive is a honeycomb of them -- the count is the message, because five
      children is a different problem from two and the player should see it
      coming rather than learn it from a leak.
    */
    const swell = 0.5 + 0.5 * Math.sin(phase * 2);
    for (let ring = 0; ring < 2; ring += 1) {
      const count = ring === 0 ? 1 : 6;
      const dist = ring === 0 ? 0 : r * 0.58;
      for (let i = 0; i < count; i += 1) {
        const a = (i / count) * Math.PI * 2 + ring * 0.4;
        const px = cx + Math.cos(a) * dist;
        const py = cy + Math.sin(a) * dist;
        ctx.beginPath();
        ctx.arc(px, py, r * (ring === 0 ? 0.34 : 0.26) * (1 + swell * 0.05), 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${h} 58% ${30 + ring * 6}%)`;
        ctx.fill();
        ctx.strokeStyle = `hsl(${h} 48% 68%)`;
        ctx.lineWidth = r * 0.06;
        ctx.stroke();
      }
    }
    // A rim that swells against the pods, so the whole thing looks about to
    // give way.
    ctx.strokeStyle = `hsla(${h} 62% 80% / ${0.3 + swell * 0.4})`;
    ctx.lineWidth = Math.max(1.5, r * 0.11);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.92 + swell * 0.12), 0, Math.PI * 2);
    ctx.stroke();
  } else if (base === 'swarmling') {
    // A runt: spikes out, no antenna, and a fast scuttle. It only ever appears
    // in fives, so it has to be cheap to draw and instantly countable.
    ctx.fillStyle = `hsl(${h} 74% 50%)`;
    for (let i = 0; i < 7; i += 1) {
      const a = (i / 7) * Math.PI * 2 + phase * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a - 0.2) * r * 0.7, cy + Math.sin(a - 0.2) * r * 0.7);
      ctx.lineTo(cx + Math.cos(a) * r * 1.25, cy + Math.sin(a) * r * 1.25);
      ctx.lineTo(cx + Math.cos(a + 0.2) * r * 0.7, cy + Math.sin(a + 0.2) * r * 0.7);
      ctx.closePath();
      ctx.fill();
    }
    eyes(ctx, cx, cy, r * 0.4, r * 0.16, r * 0.08, h);
  } else if (base === 'fast') {
    // Swept fins and a tapered nose: everything about it should say speed.
    ctx.fillStyle = `hsl(${h} 66% 44%)`;
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.2, cy + sy * r * 0.5);
      ctx.lineTo(cx - r * 1.15, cy + sy * r * 0.95);
      ctx.lineTo(cx - r * 0.55, cy + sy * r * 0.35);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.5, cy, r * 0.42, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = shellLight;
    ctx.fill();
    eyes(ctx, cx, cy, r * 0.5, r * 0.16, r * 0.075, h);
  } else {
    // basic: plain, but with a wobbling antenna so it is never quite still.
    const wob = Math.sin(phase * 1.5) * 0.35;
    ctx.strokeStyle = shellDark;
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.3, cy - r * 0.5);
    ctx.quadraticCurveTo(cx - r * 0.6, cy - r * 1.2, cx - r * 0.9 + wob * r, cy - r * 1.3);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - r * 0.9 + wob * r, cy - r * 1.3, r * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${h} 90% 70%)`;
    ctx.fill();
    eyes(ctx, cx, cy, r * 0.45, r * 0.22, r * 0.1, h);
  }
}

/**
 * Turret draw scale.
 *
 * A weapon occupying its literal share of the cell looks undersized next to a
 * platform that fills it. Scaling the whole turret set up keeps the two sheets
 * visually balanced without touching any individual measurement.
 */
const TURRET_SCALE = 1.4;

/** Regular n-gon path, centred, with an optional rotation. */
function ngon(ctx, cx, cy, r, sides, rotation = 0) {
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const a = rotation + (i / sides) * Math.PI * 2;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** A ring of bolt heads, for anything that should look bolted down. */
function bolts(ctx, cx, cy, r, count, size, color, rotation = 0) {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i += 1) {
    const a = rotation + (i / count) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Tower platforms. One silhouette per tower type.
 *
 * The base is what a tower is *installed* on, so these are structures -- pads,
 * bunkers, drums, nests -- rather than weapons. The gun is a separate sheet so
 * it can rotate independently, and the split is also what lets a platform read
 * as heavy without the turret having to.
 *
 * `frame` drives a slow status pulse (blinking lights, a breathing membrane).
 * Four frames at 4fps is not much animation, but a completely static board of
 * buildings is the single biggest thing that makes a tower defence look dead.
 */
function drawTowerBase(ctx, x, y, fw, fh, key, frame = 0, frames = 1) {
  const h = hue(key, TOWER_HUES);
  const cx = x + fw / 2;
  const cy = y + fh / 2;
  const pulse = 0.5 + 0.5 * Math.sin((frame / Math.max(1, frames)) * Math.PI * 2);

  const dark = `hsl(${h} 22% 25%)`;
  const mid = `hsl(${h} 20% 34%)`;
  const edge = `hsl(${h} 26% 48%)`;
  const deep = `hsl(${h} 30% 15%)`;
  const lit = `hsl(${h} 88% ${52 + pulse * 22}%)`;

  // Barracks are the only base with promoted ranks, and which ranks exist is
  // data, so they are dispatched before the switch rather than as a case per
  // rank that would have to grow with data/barracks.json.
  if (key === 'barracks' || key.startsWith('barracks_')) {
    // `drawBarracks` computes its own centre from the cell's top-left corner,
    // so pass `x`/`y` rather than the already-centred `cx`/`cy` -- passing the
    // centre here double-offsets every rank half a tile, which is how the
    // barracks shipped drawn into the corner of its own cell.
    drawBarracks(ctx, x, y, fw, fh, barracksRankOf(key), pulse);
    return;
  }

  switch (key) {
    // Tripod scout mount: three thin legs, nothing else to carry.
    case 'basic': {
      for (let i = 0; i < 3; i += 1) {
        const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
        ctx.strokeStyle = i === 1 ? edge : mid;
        ctx.lineWidth = fw * 0.06;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * fw * 0.4, cy + Math.sin(a) * fw * 0.4);
        ctx.stroke();
      }
      // Foot pads at each leg tip.
      ctx.fillStyle = deep;
      for (let i = 0; i < 3; i += 1) {
        const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * fw * 0.4, cy + Math.sin(a) * fw * 0.4, fw * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
      // A tiny status lamp at the hub.
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.05, 0, Math.PI * 2);
      ctx.fillStyle = lit;
      ctx.fill();
      break;
    }

    // Squat hexagon bunker, walls thick enough to imply real recoil.
    case 'cannon': {
      ngon(ctx, cx, cy, fw * 0.44, 6, 0);
      ctx.fillStyle = dark;
      ctx.fill();
      ngon(ctx, cx, cy, fw * 0.36, 6, 0);
      ctx.fillStyle = mid;
      ctx.fill();
      ctx.strokeStyle = deep;
      ctx.lineWidth = fw * 0.04;
      ngon(ctx, cx, cy, fw * 0.36, 6, 0);
      ctx.stroke();
      // Embrasure: a notch cut toward the front.
      ctx.fillStyle = deep;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.12, cy - fh * 0.12, fw * 0.3, fh * 0.24, fh * 0.04);
      ctx.fill();
      bolts(ctx, cx, cy, fw * 0.3, 6, fw * 0.026, edge, 0.3);
      break;
    }

    // Crystal housing: an ice pad under a ring of prongs that glow.
    case 'frost': {
      ngon(ctx, cx, cy, fw * 0.42, 6, Math.PI / 6);
      ctx.fillStyle = `hsl(${h} 30% 30%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 46% 52%)`;
      ctx.lineWidth = fw * 0.035;
      ctx.stroke();
      for (let i = 0; i < 6; i += 1) {
        const a = Math.PI / 6 + (i / 6) * Math.PI * 2;
        const px = cx + Math.cos(a) * fw * 0.36;
        const py = cy + Math.sin(a) * fw * 0.36;
        ngon(ctx, px, py, fw * 0.07, 4, a);
        ctx.fillStyle = i % 2 === 0 ? lit : `hsl(${h} 60% 62%)`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.17, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 55% ${30 + pulse * 14}%)`;
      ctx.fill();
      break;
    }

    // Coil pad: three insulator posts around a ceramic deck.
    case 'tesla': {
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = dark;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.33, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 26% 40%)`;
      ctx.fill();
      ctx.strokeStyle = deep;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        const px = cx + Math.cos(a) * fw * 0.34;
        const py = cy + Math.sin(a) * fw * 0.34;
        ctx.beginPath();
        ctx.arc(px, py, fw * 0.08, 0, Math.PI * 2);
        ctx.fillStyle = mid;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, fw * 0.04, 0, Math.PI * 2);
        ctx.fillStyle = lit;
        ctx.fill();
      }
      bolts(ctx, cx, cy, fw * 0.24, 6, fw * 0.018, edge, 0);
      break;
    }

    // Organic sac: irregular, no straight lines anywhere.
    case 'venom': {
      ctx.beginPath();
      for (let i = 0; i <= 22; i += 1) {
        const a = (i / 22) * Math.PI * 2;
        // Two harmonics give a lumpy outline that is stable across frames.
        const wob = 1 + 0.11 * Math.sin(a * 3 + 1.1) + 0.06 * Math.sin(a * 5);
        const r = fw * 0.42 * wob * (1 + pulse * 0.03);
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = `hsl(${h} 26% 30%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 34% 46%)`;
      ctx.lineWidth = fw * 0.035;
      ctx.stroke();
      // Blisters that swell on the pulse.
      for (let i = 0; i < 4; i += 1) {
        const a = i * 1.7 + 0.4;
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(a) * fw * 0.2,
          cy + Math.sin(a) * fw * 0.2,
          fw * (0.05 + pulse * 0.025),
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = `hsl(${h} 44% ${40 + pulse * 12}%)`;
        ctx.fill();
      }
      break;
    }

    // Nest: a long pad, sandbags along the flanks, brass underfoot.
    case 'sniper': {
      ctx.beginPath();
      ctx.roundRect(cx - fw * 0.42, cy - fh * 0.3, fw * 0.84, fh * 0.6, fw * 0.05);
      ctx.fillStyle = `hsl(${h} 12% 32%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 14% 46%)`;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      for (let i = 0; i < 5; i += 1) {
        const px = cx - fw * 0.34 + i * fw * 0.17;
        for (const sy of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(px, cy + sy * fh * 0.32, fw * 0.08, fh * 0.055, 0, 0, Math.PI * 2);
          ctx.fillStyle = `hsl(${h} 10% ${34 + (i % 2) * 6}%)`;
          ctx.fill();
        }
      }
      ctx.fillStyle = `hsl(44 62% 58%)`;
      for (let i = 0; i < 4; i += 1) {
        ctx.beginPath();
        ctx.roundRect(cx - fw * 0.3 + i * fw * 0.2, cy + fh * 0.06, fw * 0.05, fh * 0.1, fw * 0.01);
        ctx.fill();
      }
      break;
    }

    // Ammo turntable: two crates feeding a central ring.
    case 'gatling': {
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = mid;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.035;
      ctx.stroke();
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.roundRect(cx + sx * fw * 0.34 - fw * 0.09, cy - fh * 0.13, fw * 0.18, fh * 0.26, fw * 0.02);
        ctx.fillStyle = `hsl(${h} 18% 28%)`;
        ctx.fill();
        ctx.strokeStyle = `hsl(${h} 22% 44%)`;
        ctx.lineWidth = fw * 0.02;
        ctx.stroke();
      }
      // Feed belt from the left crate into the ring.
      ctx.strokeStyle = `hsl(44 40% 46%)`;
      ctx.lineWidth = fw * 0.045;
      ctx.beginPath();
      ctx.moveTo(cx - fw * 0.3, cy - fh * 0.02);
      ctx.quadraticCurveTo(cx - fw * 0.14, cy + fh * 0.12, cx - fw * 0.02, cy);
      ctx.stroke();
      bolts(ctx, cx, cy, fw * 0.26, 6, fw * 0.019, edge, 0.4);
      break;
    }

    // Fuel drums on a hot grate.
    case 'flamethrower': {
      ngon(ctx, cx, cy, fw * 0.4, 4, Math.PI / 4);
      ctx.fillStyle = `hsl(${h} 16% 24%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 20% 40%)`;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.roundRect(cx - fw * 0.3 + (sx > 0 ? fw * 0.34 : 0), cy - fh * 0.16, fw * 0.17, fh * 0.32, fw * 0.055);
        ctx.fillStyle = `hsl(${h} 30% 36%)`;
        ctx.fill();
        ctx.strokeStyle = `hsl(${h} 36% 52%)`;
        ctx.lineWidth = fw * 0.022;
        ctx.stroke();
      }
      // Grate slats, glowing with the pilot light.
      ctx.strokeStyle = `hsl(${h} 70% ${34 + pulse * 16}%)`;
      ctx.lineWidth = fw * 0.028;
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.moveTo(cx - fw * 0.1, cy - fh * 0.1 + i * fh * 0.1);
        ctx.lineTo(cx + fw * 0.1, cy - fh * 0.1 + i * fh * 0.1);
        ctx.stroke();
      }
      break;
    }

    // Launcher pad with a back blast deflector.
    case 'missile': {
      ctx.beginPath();
      ctx.roundRect(cx - fw * 0.42, cy - fh * 0.34, fw * 0.84, fh * 0.68, fw * 0.05);
      ctx.fillStyle = `hsl(${h} 18% 30%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 22% 46%)`;
      ctx.lineWidth = fw * 0.032;
      ctx.stroke();
      // Deflector plate at the rear, so the shape is visibly directional.
      ctx.beginPath();
      ctx.moveTo(cx - fw * 0.42, cy - fh * 0.3);
      ctx.lineTo(cx - fw * 0.26, cy);
      ctx.lineTo(cx - fw * 0.42, cy + fh * 0.3);
      ctx.closePath();
      ctx.fillStyle = `hsl(${h} 24% 22%)`;
      ctx.fill();
      ctx.fillStyle = lit;
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.arc(cx + fw * 0.06, cy - fh * 0.18 + i * fh * 0.18, fw * 0.028, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    // Mortar pit: a circular plate with sandbags and levelling spades.
    case 'mortar': {
      ctx.beginPath();
      ctx.ellipse(cx, cy, fw * 0.44, fh * 0.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 14% 27%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 16% 42%)`;
      ctx.lineWidth = fw * 0.035;
      ctx.stroke();
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2 + 0.2;
        ctx.beginPath();
        ctx.ellipse(
          cx + Math.cos(a) * fw * 0.4,
          cy + Math.sin(a) * fh * 0.36,
          fw * 0.1,
          fh * 0.07,
          a,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = `hsl(${h} 12% ${30 + (i % 3) * 5}%)`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 18% 20%)`;
      ctx.fill();
      break;
    }

    // Energy emitter mount: a slim three-prong heat sink, no heavy slab.
    case 'laser': {
      for (let i = 0; i < 3; i += 1) {
        const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
        ctx.strokeStyle = mid;
        ctx.lineWidth = fw * 0.05;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * fw * 0.12, cy + Math.sin(a) * fw * 0.12);
        ctx.lineTo(cx + Math.cos(a) * fw * 0.36, cy + Math.sin(a) * fw * 0.36);
        ctx.stroke();
        // A cooling fin pod at each tip.
        ctx.fillStyle = edge;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * fw * 0.36, cy + Math.sin(a) * fw * 0.36, fw * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
      // Central ring with a glowing lens.
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.13, 0, Math.PI * 2);
      ctx.fillStyle = dark;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.025;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, fw * (0.05 + pulse * 0.02), 0, Math.PI * 2);
      ctx.fillStyle = lit;
      ctx.fill();
      break;
    }

    // Old West: a weathered plank round.
    case 'sixshooter': {
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 22% 28%)`;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.032;
      ctx.stroke();
      for (let i = 0; i < 4; i += 1) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.roundRect(cx + Math.cos(a) * fw * 0.36 - fw * 0.07, cy + Math.sin(a) * fw * 0.36 - fh * 0.05, fw * 0.14, fh * 0.1, fw * 0.02);
        ctx.fillStyle = `hsl(${h} 14% 20%)`;
        ctx.fill();
      }
      bolts(ctx, cx, cy, fw * 0.22, 4, fw * 0.02, edge, 0.4);
      break;
    }

    // Old West: a crate of dynamite, fuse coiled on top.
    case 'dynamite': {
      ctx.beginPath();
      ctx.roundRect(cx - fw * 0.36, cy - fh * 0.3, fw * 0.72, fh * 0.6, fw * 0.05);
      ctx.fillStyle = `hsl(${h} 16% 26%)`;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      // Sticks poking out, each with a tiny red cap.
      for (let i = 0; i < 3; i += 1) {
        const px = cx + (i - 1) * fw * 0.18;
        ctx.fillStyle = `hsl(${h} 30% 42%)`;
        ctx.beginPath();
        ctx.roundRect(px - fw * 0.045, cy - fh * 0.22, fw * 0.09, fh * 0.24, fw * 0.02);
        ctx.fill();
        ctx.fillStyle = `hsl(0 70% ${46 + pulse * 14}%)`;
        ctx.beginPath();
        ctx.arc(px, cy - fh * 0.2, fw * 0.025, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    // Pirates: a barrel of shot with an open mouth.
    case 'grapeshot': {
      ctx.beginPath();
      ctx.ellipse(cx, cy, fw * 0.36, fh * 0.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 14% 26%)`;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      // Iron hoops.
      for (const sy of [-0.5, 0, 0.5]) {
        ctx.beginPath();
        ctx.ellipse(cx, cy + sy * fh * 0.24, fw * 0.36, fh * 0.05, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `hsl(${h} 8% 16%)`;
        ctx.lineWidth = fw * 0.035;
        ctx.stroke();
      }
      // Scattered shot in the mouth.
      ctx.fillStyle = `hsl(44 20% ${48 + pulse * 12}%)`;
      for (let i = 0; i < 5; i += 1) {
        ctx.beginPath();
        ctx.arc(cx + ((i % 2) - 0.5) * fw * 0.2, cy - fh * 0.06 + ((i / 2 | 0) - 0.5) * fh * 0.16, fw * 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    // Pirates: a coiled rope winch.
    case 'harpoon': {
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 14% 24%)`;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      // Coiled cable.
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, fw * (0.1 + i * 0.09), 0, Math.PI * 2);
        ctx.strokeStyle = `hsl(${h} 20% ${34 + i * 6}%)`;
        ctx.lineWidth = fw * 0.05;
        ctx.stroke();
      }
      break;
    }

    // Flash Gordon: a glowing energy cell on a ring mount.
    case 'raygun': {
      ngon(ctx, cx, cy, fw * 0.38, 6, 0);
      ctx.fillStyle = `hsl(${h} 22% 28%)`;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, fw * (0.16 + pulse * 0.05), 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 90% ${54 + pulse * 20}%)`;
      ctx.fill();
      break;
    }

    // Flash Gordon: a satellite dish aimed at the sky.
    case 'ioncannon': {
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 16% 22%)`;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.03;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.24, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 24% 34%)`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, fw * (0.08 + pulse * 0.03), 0, Math.PI * 2);
      ctx.fillStyle = lit;
      ctx.fill();
      break;
    }

    default: {
      ngon(ctx, cx, cy, fw * 0.4, 6, 0);
      ctx.fillStyle = mid;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = fw * 0.035;
      ctx.stroke();
    }
  }
}

/** `barracks_3` -> 0-based rank 2. A bare `barracks` is rank 0. */
function barracksRankOf(key) {
  const n = Number.parseInt(key.slice('barracks'.length + 1), 10);
  return Number.isFinite(n) && n > 0 ? n - 1 : 0;
}

/**
 * Barracks promotions: one structure per rank, from a survey relay to a
 * battlestation.
 *
 * The building is the only part of a barracks a player can see without opening
 * the inspector, so these exist to make evolution legible on the board. A
 * structure that looks the same at level 1 and level 10 is a mechanic the player
 * has to read about instead of noticing.
 *
 * All five share one hue, one footprint and one motif -- a hexagonal landing
 * pad with a reactor core at its centre -- so they read as one line of upgrades
 * rather than five unrelated buildings. What escalates is the armour wrapped
 * around that core: three anchor struts, then a sealed bunker, then a command
 * ring, then a double-walled citadel, then a full battlestation. The green
 * reactor is the "is anyone home" tell, and it is what the support aura is
 * supposed to read as: a powered structure, not a castle.
 *
 * `rank` is 0-based; `pulse` is 0..1 and drives the core and the status lamps.
 */
function drawBarracks(ctx, x, y, fw, fh, rank, pulse) {
  const cx = x + fw / 2;
  const cy = y + fh / 2;

  // The olive the barracks has always been, kept so a promoted structure still
  // matches the shop button that builds it.
  const h = 96;
  const hull = `hsl(${h} 12% 26%)`;
  const hullLit = `hsl(${h} 14% 42%)`;
  const hullDark = `hsl(${h} 16% 15%)`;
  const edge = `hsl(${h} 22% 54%)`;
  const pad = `hsl(${h} 10% 11%)`;
  const padRing = `hsl(${h} 14% 26%)`;
  const glow = `hsl(150 88% ${50 + pulse * 26}%)`;
  const glowRing = `hsl(150 80% ${40 + pulse * 30}%)`;
  const lamp = `hsl(150 90% ${58 + pulse * 18}%)`;

  /** The shared landing pad every rank is built on. */
  const groundPad = (r) => {
    ngon(ctx, cx, cy, r, 6, Math.PI / 6);
    ctx.fillStyle = pad;
    ctx.fill();
    ngon(ctx, cx, cy, r, 6, Math.PI / 6);
    ctx.strokeStyle = padRing;
    ctx.lineWidth = fw * 0.016;
    ctx.stroke();
    ngon(ctx, cx, cy, r * 0.8, 6, Math.PI / 6);
    ctx.strokeStyle = `hsl(${h} 12% 17%)`;
    ctx.lineWidth = fw * 0.01;
    ctx.stroke();
  };

  /** The reactor: a dark socket with a glowing heart, the one motif every rank shares. */
  const core = (r, bright = false) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = hullDark;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = fw * 0.02;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.58 + pulse * 0.1), 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
    if (bright) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1.15 + pulse * 0.08), 0, Math.PI * 2);
      ctx.strokeStyle = glowRing;
      ctx.lineWidth = fw * 0.02;
      ctx.stroke();
    }
  };

  /** An armoured anchor strut pointing at the core, lit at its outer end. */
  const pylon = (px, py, s) => {
    const a = Math.atan2(cy - py, cx - px);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(-s * 0.55, s * 0.85);
    ctx.lineTo(-s * 0.55, -s * 0.85);
    ctx.lineTo(s * 0.5, -s * 0.26);
    ctx.lineTo(s * 0.5, s * 0.26);
    ctx.closePath();
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = fw * 0.014;
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(px, py, s * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = lamp;
    ctx.fill();
  };

  /** A thin signal mast with a blinking lamp. */
  const mast = (mx, my, mh) => {
    ctx.strokeStyle = edge;
    ctx.lineWidth = fw * 0.02;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx, my - mh);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my - mh - fw * 0.01, fw * (pulse > 0.45 ? 0.032 : 0.026), 0, Math.PI * 2);
    ctx.fillStyle = pulse > 0.45 ? lamp : `hsl(${h} 14% 28%)`;
    ctx.fill();
  };

  groundPad(fw * 0.46);

  if (rank <= 0) {
    // ---------------------------------------------------------- Survey relay
    // Three anchors hold up a bare core and a signal mast: a claim staked out.
    for (let i = 0; i < 3; i += 1) {
      const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
      pylon(cx + Math.cos(a) * fw * 0.27, cy + Math.sin(a) * fh * 0.27, fw * 0.09);
    }
    core(fw * 0.15);
    mast(cx + fw * 0.19, cy - fh * 0.06, fh * 0.32);
    return;
  }

  if (rank === 1) {
    // ------------------------------------------------------- Sealed bunker
    // A solid hex hull with the core set into it, bolted to the pad.
    ngon(ctx, cx, cy, fw * 0.34, 6, Math.PI / 6);
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = fw * 0.03;
    ctx.stroke();
    ngon(ctx, cx, cy, fw * 0.25, 6, Math.PI / 6);
    ctx.fillStyle = hullLit;
    ctx.fill();
    ctx.strokeStyle = hullDark;
    ctx.lineWidth = fw * 0.02;
    ctx.stroke();
    bolts(ctx, cx, cy, fw * 0.34, 6, fw * 0.026, edge, Math.PI / 6);
    core(fw * 0.19, true);
    return;
  }

  if (rank === 2) {
    // --------------------------------------------------------- Command post
    // The bunker grows a ring and four anchors: it is directing, not hiding.
    ngon(ctx, cx, cy, fw * 0.36, 6, Math.PI / 6);
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = fw * 0.03;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, fw * 0.27, 0, Math.PI * 2);
    ctx.strokeStyle = hullLit;
    ctx.lineWidth = fw * 0.035;
    ctx.stroke();
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      pylon(cx + sx * fw * 0.25, cy + sy * fh * 0.25, fw * 0.08);
    }
    core(fw * 0.21, true);
    return;
  }

  if (rank === 3) {
    // ------------------------------------------------------------- Citadel
    // Twin walls with conduit spokes feeding the core from every flat.
    ngon(ctx, cx, cy, fw * 0.39, 6, Math.PI / 6);
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = fw * 0.03;
    ctx.stroke();
    ngon(ctx, cx, cy, fw * 0.27, 6, Math.PI / 6);
    ctx.fillStyle = hullLit;
    ctx.fill();
    ctx.strokeStyle = hullDark;
    ctx.lineWidth = fw * 0.022;
    ctx.stroke();

    // Conduits from the outer wall to the core.
    ctx.strokeStyle = glowRing;
    ctx.lineWidth = fw * 0.012;
    for (let i = 0; i < 6; i += 1) {
      const a = Math.PI / 6 + (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * fw * 0.15, cy + Math.sin(a) * fh * 0.15);
      ctx.lineTo(cx + Math.cos(a) * fw * 0.37, cy + Math.sin(a) * fh * 0.37);
      ctx.stroke();
    }

    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      pylon(cx + sx * fw * 0.28, cy + sy * fh * 0.28, fw * 0.085);
    }
    core(fw * 0.23, true);
    mast(cx - fw * 0.2, cy + fh * 0.1, fh * 0.32);
    return;
  }

  // ---------------------------------------------------------- Battlestation
  // No longer a structure: a full armoured platform with pods and a live core.
  ngon(ctx, cx, cy, fw * 0.44, 6, Math.PI / 6);
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = fw * 0.035;
  ctx.stroke();

  ngon(ctx, cx, cy, fw * 0.34, 6, Math.PI / 6);
  ctx.fillStyle = hullLit;
  ctx.fill();
  ctx.strokeStyle = hullDark;
  ctx.lineWidth = fw * 0.02;
  ctx.stroke();

  // Turret pods, one per flat of the hexagon.
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = cx + Math.cos(a) * fw * 0.33;
    const py = cy + Math.sin(a) * fh * 0.31;
    ctx.beginPath();
    ctx.arc(px, py, fw * 0.055, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${h} 16% 46%)`;
    ctx.fill();
    ctx.strokeStyle = hullDark;
    ctx.lineWidth = fw * 0.014;
    ctx.stroke();

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.fillStyle = `hsl(${h} 18% 58%)`;
    ctx.beginPath();
    ctx.roundRect(0, -fw * 0.017, fw * 0.1, fw * 0.034, fw * 0.012);
    ctx.fill();
    ctx.restore();
  }

  core(fw * 0.19, true);
  mast(cx + fw * 0.19, cy - fh * 0.1, fh * 0.32);
}

/**
 * Turret weapons. All face +x, so a turret angle maps onto a z rotation with
 * no per-tower offset.
 *
 * Anything without a literal barrel is drawn as its emitter instead -- a coil
 * stack for the tesla, a crystal cluster for the frost -- because "gun" is the
 * wrong shape for a tower that does not fire a projectile.
 */
function drawTowerTurret(ctx, x, y, fw, fh, key, frame = 0, frames = 1) {
  const h = hue(key, TOWER_HUES);
  const cx = x + fw / 2;
  const cy = y + fh / 2;
  const pulse = 0.5 + 0.5 * Math.sin((frame / Math.max(1, frames)) * Math.PI * 2);

  // Weapons are drawn larger than their platforms read, because a barrel that
  // occupies the true fraction of a cell looks like a toy on a big bunker. The
  // scale is applied once here rather than baked into every literal below, so
  // the whole set stays proportionate if it is tuned again.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(TURRET_SCALE, TURRET_SCALE);
  ctx.translate(-cx, -cy);

  const steel = `hsl(${h} 30% 56%)`;
  const steelDark = `hsl(${h} 26% 34%)`;
  const steelLight = `hsl(${h} 40% 72%)`;
  const deep = `hsl(${h} 30% 20%)`;
  const glow = `hsl(${h} 90% ${60 + pulse * 18}%)`;

  /** A barrel: a rounded rect running forward from the hub. */
  const barrel = (length, width, from = 0.02, color = steel) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(cx + fw * from, cy - width / 2, fw * length, width, width * 0.35);
    ctx.fill();
  };

  /** The pivot the weapon sits on. */
  const hub = (radius = 0.16) => {
    ctx.beginPath();
    ctx.arc(cx, cy, fw * radius, 0, Math.PI * 2);
    ctx.fillStyle = steelDark;
    ctx.fill();
    ctx.strokeStyle = deep;
    ctx.lineWidth = fw * 0.022;
    ctx.stroke();
  };

  switch (key) {
    case 'basic': {
      // A slim auto-rifle barrel with a box magazine and a front sight.
      barrel(0.34, fh * 0.09);
      // Muzzle tip.
      ctx.fillStyle = steelLight;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.32, cy - fh * 0.055, fw * 0.05, fh * 0.11, fh * 0.02);
      ctx.fill();
      // Box magazine under the breech.
      ctx.fillStyle = steelDark;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.04, cy + fh * 0.02, fw * 0.07, fh * 0.13, fh * 0.02);
      ctx.fill();
      // Front sight post.
      ctx.fillStyle = deep;
      ctx.fillRect(cx + fw * 0.26, cy - fh * 0.13, fw * 0.018, fh * 0.05);
      hub(0.11);
      break;
    }

    case 'cannon': {
      barrel(0.3, fh * 0.22);
      // Recoil sleeve over the breech end.
      ctx.fillStyle = steelDark;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.02, cy - fh * 0.15, fw * 0.16, fh * 0.3, fh * 0.05);
      ctx.fill();
      // Muzzle brake: two vent slots cut across the barrel tip.
      ctx.fillStyle = deep;
      for (let i = 0; i < 2; i += 1) {
        ctx.fillRect(cx + fw * (0.42 + i * 0.06), cy - fh * 0.12, fw * 0.035, fh * 0.24);
      }
      hub(0.17);
      break;
    }

    case 'frost': {
      // No barrel: a cluster of shards around a bright emitter.
      for (let i = 0; i < 3; i += 1) {
        const a = (i - 1) * 0.5;
        ctx.save();
        ctx.translate(cx + fw * 0.04, cy);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, -fh * 0.075);
        ctx.lineTo(fw * 0.34, 0);
        ctx.lineTo(0, fh * 0.075);
        ctx.closePath();
        ctx.fillStyle = `hsl(${h} 62% 68%)`;
        ctx.fill();
        ctx.strokeStyle = `hsl(${h} 50% 40%)`;
        ctx.lineWidth = fw * 0.018;
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.13, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      break;
    }

    case 'tesla': {
      // A coil stack seen from above: concentric rings and a floating orb.
      for (let i = 3; i >= 1; i -= 1) {
        ctx.beginPath();
        ctx.arc(cx, cy, fw * 0.09 * i, 0, Math.PI * 2);
        ctx.strokeStyle = i === 3 ? steelDark : steel;
        ctx.lineWidth = fw * 0.035;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.09 + pulse * fw * 0.015, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      // Arcing terminals, which light up in sequence.
      for (let i = 0; i < 3; i += 1) {
        const a = (i / 3) * Math.PI * 2 + pulse * 0.8;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * fw * 0.28, cy + Math.sin(a) * fw * 0.28, fw * 0.035, 0, Math.PI * 2);
        ctx.fillStyle = steelLight;
        ctx.fill();
      }
      break;
    }

    case 'venom': {
      // A sac with two tubes and a drooping nozzle.
      ctx.beginPath();
      ctx.ellipse(cx + fw * 0.04, cy, fw * 0.19, fh * 0.16, 0, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 34% 44%)`;
      ctx.fill();
      ctx.strokeStyle = `hsl(${h} 40% 26%)`;
      ctx.lineWidth = fw * 0.022;
      ctx.stroke();
      ctx.strokeStyle = `hsl(${h} 30% 38%)`;
      ctx.lineWidth = fw * 0.045;
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + fw * 0.14, cy + sy * fh * 0.07);
        ctx.quadraticCurveTo(cx + fw * 0.28, cy + sy * fh * 0.1, cx + fw * 0.34, cy + sy * fh * 0.04);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx + fw * 0.35, cy, fw * 0.03, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${h} 70% ${46 + pulse * 16}%)`;
      ctx.fill();
      break;
    }

    case 'sniper': {
      barrel(0.46, fh * 0.085);
      // Scope block offset to one side, so the silhouette is asymmetric.
      ctx.fillStyle = steelDark;
      ctx.beginPath();
      ctx.roundRect(cx - fw * 0.02, cy - fh * 0.17, fw * 0.16, fh * 0.09, fh * 0.03);
      ctx.fill();
      ctx.fillStyle = steelLight;
      ctx.beginPath();
      ctx.arc(cx + fw * 0.29, cy - fh * 0.15, fh * 0.032, 0, Math.PI * 2);
      ctx.fill();
      // Muzzle brake, then a thin tip.
      ctx.fillStyle = deep;
      ctx.fillRect(cx + fw * 0.4, cy - fh * 0.075, fw * 0.03, fh * 0.15);
      barrel(0.06, fh * 0.05, 0.46);
      hub(0.13);
      break;
    }

    case 'gatling': {
      // Six barrels in a cluster, rotating with the sheet's frames.
      const spin = (frame / Math.max(1, frames)) * Math.PI * 2;
      for (let i = 0; i < 6; i += 1) {
        const a = spin + (i / 6) * Math.PI * 2;
        const bx = cx + fw * 0.24 + Math.cos(a) * fw * 0.075;
        const by = cy + Math.sin(a) * fh * 0.075;
        ctx.beginPath();
        ctx.arc(bx, by, fw * 0.032, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 === 0 ? steel : steelDark;
        ctx.fill();
      }
      // Housing over the breech half of the cluster.
      ctx.fillStyle = steelDark;
      ctx.beginPath();
      ctx.roundRect(cx - fw * 0.04, cy - fh * 0.115, fw * 0.2, fh * 0.23, fh * 0.05);
      ctx.fill();
      hub(0.145);
      break;
    }

    case 'flamethrower': {
      // Twin short nozzles with a pilot light flickering between them.
      for (const sy of [-1, 1]) {
        ctx.fillStyle = steel;
        ctx.beginPath();
        ctx.roundRect(cx + fw * 0.1, cy + sy * fh * 0.09 - fh * 0.05, fw * 0.24, fh * 0.1, fh * 0.035);
        ctx.fill();
        ctx.fillStyle = `hsl(18 40% 24%)`;
        ctx.beginPath();
        ctx.ellipse(cx + fw * 0.345, cy + sy * fh * 0.09, fw * 0.022, fh * 0.045, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(cx + fw * 0.06, cy, fw * (0.035 + pulse * 0.012), 0, Math.PI * 2);
      ctx.fillStyle = `hsl(36 98% ${66 + pulse * 20}%)`;
      ctx.fill();
      hub(0.15);
      break;
    }

    case 'missile': {
      // Box launcher: four tubes in a 2x2, facing forward.
      ctx.fillStyle = steelDark;
      ctx.beginPath();
      ctx.roundRect(cx - fw * 0.06, cy - fh * 0.2, fw * 0.36, fh * 0.4, fh * 0.05);
      ctx.fill();
      ctx.strokeStyle = deep;
      ctx.lineWidth = fw * 0.022;
      ctx.stroke();
      for (let ix = 0; ix < 2; ix += 1) {
        for (let iy = 0; iy < 2; iy += 1) {
          const px = cx + fw * (0.13 + ix * 0.15);
          const py = cy + (iy === 0 ? -fh * 0.1 : fh * 0.1);
          ctx.beginPath();
          ctx.arc(px, py, fw * 0.052, 0, Math.PI * 2);
          ctx.fillStyle = `hsl(${h} 18% 22%)`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(px, py, fw * 0.032, 0, Math.PI * 2);
          ctx.fillStyle = `hsl(0 0% ${34 + pulse * 10}%)`;
          ctx.fill();
        }
      }
      hub(0.13);
      break;
    }

    case 'mortar': {
      // A single very wide, very short tube with a reinforcing collar.
      barrel(0.26, fh * 0.34, -0.04, steelDark);
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.04, cy - fh * 0.215, fw * 0.09, fh * 0.43, fh * 0.06);
      ctx.fill();
      ctx.fillStyle = deep;
      ctx.beginPath();
      ctx.ellipse(cx + fw * 0.23, cy, fw * 0.035, fh * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      hub(0.19);
      break;
    }

    case 'laser': {
      // A slim emitter barrel flanked by two swept cooling vanes, ending in a
      // bright aperture. The beam itself is a stretched quad drawn by the
      // renderer, so the turret only needs to read as "a lens on a mount".
      barrel(0.36, fh * 0.08);
      ctx.fillStyle = steelLight;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.33, cy - fh * 0.07, fw * 0.05, fh * 0.14, fh * 0.02);
      ctx.fill();
      // Swept cooling vanes.
      for (const sy of [-1, 1]) {
        ctx.fillStyle = steelDark;
        ctx.beginPath();
        ctx.moveTo(cx + fw * 0.03, cy + sy * fh * 0.04);
        ctx.lineTo(cx - fw * 0.1, cy + sy * fh * 0.2);
        ctx.lineTo(cx + fw * 0.06, cy + sy * fh * 0.16);
        ctx.closePath();
        ctx.fill();
      }
      // Bright aperture at the muzzle.
      ctx.beginPath();
      ctx.arc(cx + fw * 0.39, cy, fw * (0.03 + pulse * 0.018), 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      hub(0.1);
      break;
    }

    case 'sixshooter': {
      // A long single revolver barrel with a cylinder at the breech.
      barrel(0.4, fh * 0.1);
      ctx.fillStyle = steelDark;
      ctx.beginPath();
      ctx.roundRect(cx - fw * 0.04, cy - fh * 0.13, fw * 0.12, fh * 0.26, fh * 0.05);
      ctx.fill();
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.arc(cx + fw * 0.02, cy - fh * 0.08 + i * fh * 0.08, fh * 0.022, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${h} 30% 52%)`;
        ctx.fill();
      }
      hub(0.13);
      break;
    }

    case 'dynamite': {
      // A single fat stick tipped with a sparking fuse.
      barrel(0.34, fh * 0.18, 0.0, steelDark);
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.3, cy - fh * 0.11, fw * 0.06, fh * 0.22, fh * 0.03);
      ctx.fill();
      const spark = 0.5 + 0.5 * Math.sin(pulse * Math.PI * 2);
      ctx.fillStyle = `hsl(42 98% ${66 + spark * 22}%)`;
      ctx.beginPath();
      ctx.arc(cx + fw * 0.37, cy, fw * (0.03 + spark * 0.014), 0, Math.PI * 2);
      ctx.fill();
      hub(0.14);
      break;
    }

    case 'grapeshot': {
      // A wide, short cannon mouth.
      barrel(0.26, fh * 0.3, -0.02, steelDark);
      ctx.fillStyle = deep;
      ctx.beginPath();
      ctx.ellipse(cx + fw * 0.25, cy, fw * 0.05, fh * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      hub(0.16);
      break;
    }

    case 'harpoon': {
      // A thin harpoon with a barbed tip.
      barrel(0.46, fh * 0.06);
      ctx.fillStyle = steelLight;
      ctx.beginPath();
      ctx.moveTo(cx + fw * 0.46, cy);
      ctx.lineTo(cx + fw * 0.56, cy - fh * 0.08);
      ctx.lineTo(cx + fw * 0.52, cy);
      ctx.lineTo(cx + fw * 0.56, cy + fh * 0.08);
      ctx.closePath();
      ctx.fill();
      hub(0.13);
      break;
    }

    case 'raygun': {
      // A stubby emitter with a flared muzzle and a glowing ring.
      barrel(0.24, fh * 0.14, 0.0, steelDark);
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.roundRect(cx + fw * 0.22, cy - fh * 0.19, fw * 0.1, fh * 0.38, fh * 0.05);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + fw * 0.33, cy, fw * (0.03 + pulse * 0.012), 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      hub(0.14);
      break;
    }

    case 'ioncannon': {
      // A fat projector barrel with cooling rings.
      barrel(0.4, fh * 0.26, -0.02, steelDark);
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.ellipse(cx + fw * (0.08 + i * 0.1), cy, fw * 0.02, fh * 0.14, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `hsl(${h} 40% ${40 + pulse * 16}%)`;
        ctx.lineWidth = fw * 0.016;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(cx + fw * 0.38, cy, fw * 0.035, fh * 0.13, 0, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      hub(0.17);
      break;
    }

    default: {
      barrel(0.34, fh * 0.14);
      hub(0.15);
    }
  }

  ctx.restore();
}

function drawProjectile(ctx, x, y, fw, fh, key, frame, frames) {
  const cx = x + fw / 2;
  const cy = y + fh / 2;
  const pulse = 0.85 + 0.15 * Math.sin((frame / frames) * Math.PI * 2);

  const style = {
    bullet: ['hsl(48 92% 68%)', fw * 0.17],
    shell: ['hsl(28 70% 58%)', fw * 0.24],
    shard: ['hsl(190 80% 70%)', fw * 0.20],
    glob: ['hsl(288 62% 60%)', fw * 0.22],
    slug: ['hsl(210 45% 78%)', fw * 0.18],
    flame: ['hsl(22 95% 62%)', fw * 0.21],
    rocket: ['hsl(0 0% 86%)', fw * 0.19],
  }[key] ?? ['hsl(0 0% 80%)', fw * 0.18];

  ctx.fillStyle = style[0];
  ctx.beginPath();
  ctx.arc(cx, cy, style[1] * pulse, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.arc(cx - style[1] * 0.25, cy - style[1] * 0.25, style[1] * 0.35, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Per-effect look: hue, saturation, lightness and which shape to draw.
 *
 * The death effects are deliberately muted compared with the originals. During
 * a big wave dozens can overlap, so they have to stay readable *through* --
 * bright white flashes would make the board unreadable.
 */
const FX_STYLES = {
  impact: { hue: 48, sat: 92, light: 66, shape: 'burst' },
  splash: { hue: 20, sat: 88, light: 58, shape: 'burst' },
  spawn: { hue: 200, sat: 85, light: 66, shape: 'ring' },
  leak: { hue: 356, sat: 82, light: 62, shape: 'ring' },

  pop: { hue: 190, sat: 68, light: 72, shape: 'puff' },
  boom: { hue: 26, sat: 76, light: 60, shape: 'spokes' },
  goo: { hue: 96, sat: 44, light: 46, shape: 'blobs' },
  burn: { hue: 18, sat: 84, light: 58, shape: 'flame' },
  zap: { hue: 55, sat: 86, light: 72, shape: 'sparks' },
  shatter: { hue: 195, sat: 60, light: 72, shape: 'shards' },
  coins: { hue: 44, sat: 78, light: 64, shape: 'blobs' },

  // Not a flourish -- this is the pool of shade under a flying enemy, which is
  // what tells the player a unit is airborne now that flyers walk the road.
  shadow: { hue: 220, sat: 25, light: 5, shape: 'shadow' },

  // Ambient art. Lower saturation and mid lightness than the effects above, so
  // a plume of smoke never reads as a hit and never competes with the board.
  muzzle: { hue: 34, sat: 96, light: 74, shape: 'muzzle' },
  smoke: { hue: 215, sat: 9, light: 44, shape: 'smoke' },
  dust: { hue: 32, sat: 22, light: 62, shape: 'dust' },
  spark: { hue: 42, sat: 92, light: 78, shape: 'spark' },

  // The barrier under a shielded enemy. Cyan, to read as "force field" rather
  // than as any of the damage types, whose effects are orange and green.
  shield: { hue: 190, sat: 92, light: 68, shape: 'shield' },

  // White on purpose: a beam is feathered in the sprite and coloured by the
  // effect's own tint, so one sprite serves the sniper's tracer and every arc
  // of a tesla chain.
  beam: { hue: 0, sat: 0, light: 100, shape: 'beam' },

  // Weather. Pale and nearly white, so the per-particle tint sets the colour
  // and the wash does the mood.
  rain: { hue: 213, sat: 30, light: 88, shape: 'rain' },
  flake: { hue: 205, sat: 18, light: 96, shape: 'flake' },
  mote: { hue: 45, sat: 30, light: 88, shape: 'mote' },
};

/** Fixed directions so a generated sheet is byte-identical every run. */
const SPOKE_ANGLES = [0.4, 1.3, 2.2, 3.1, 4.0, 4.9, 5.6];

function drawFx(ctx, x, y, fw, fh, key, frame, frames) {
  const cx = x + fw / 2;
  const cy = y + fh / 2;
  const t = frame / Math.max(1, frames - 1);
  const alpha = 1 - t;

  const style = FX_STYLES[key] ?? { hue: 0, sat: 0, light: 80, shape: 'ring' };
  const ink = `hsl(${style.hue} ${style.sat}% ${style.light}%)`;

  ctx.globalAlpha = alpha;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineCap = 'round';

  switch (style.shape) {
    case 'shadow': {
      // Constant opacity, deliberately *not* faded by `t`. This sprite is not
      // an effect with a lifetime -- it is the ground marker under an airborne
      // enemy, and a pulsing shadow reads as a bug.
      ctx.globalAlpha = 0.38;
      ctx.beginPath();
      ctx.ellipse(cx, cy, fw * 0.33, fh * 0.21, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      break;
    }

    case 'beam': {
      // A feathered bar filling the whole frame. The renderer stretches this to
      // (length x thickness), so the vertical falloff becomes the soft edge of
      // the beam and the middle stays solid.
      const grad = ctx.createLinearGradient(0, y, 0, y + fh);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,1)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, fw, fh);
      break;
    }

    case 'rain': {
      // A thin vertical streak inside a full square frame. Deliberately narrow:
      // the renderer scales the *frame*, so the streak's width is what keeps a
      // raindrop reading as a line rather than as a grain of rice.
      const grad = ctx.createLinearGradient(0, y, 0, y + fh);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.85)');
      grad.addColorStop(1, 'rgba(255,255,255,0.15)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(cx - fw * 0.035, y, fw * 0.07, fh);
      break;
    }

    case 'flake': {
      // Six arms with a stub on each. At a few pixels on screen the arms blur
      // together into a flake, which is the whole job.
      ctx.globalAlpha = 1;
      ctx.lineCap = 'round';
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(2, fw * 0.055);
      const r = fw * 0.34;
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        ctx.stroke();
        // A short cross-stroke on each arm, which is what makes it read as ice.
        const bx = cx + Math.cos(a) * r * 0.62;
        const by = cy + Math.sin(a) * r * 0.62;
        ctx.beginPath();
        ctx.moveTo(bx + Math.cos(a + 1.1) * r * 0.26, by + Math.sin(a + 1.1) * r * 0.26);
        ctx.lineTo(bx + Math.cos(a - 1.1) * r * 0.26, by + Math.sin(a - 1.1) * r * 0.26);
        ctx.stroke();
      }
      break;
    }

    case 'mote': {
      // A soft round blob: dust in the sun, and the base of a fog bank.
      ctx.globalAlpha = 1;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, fw * 0.46);
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.46, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'shield': {
      // A hexagonal barrier. Hard-edged rather than a soft glow, because at
      // gameplay zoom the whole enemy is about twenty pixels across and a blur
      // at that size reads as nothing at all.
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = Math.max(2, fw * 0.055);
      ctx.beginPath();
      for (let i = 0; i <= 6; i += 1) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const px = cx + Math.cos(a) * fw * 0.4;
        const py = cy + Math.sin(a) * fh * 0.4;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = alpha;
      break;
    }

    case 'muzzle': {
      // A forward-pointing star, brightest at frame 0. Drawn facing +x so it
      // can be laid along a turret's barrel with the same angle as the turret.
      // It collapses fast -- a muzzle flash that lingers reads as a fire.
      const sharp = alpha ** 2;
      ctx.globalAlpha = sharp;
      const reach = fw * (0.30 + t * 0.10);
      ctx.lineWidth = Math.max(1.5, fw * 0.055 * sharp);
      for (let i = 0; i < 5; i += 1) {
        // Splayed forward, so the shape has an obvious direction to it.
        const a = (i - 2) * 0.36;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(cx, cy, fw * 0.13 * sharp, fh * 0.085 * sharp, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = alpha;
      break;
    }

    case 'smoke': {
      // Fire-and-forget smoke. Compared with `puff` it is bigger, lumpier and
      // slower, and it drifts up-screen as it ages so a plume reads as rising.
      // Three lobes on offset orbits, so no two frames look stamped.
      ctx.globalAlpha = alpha * 0.7;
      const rise = fh * 0.12 * t;
      for (let i = 0; i < 3; i += 1) {
        const a = SPOKE_ANGLES[i * 2] + t * 0.6;
        const orbit = fw * (0.04 + t * 0.16);
        ctx.beginPath();
        ctx.ellipse(
          cx + Math.cos(a) * orbit,
          cy + Math.sin(a) * orbit * 0.6 - rise,
          Math.max(1, fw * (0.10 + t * 0.13)),
          Math.max(1, fh * (0.08 + t * 0.11)),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
      break;
    }

    case 'dust': {
      // A low, wide scuff of dust: flatter than smoke and barely rising, which
      // is what separates a boot hitting gravel from a barrel smoking.
      ctx.globalAlpha = alpha * 0.5;
      for (let i = 0; i < 4; i += 1) {
        const dir = i % 2 === 0 ? -1 : 1;
        ctx.beginPath();
        ctx.ellipse(
          cx + dir * fw * (0.05 + t * 0.22) * (0.5 + i * 0.2),
          cy + fh * 0.06 * t,
          Math.max(1, fw * (0.07 + t * 0.1)),
          Math.max(1, fh * (0.04 + t * 0.05)),
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
      break;
    }

    case 'spark': {
      // Short bright streaks flying outward, tapering as they cool.
      ctx.lineWidth = Math.max(1, fw * 0.035 * alpha);
      const inner = fw * (0.06 + t * 0.16);
      const outer = fw * (0.11 + t * 0.34);
      for (let i = 0; i < 4; i += 1) {
        const a = SPOKE_ANGLES[i * 2 + 1];
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        ctx.stroke();
      }
      break;
    }

    case 'ring':
      ctx.lineWidth = Math.max(2, fw * 0.09 * alpha);
      ctx.beginPath();
      ctx.arc(cx, cy, fw * (0.12 + t * 0.34), 0, Math.PI * 2);
      ctx.stroke();
      break;

    case 'burst':
      ctx.lineWidth = Math.max(2, fw * 0.09 * alpha);
      ctx.beginPath();
      ctx.arc(cx, cy, fw * (0.12 + t * 0.34), 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.14 * alpha, 0, Math.PI * 2);
      ctx.fill();
      break;

    case 'puff': {
      // Four round puffs drifting outward: a small thing going *poof*.
      for (let i = 0; i < 4; i += 1) {
        const a = SPOKE_ANGLES[i * 2] + i * 0.5;
        const d = fw * (0.06 + t * 0.3);
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(a) * d,
          cy + Math.sin(a) * d,
          Math.max(1, fw * (0.06 + t * 0.1) * alpha),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      break;
    }

    case 'spokes': {
      // A short fat starburst -- a bang without a screen-filling flash.
      ctx.lineWidth = Math.max(2, fw * 0.1 * alpha);
      const inner = fw * (0.05 + t * 0.06);
      const outer = fw * (0.14 + t * 0.28);
      for (let i = 0; i < 5; i += 1) {
        const a = SPOKE_ANGLES[i] + 0.3;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(cx, cy, fw * 0.13 * alpha, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'blobs': {
      // Goo and coin specks: a little downward drift so they read as falling.
      for (let i = 0; i < 5; i += 1) {
        const a = SPOKE_ANGLES[i] + i;
        const d = fw * (0.05 + t * 0.3);
        ctx.beginPath();
        ctx.arc(
          cx + Math.cos(a) * d,
          cy + Math.sin(a) * d + fw * 0.18 * t * t,
          Math.max(1, fw * 0.055 * alpha),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      break;
    }

    case 'flame': {
      // Three tapered tongues: wide at the base, pinched at the tip, so they
      // read as fire rather than as three fat bars.
      for (let i = 0; i < 3; i += 1) {
        const bx = cx + (i - 1) * fw * 0.14;
        const rise = fw * (0.06 + t * 0.34);
        const w = Math.max(1, fw * 0.1 * alpha);
        const base = Math.max(1, fw * 0.12 * alpha);
        ctx.beginPath();
        ctx.moveTo(bx, cy + base);
        ctx.quadraticCurveTo(bx - w, cy - rise * 0.4, bx, cy - rise - base);
        ctx.quadraticCurveTo(bx + w, cy - rise * 0.4, bx, cy + base);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }

    case 'sparks': {
      ctx.lineWidth = Math.max(1, fw * 0.05 * alpha);
      const inner = fw * (0.05 + t * 0.1);
      const outer = fw * (0.1 + t * 0.26);
      for (let i = 0; i < 6; i += 1) {
        const a = SPOKE_ANGLES[i];
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
        ctx.stroke();
      }
      break;
    }

    case 'shards': {
      // Little triangles tumbling outward.
      for (let i = 0; i < 5; i += 1) {
        const a = SPOKE_ANGLES[i];
        const d = fw * (0.05 + t * 0.28);
        const px = cx + Math.cos(a) * d;
        const py = cy + Math.sin(a) * d;
        const sz = Math.max(1, fw * 0.06 * alpha);
        ctx.beginPath();
        ctx.moveTo(px, py - sz);
        ctx.lineTo(px + sz, py + sz);
        ctx.lineTo(px - sz, py + sz);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }

    default:
      break;
  }

  ctx.globalAlpha = 1;
}

function drawTile(ctx, x, y, fw, fh, key) {
  const inset = 1;
  const draw = (fill, stroke) => {
    ctx.fillStyle = fill;
    ctx.fillRect(x + inset, y + inset, fw - inset * 2, fh - inset * 2);
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + inset, y + inset, fw - inset * 2, fh - inset * 2);
    }
  };

  if (key === 'buildable') {
    draw('#171c24', '#222a36');
    ctx.fillStyle = '#2b3444';
    ctx.fillRect(x + fw / 2 - 3, y + fh / 2 - 3, 6, 6);
  } else if (key === 'road') {
    draw('#2a3140', '#343d4f');
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 4;
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.moveTo(x, y + fh / 2);
    ctx.lineTo(x + fw, y + fh / 2);
    ctx.moveTo(x + fw / 2, y);
    ctx.lineTo(x + fw / 2, y + fh);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (key === 'blocked') {
    draw('#0f1319', '#191f28');
    ctx.fillStyle = '#232c39';
    ctx.beginPath();
    ctx.arc(x + fw / 2, y + fh / 2, fw * 0.22, 0, Math.PI * 2);
    ctx.fill();
  } else if (key === 'spawn') {
    draw('#3a1d22', '#7d3140');
    ctx.fillStyle = 'rgba(255,110,120,0.55)';
    ctx.beginPath();
    ctx.arc(x + fw / 2, y + fh / 2, fw * 0.20, 0, Math.PI * 2);
    ctx.fill();
  } else if (key === 'base') {
    // The home base: an armoured hexagon around a reactor, sharing the
    // barracks' green-core motif so "base" reads as one family on the board.
    const cx = x + fw / 2;
    const cy = y + fh / 2;
    draw('#16261d', '#2f6a4a');
    ngon(ctx, cx, cy, fw * 0.32, 6, Math.PI / 6);
    ctx.fillStyle = '#1c3426';
    ctx.fill();
    ctx.strokeStyle = '#3f8f63';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Inner ring, echoing the landing-pad seam on the barracks.
    ngon(ctx, cx, cy, fw * 0.22, 6, Math.PI / 6);
    ctx.strokeStyle = 'rgba(110, 231, 168, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Corner bolts, so it reads as bolted to the ground rather than painted on.
    bolts(ctx, cx, cy, fw * 0.32, 6, fw * 0.026, '#2f6a4a', Math.PI / 6);
    // Reactor core.
    ctx.fillStyle = 'rgba(110, 255, 170, 0.9)';
    ctx.beginPath();
    ctx.arc(cx, cy, fw * 0.1, 0, Math.PI * 2);
    ctx.fill();
  } else if (key === 'bonus') {
    draw('#2c2716', '#736030');
    ctx.fillStyle = 'rgba(255,214,102,0.85)';
    ctx.beginPath();
    ctx.arc(x + fw / 2, y + fh / 2, fw * 0.15, 0, Math.PI * 2);
    ctx.fill();
  } else {
    draw('#101318', '#1a1f27');
  }
}

/**
 * Ink for the board's landscape linework.
 *
 * Two tones so a motif can have a main line and a fainter companion, both held
 * in a very dark luminance band -- dimmer than the road tiles -- so the board
 * still reads as one surface and never competes with the play layer above it.
 */
const DECOR_PLATE = '#151a22';
const DECOR_PLATE_WARM = '#1a1720';
const DECOR_PLATE_COOL = '#141b24';
const DECOR_EDGE = '#1e252f';
const DECOR_INK = '#242e3c';
const DECOR_INK_DIM = '#1b232d';

function decorLabel(ctx, cx, y, text, color, size) {
  ctx.fillStyle = color;
  ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, cx, y);
}

function drawDecorLegacy(ctx, x, y, fw, fh, key) {
  const cx = x + fw / 2;
  const cy = y + fh / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, fw, fh);
  ctx.clip();

  const plate = (fill = DECOR_PLATE) => {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, fw, fh);
    ctx.strokeStyle = DECOR_EDGE;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, fw - 2, fh - 2);
  };

  const ring = (px, py, r, color = DECOR_INK, w = 3) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
  };

  const dot = (px, py, r, color = DECOR_INK) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  };

  switch (key) {
    case 'bloop':
      plate();
      ring(cx, cy - 8, 15);
      dot(cx - 5, cy - 11, 5);
      dot(cx + 6, cy - 3, 3);
      decorLabel(ctx, cx, cy + 24, 'BLOOP', DECOR_INK_DIM, 11);
      break;

    case 'megacorp':
      plate(DECOR_PLATE_COOL);
      ctx.strokeStyle = DECOR_INK_DIM;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 9, y + 11, fw - 18, fh - 22);
      decorLabel(ctx, cx, cy + 1, 'MEGA', DECOR_INK, 13);
      decorLabel(ctx, cx, cy + 15, 'CORP', DECOR_INK_DIM, 12);
      break;

    case 'zorp': {
      plate(DECOR_PLATE_WARM);
      ctx.fillStyle = DECOR_INK_DIM;
      ctx.beginPath();
      const spikes = 12;
      for (let i = 0; i < spikes * 2; i += 1) {
        const r = i % 2 === 0 ? 21 : 12;
        const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
        const px = cx + Math.cos(a) * r;
        const py = cy - 6 + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      decorLabel(ctx, cx, cy + 26, 'ZORP!', DECOR_INK, 11);
      break;
    }

    case 'krunch':
      plate();
      ctx.fillStyle = DECOR_INK_DIM;
      ctx.beginPath();
      ctx.moveTo(x + 10, y + 13);
      ctx.lineTo(x + 54, y + 13);
      ctx.lineTo(x + 44, y + 39);
      ctx.lineTo(x + 20, y + 39);
      ctx.closePath();
      ctx.fill();
      decorLabel(ctx, cx, cy + 24, 'KRUNCH', DECOR_INK, 10);
      break;

    case 'ooze':
      plate(DECOR_PLATE_COOL);
      ctx.fillStyle = DECOR_INK_DIM;
      ctx.beginPath();
      ctx.moveTo(cx - 20, cy + 5);
      ctx.bezierCurveTo(cx - 24, cy - 14, cx - 4, cy - 20, cx + 2, cy - 6);
      ctx.bezierCurveTo(cx + 10, cy - 22, cx + 26, cy - 8, cx + 20, cy + 8);
      ctx.bezierCurveTo(cx + 14, cy + 20, cx - 14, cy + 20, cx - 20, cy + 5);
      ctx.closePath();
      ctx.fill();
      dot(cx - 8, cy + 2, 3, DECOR_PLATE_COOL);
      dot(cx + 7, cy + 2, 3, DECOR_PLATE_COOL);
      break;

    case 'fizz':
      plate();
      ring(cx, cy - 4, 14);
      dot(cx - 16, cy - 20, 3);
      dot(cx + 15, cy - 22, 2);
      dot(cx + 20, cy - 8, 3);
      decorLabel(ctx, cx, cy + 26, 'FIZZ', DECOR_INK_DIM, 11);
      break;

    case 'plonk':
      plate(DECOR_PLATE_WARM);
      ctx.fillStyle = DECOR_INK_DIM;
      ctx.fillRect(x + 12, y + 12, fw - 24, fh - 24);
      dot(cx + 6, cy + 5, 7, DECOR_INK);
      break;

    case 'twirl':
      plate(DECOR_PLATE_COOL);
      ctx.strokeStyle = DECOR_INK;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let t = 0; t < Math.PI * 5.5; t += 0.2) {
        const r = 2 + t * 2.1;
        const px = cx + Math.cos(t) * r;
        const py = cy + Math.sin(t) * r;
        if (t === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      break;

    case 'snax':
      plate();
      ctx.fillStyle = DECOR_INK_DIM;
      ctx.beginPath();
      ctx.moveTo(cx, y + 10);
      ctx.lineTo(x + 50, y + 18);
      ctx.lineTo(x + 46, y + 44);
      ctx.lineTo(cx, y + 54);
      ctx.lineTo(x + 18, y + 44);
      ctx.lineTo(x + 14, y + 18);
      ctx.closePath();
      ctx.fill();
      decorLabel(ctx, cx, cy + 5, 'SNAX', DECOR_PLATE, 13);
      break;

    case 'glorb': {
      plate(DECOR_PLATE_COOL);
      ctx.strokeStyle = DECOR_INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const px = cx + Math.cos(a) * 20;
        const py = cy + Math.sin(a) * 20;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      dot(cx, cy, 5);
      break;
    }

    case 'droplet':
      plate();
      ctx.fillStyle = DECOR_INK_DIM;
      ctx.beginPath();
      ctx.moveTo(cx, y + 10);
      ctx.bezierCurveTo(x + 48, cy, x + 46, y + 44, cx, y + 46);
      ctx.bezierCurveTo(x + 18, y + 44, x + 16, cy, cx, y + 10);
      ctx.closePath();
      ctx.fill();
      dot(cx - 6, cy + 10, 4, DECOR_PLATE);
      decorLabel(ctx, cx, y + 57, 'OIL', DECOR_INK, 10);
      break;

    case 'trademark':
      plate();
      ctx.strokeStyle = DECOR_INK_DIM;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 14, cy + 4);
      ctx.lineTo(x + 50, cy + 4);
      ctx.stroke();
      decorLabel(ctx, cx, cy - 4, '\u2122', DECOR_INK, 18);
      break;

    case 'honk':
      plate(DECOR_PLATE_WARM);
      ctx.fillStyle = DECOR_INK_DIM;
      ctx.beginPath();
      ctx.moveTo(cx, y + 12);
      ctx.lineTo(x + 52, y + 48);
      ctx.lineTo(x + 12, y + 48);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = DECOR_PLATE_WARM;
      ctx.fillRect(cx - 2, y + 24, 4, 12);
      ctx.fillRect(cx - 2, y + 40, 4, 4);
      break;

    case 'moo':
      plate();
      ring(cx, cy - 4, 15);
      dot(cx - 7, cy - 6, 4);
      dot(cx + 7, cy - 6, 4);
      decorLabel(ctx, cx, cy + 26, 'MOO', DECOR_INK_DIM, 12);
      break;

    case 'bzzz':
      plate(DECOR_PLATE_COOL);
      ctx.fillStyle = DECOR_INK;
      ctx.beginPath();
      ctx.moveTo(cx + 8, y + 8);
      ctx.lineTo(x + 16, cy + 4);
      ctx.lineTo(cx - 2, cy + 4);
      ctx.lineTo(cx + 10, y + 56);
      ctx.lineTo(x + 48, cy - 6);
      ctx.lineTo(cx + 2, cy - 6);
      ctx.closePath();
      ctx.fill();
      break;

    case 'rings':
      plate();
      ring(cx, cy, 20, DECOR_INK_DIM, 3);
      ring(cx, cy, 13, DECOR_INK, 3);
      ring(cx, cy, 6, DECOR_INK_DIM, 3);
      break;

    default:
      plate();
      break;
  }

  ctx.restore();
}

/**
 * Background markings: landscape linework on the buildable tiles.
 *
 * The board tile is one flat colour, so the land would read as a single
 * featureless slab without these. The marks are contours and directional
 * strokes -- waves, diagonals, ridges -- drawn edge to edge where they can
 * chain, so adjacent tiles of the same kind join into one landscape instead of
 * reading as a stack of framed squares. Deliberately coarse: a few lines, not a
 * texture.
 *
 * They stay in a very dark luminance band, dimmer than the road tiles, because
 * they sit behind enemies, towers, range rings and the placement ghost.
 */

/** Stroke a polyline of `steps` segments built from t in [0,1]. */
function decorStroke(ctx, steps, at) {
  ctx.beginPath();
  for (let i = 0; i <= steps; i += 1) {
    const [px, py] = at(i / steps);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawDecor(ctx, x, y, fw, fh, key) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, fw, fh);
  ctx.clip();
  ctx.lineCap = 'round';

  /**
   * A horizontal contour. `cycles` is a whole number so the sine returns to its
   * start phase at the tile edge and the line can continue into the next tile.
   */
  const wave = (yAt, amp, cycles, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    decorStroke(ctx, 14, (t) => [
      x + t * fw,
      y + yAt + Math.sin(t * Math.PI * 2 * cycles) * amp,
    ]);
  };

  /** Parallel 45-degree strokes, evenly spaced so the motif chains across tiles. */
  const diagonals = (slope, spacing, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (let c = -fh; c <= fh; c += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, y + c);
      ctx.lineTo(x + fw, y + c + slope * fw);
      ctx.stroke();
    }
  };

  switch (key) {
    case 'wave':
      wave(28, 5, 1, DECOR_INK, 3);
      wave(48, 5, 1, DECOR_INK_DIM, 3);
      wave(68, 5, 1, DECOR_INK, 3);
      break;

    case 'wave_two':
      wave(32, 4, 2, DECOR_INK, 3);
      wave(64, 4, 2, DECOR_INK_DIM, 3);
      break;

    case 'diag_up':
      diagonals(-1, 26, DECOR_INK, 2.5);
      break;

    case 'diag_down':
      diagonals(1, 26, DECOR_INK, 2.5);
      break;

    case 'cross':
      diagonals(1, 42, DECOR_INK_DIM, 2);
      diagonals(-1, 42, DECOR_INK_DIM, 2);
      break;

    case 'stream': {
      // One meandering vertical line with a short companion, so it reads as a
      // watercourse rather than just another contour.
      ctx.strokeStyle = DECOR_INK;
      ctx.lineWidth = 3;
      decorStroke(ctx, 14, (t) => [
        x + fw * 0.62 + Math.sin(t * Math.PI * 2) * fw * 0.16,
        y + t * fh,
      ]);
      ctx.strokeStyle = DECOR_INK_DIM;
      ctx.lineWidth = 2;
      decorStroke(ctx, 14, (t) => [
        x + fw * 0.36 + Math.sin(t * Math.PI * 2 + 0.8) * fw * 0.1,
        y + t * fh,
      ]);
      break;
    }

    case 'contours': {
      // A knoll: nested rounded arcs sharing one corner.
      ctx.strokeStyle = DECOR_INK;
      ctx.lineWidth = 3;
      for (const r of [14, 26, 38]) {
        ctx.beginPath();
        ctx.arc(x + 8, y + fh - 8, r, -Math.PI * 0.9, 0.35);
        ctx.stroke();
      }
      break;
    }

    case 'stipple': {
      // Sparse ground stipple. Positions look random but are fixed per motif.
      ctx.fillStyle = DECOR_INK_DIM;
      for (let i = 0; i < 10; i += 1) {
        const px = x + 10 + ((i * 29) % (fw - 20));
        const py = y + 12 + ((i * 37) % (fh - 24));
        ctx.beginPath();
        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    default:
      break;
  }

  ctx.restore();
}

/**
 * Enemy health bar parts.
 *
 * Both are flat full-frame rects because the renderer stretches them
 * non-uniformly -- 0.5 world units wide by 0.07 tall -- so any detail drawn
 * here would shear badly. The fill is pure white so the batch can tint it.
 */
/**
 * Aircraft. Nose points +x, like every other moving sprite.
 *
 * A fighter has to read as fast and a bomber as heavy from the silhouette alone,
 * because at gameplay zoom that is all there is: a swept delta with a bright
 * exhaust against a straight-winged slab with two engines and a blinking light.
 */
function drawAircraft(ctx, x, y, fw, fh, key, frame = 0, frames = 4) {
  const cx = x + fw / 2;
  const cy = y + fh / 2;
  const phase = (frame / Math.max(1, frames)) * Math.PI * 2;

  if (key === 'shadow') {
    // Constant opacity: this is a ground marker, not an effect with a lifetime.
    // A pulsing shadow on an aircraft reads as a bug.
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(cx, cy, fw * 0.26, fh * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }

  if (key === 'tank') {
    // A tracked vehicle seen from above. It is drawn smaller than the frame on
    // purpose: the renderer scales this whole frame down further, so a tank that
    // filled the sheet would land as a full-tile slab and read as terrain. Tread
    // ticks slide with the walk phase, which is the only animation a top-down
    // vehicle can honestly have.
    const body = fw * 0.34;
    const track = body * 0.42;
    ctx.fillStyle = 'hsl(96 14% 27%)';
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(cx - body * 1.05, cy + sy * (body * 0.62) - track * 0.5, body * 2.1, track, track * 0.35);
      ctx.fill();
    }

    // Tread ticks. Offset by the phase so the tracks look like they are moving
    // rather than glued on; denser and slower now, for a crawl rather than a
    // sprint.
    const slide = (phase / (Math.PI * 2)) * track * 0.8;
    ctx.fillStyle = 'hsl(96 12% 17%)';
    for (let i = -3; i <= 3; i += 1) {
      const tx = cx + i * track * 0.8 + slide;
      if (tx < cx - body * 1.05 || tx > cx + body * 1.05 - track * 0.22) continue;
      for (const sy of [-1, 1]) {
        ctx.fillRect(tx, cy + sy * (body * 0.62) - track * 0.35, track * 0.22, track * 0.7);
      }
    }

    // Hull, chamfered at the front so the facing direction is readable even
    // when the turret is turned away.
    ctx.beginPath();
    ctx.moveTo(cx + body * 0.95, cy - body * 0.5);
    ctx.lineTo(cx + body * 0.72, cy - body * 0.72);
    ctx.lineTo(cx - body * 0.92, cy - body * 0.72);
    ctx.lineTo(cx - body * 0.92, cy + body * 0.72);
    ctx.lineTo(cx + body * 0.72, cy + body * 0.72);
    ctx.lineTo(cx + body * 0.95, cy + body * 0.5);
    ctx.closePath();
    ctx.fillStyle = 'hsl(96 18% 40%)';
    ctx.fill();
    ctx.strokeStyle = 'hsl(96 20% 24%)';
    ctx.lineWidth = Math.max(2, body * 0.06);
    ctx.stroke();

    // Turret and barrel.
    ctx.beginPath();
    ctx.roundRect(cx - body * 0.1, cy - body * 0.1, body * 1.1, body * 0.2, body * 0.06);
    ctx.fillStyle = 'hsl(96 16% 32%)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx - body * 0.05, cy, body * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = 'hsl(96 20% 48%)';
    ctx.fill();
    ctx.strokeStyle = 'hsl(96 22% 26%)';
    ctx.lineWidth = Math.max(2, body * 0.05);
    ctx.stroke();

    // Cupola highlight, off-centre so the turret is not a flat disc.
    ctx.beginPath();
    ctx.arc(cx - body * 0.14, cy - body * 0.08, body * 0.11, 0, Math.PI * 2);
    ctx.fillStyle = 'hsl(96 30% 66%)';
    ctx.fill();

    // Dust drifting off the rear: a slow crawl reads as a crawl when there is
    // something kicked up behind the tracks.
    const dust = phase / (Math.PI * 2);
    ctx.fillStyle = 'hsla(96 10% 62% / 0.16)';
    for (let i = 0; i < 3; i += 1) {
      const px = cx - body * (1.3 + i * 0.5) + dust * body * 0.4;
      const py = cy + Math.sin(phase + i * 1.7) * body * 0.16;
      ctx.beginPath();
      ctx.ellipse(px, py, body * (0.34 - i * 0.07), body * (0.16 - i * 0.03), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  const fighter = key === 'fighter';
  const h = fighter ? 198 : 12;
  const hull = `hsl(${h} 22% ${fighter ? 62 : 48}%)`;
  const hullDark = `hsl(${h} 26% ${fighter ? 34 : 26}%)`;
  const trim = `hsl(${h} 40% ${fighter ? 78 : 64}%)`;
  const r = fw * (fighter ? 0.3 : 0.36);

  // Wings first, so the fuselage covers where they meet the body.
  ctx.fillStyle = hullDark;
  if (fighter) {
    // Swept delta, angled back hard.
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.5, cy);
      ctx.lineTo(cx - r * 0.85, cy + sy * r * 1.25);
      ctx.lineTo(cx - r * 1.05, cy + sy * r * 0.95);
      ctx.lineTo(cx - r * 0.5, cy);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    // Straight, broad wings with a squared tip: a bomb truck, not a dogfighter.
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(cx - r * 0.95, cy + sy * r * 1.3 - r * 0.19, r * 1.5, r * 0.38, r * 0.08);
      ctx.fill();
    }
  }

  // Fuselage.
  ctx.beginPath();
  if (fighter) {
    ctx.moveTo(cx + r * 1.35, cy);
    ctx.lineTo(cx - r * 0.9, cy - r * 0.34);
    ctx.lineTo(cx - r * 1.05, cy);
    ctx.lineTo(cx - r * 0.9, cy + r * 0.34);
    ctx.closePath();
  } else {
    ctx.roundRect(cx - r * 1.1, cy - r * 0.32, r * 2.5, r * 0.64, r * 0.16);
  }
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = hullDark;
  ctx.lineWidth = Math.max(2, r * 0.09);
  ctx.stroke();

  // Canopy.
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.34, cy, r * 0.3, r * 0.18, 0, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${h} 55% 84%)`;
  ctx.fill();

  if (fighter) {
    // Engine bloom, pulsing on the walk cycle so a wing is never static.
    const burn = 0.55 + 0.45 * Math.abs(Math.sin(phase));
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.95, cy - r * 0.17);
    ctx.lineTo(cx - r * (1.5 + burn * 0.5), cy);
    ctx.lineTo(cx - r * 0.95, cy + r * 0.17);
    ctx.closePath();
    ctx.fillStyle = `hsl(${28 + burn * 14} 96% ${58 + burn * 22}%)`;
    ctx.fill();
  } else {
    // Two nacelles and a bomb bay.
    ctx.fillStyle = hullDark;
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(cx - r * 0.6, cy + sy * r * 0.85 - r * 0.13, r * 0.8, r * 0.26, r * 0.1);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.roundRect(cx - r * 0.35, cy - r * 0.13, r * 0.9, r * 0.26, r * 0.07);
    ctx.fillStyle = trim;
    ctx.fill();

    // A beacon that blinks: the tell that says "this one is slow and loaded".
    const blink = phase > Math.PI ? 1 : 0.25;
    ctx.beginPath();
    ctx.arc(cx - r * 0.85, cy, r * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(0 85% ${38 + blink * 44}%)`;
    ctx.fill();
  }
}

function drawBar(ctx, x, y, fw, fh, key) {
  if (key === 'bg') {
    ctx.fillStyle = 'rgba(6,8,11,0.92)';
    ctx.fillRect(x, y, fw, fh);
    return;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, fw, fh);
}

const DRAWERS = {
  enemies: drawEnemy,
  towers_base: drawTowerBase,
  towers_turret: drawTowerTurret,
  projectiles: drawProjectile,
  fx: drawFx,
  tiles: drawTile,
  decor: drawDecor,
  bars: drawBar,
  aircraft: drawAircraft,
};

/**
 * Generate every sheet described by the atlas definition.
 * @returns {Record<string, {texture: THREE.Texture, width:number, height:number}>}
 */
export function buildPlaceholderSheets(atlasDef) {
  const out = {};
  for (const [name, sheet] of Object.entries(atlasDef.sheets)) {
    // Authoring notes live alongside real sheets as `_`-prefixed keys.
    if (name.startsWith('_')) continue;

    const layout = sheetLayout(sheet);
    const drawer = DRAWERS[name];
    if (!drawer) continue;
    const keys = Object.keys(sheet.sprites);
    out[name] = makeSheet(name, sheet, layout, drawer, keys);
  }
  return out;
}
