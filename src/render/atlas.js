/**
 * Sprite atlas geometry.
 *
 * data/atlas.json describes every sheet as a grid of fixed-size frames with a
 * row per sprite and `frames` columns, which is exactly what a UV atlas needs.
 * Nothing here knows whether the pixels came from a generated placeholder
 * canvas or a real PNG -- swapping the art is a change of texture, not of code.
 */

export const WHITE = [1, 1, 1];

/** Frame grid dimensions implied by a sheet definition. */
export function sheetLayout(sheet) {
  let maxRow = 0;
  let maxExtent = 1;

  for (const [key, sprite] of Object.entries(sheet.sprites)) {
    // `_`-prefixed entries are authoring notes. They have no row or frame
    // count, but a note that happened to carry a `row` would silently inflate
    // the canvas and shift every sprite's UVs.
    if (key.startsWith('_')) continue;

    const row = sprite.row ?? 0;
    const col = sprite.col ?? 0;
    const frames = sprite.frames ?? 1;
    if (row > maxRow) maxRow = row;
    if (col + frames > maxExtent) maxExtent = col + frames;
  }

  const cols = maxExtent;
  const rows = maxRow + 1;
  return {
    cols,
    rows,
    width: cols * sheet.fw,
    height: rows * sheet.fh,
  };
}

export class Atlas {
  /**
   * @param {object} def parsed data/atlas.json
   * @param {Record<string, {width:number, height:number}>} sizes actual texture sizes
   */
  constructor(def, sizes) {
    this.def = def;
    this.sizes = sizes;
  }

  get pixelArt() {
    return Boolean(this.def.pixel_art);
  }

  spriteDef(sheetName, key) {
    const sheet = this.def.sheets[sheetName];
    if (!sheet) return null;
    return sheet.sprites[key] ?? null;
  }

  /**
   * UV rect for one frame, or null when the key is missing.
   *
   * three.js UVs put (0,0) at the bottom-left and CanvasTexture is flipped on
   * upload, so a canvas row counted from the top maps to descending v.
   */
  frame(sheetName, key, frameIndex = 0) {
    const sheet = this.def.sheets[sheetName];
    if (!sheet) return null;
    const sprite = sheet.sprites[key];
    if (!sprite) return null;

    const size = this.sizes[sheetName];
    if (!size) return null;

    const frames = sprite.frames ?? 1;
    const index = frames > 0 ? ((frameIndex % frames) + frames) % frames : 0;
    const col = (sprite.col ?? 0) + index;
    const row = sprite.row ?? 0;

    const du = sheet.fw / size.width;
    const dv = sheet.fh / size.height;

    return {
      u: col * du,
      v: 1 - (row + 1) * dv,
      du,
      dv,
    };
  }

  /** Animated frame index from elapsed seconds, clamped when the sheet is static. */
  animFrame(sheetName, key, elapsed) {
    const sprite = this.spriteDef(sheetName, key);
    if (!sprite) return 0;
    const frames = sprite.frames ?? 1;
    if (frames <= 1) return 0;
    const fps = sprite.fps ?? 8;
    return Math.floor(elapsed * fps) % frames;
  }

  /** A visible fallback so a bad key never crashes a run. */
  static missingFrame() {
    return { u: 0, v: 0, du: 1, dv: 1 };
  }
}

/** Deterministic pseudo-random hue offset so placeholder art is stable. */
export function hashHue(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 360);
}
