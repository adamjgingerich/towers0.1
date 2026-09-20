/**
 * Tile grid and ASCII map loading.
 *
 * Glyphs are deliberately the same as the map files in data/maps/, so a level
 * can be edited in a text editor and diffed like source.
 */

export const ROAD = '#';
export const BUILDABLE = '.';
export const BLOCKED = 'X';
export const SPAWN = 'S';
export const BASE = 'E';
export const BONUS = '*';

/** Tiles an enemy is allowed to walk on. */
export const WALKABLE = new Set([ROAD, SPAWN, BASE]);

export const KNOWN_GLYPHS = new Set([ROAD, BUILDABLE, BLOCKED, SPAWN, BASE, BONUS]);

export class MapError extends Error {}

export class Grid {
  constructor({ width, height, rows, spawns, base, bonus, buildable }) {
    this.width = width;
    this.height = height;
    this.rows = rows;
    this.spawns = spawns;
    this.base = base;
    this.bonus = bonus;
    this.buildable = buildable;
  }

  static fromText(text) {
    const rows = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (rows.length === 0) throw new MapError('map is empty');

    const width = rows[0].length;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].length !== width) {
        throw new MapError(`row ${i} is ${rows[i].length} tiles wide, expected ${width}`);
      }
    }

    const spawns = [];
    let base = null;
    const bonus = new Set();
    const buildable = new Set();
    const key = (x, y) => `${x},${y}`;

    for (let y = 0; y < rows.length; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const glyph = rows[y][x];
        if (!KNOWN_GLYPHS.has(glyph)) {
          throw new MapError(`unknown glyph ${JSON.stringify(glyph)} at row ${y}, col ${x}`);
        }
        if (glyph === SPAWN) {
          spawns.push([x, y]);
          buildable.delete(key(x, y));
        } else if (glyph === BASE) {
          base = [x, y];
        } else if (glyph === BONUS) {
          bonus.add(key(x, y));
          buildable.add(key(x, y));
        } else if (glyph === BUILDABLE) {
          buildable.add(key(x, y));
        }
      }
    }

    if (spawns.length === 0) throw new MapError("map has no spawn tile ('S')");
    if (base === null) throw new MapError("map has no base tile ('E')");

    return new Grid({
      width,
      height: rows.length,
      rows,
      spawns,
      base,
      bonus,
      buildable,
    });
  }

  /** Glyph at tile coordinates, or BLOCKED when out of bounds. */
  at(x, y) {
    if (x >= 0 && x < this.width && y >= 0 && y < this.height) return this.rows[y][x];
    return BLOCKED;
  }

  inBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  isBuildable(x, y) {
    return this.buildable.has(`${x},${y}`);
  }

  isBonus(x, y) {
    return this.bonus.has(`${x},${y}`);
  }

  isWalkable(x, y) {
    return WALKABLE.has(this.at(x, y));
  }

  /** Centre of a tile in tile units. */
  static tileCenter(x, y) {
    return [x + 0.5, y + 0.5];
  }

  /** Tile containing a point in tile units. */
  static centerTile(px, py) {
    return [Math.floor(px), Math.floor(py)];
  }
}
