/**
 * Path construction for the level.
 *
 * Every enemy follows the road network, resolved once at level load with a BFS
 * over walkable tiles. Flyers are *not* a separate route -- they float along
 * the same road. What makes them different is that only some towers can shoot
 * at them, so a lane packed with cannons and mortars is a lane they cross for
 * free. See `ground_only` in data/towers.json.
 */

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Shortest walkable tile path from start to goal (BFS, 4-connected). */
export function findTilePath(grid, start, goal) {
  const same = start[0] === goal[0] && start[1] === goal[1];
  if (same) return [start];

  const key = (x, y) => `${x},${y}`;
  const previous = new Map();
  const seen = new Set([key(start[0], start[1])]);
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;

    if (current[0] === goal[0] && current[1] === goal[1]) {
      const path = [current];
      while (!(path[path.length - 1][0] === start[0] && path[path.length - 1][1] === start[1])) {
        const last = path[path.length - 1];
        path.push(previous.get(key(last[0], last[1])));
      }
      path.reverse();
      return path;
    }

    for (const [dx, dy] of NEIGHBOURS) {
      const nx = current[0] + dx;
      const ny = current[1] + dy;
      const nk = key(nx, ny);
      if (seen.has(nk) || !grid.isWalkable(nx, ny)) continue;
      seen.add(nk);
      previous.set(nk, current);
      queue.push([nx, ny]);
    }
  }

  throw new Error(`no walkable path from ${start} to ${goal}`);
}

function isCollinear(a, b, c) {
  return (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
}

/** Drop interior points of straight runs. */
export function simplify(tiles) {
  if (tiles.length < 3) return tiles.slice();
  const out = [tiles[0]];
  for (let i = 1; i < tiles.length - 1; i += 1) {
    if (!isCollinear(tiles[i - 1], tiles[i], tiles[i + 1])) out.push(tiles[i]);
  }
  out.push(tiles[tiles.length - 1]);
  return out;
}

/** A polyline parameterised by distance travelled, in tile units. */
export class Path {
  constructor(points) {
    if (points.length < 2) throw new Error('a path needs at least two points');
    this.points = points;

    const cumulative = [0];
    let total = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      total += Math.hypot(
        points[i + 1][0] - points[i][0],
        points[i + 1][1] - points[i][1],
      );
      cumulative.push(total);
    }
    this.cumulative = cumulative;
    this.length = total;
  }

  static fromTiles(tiles) {
    return new Path(tiles.map(([x, y]) => [x + 0.5, y + 0.5]));
  }

  /** Returns [x, y, heading_radians] at a distance along the path. */
  posAt(distance) {
    const points = this.points;

    if (distance <= 0) {
      const [ax, ay] = points[0];
      const [bx, by] = points[1];
      return [ax, ay, Math.atan2(by - ay, bx - ax)];
    }
    if (distance >= this.length) {
      const [ax, ay] = points[points.length - 2];
      const [bx, by] = points[points.length - 1];
      return [bx, by, Math.atan2(by - ay, bx - ax)];
    }

    // Linear scan is fine: paths have fewer than ~40 segments and this runs
    // once per enemy per frame.
    const cumulative = this.cumulative;
    for (let i = 0; i < cumulative.length - 1; i += 1) {
      if (cumulative[i] <= distance && distance <= cumulative[i + 1]) {
        const span = cumulative[i + 1] - cumulative[i];
        const t = span <= 0 ? 0 : (distance - cumulative[i]) / span;
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        return [
          ax + (bx - ax) * t,
          ay + (by - ay) * t,
          Math.atan2(by - ay, bx - ax),
        ];
      }
    }

    const [ax, ay] = points[points.length - 2];
    const [bx, by] = points[points.length - 1];
    return [bx, by, Math.atan2(by - ay, bx - ax)];
  }
}

/**
 * Returns { ground, flying } for the level.
 *
 * Both keys point at the *same* Path object. That is deliberate, not an
 * oversight: flyers travel the road. The two names are kept because the
 * renderer, the save format and the spawner all speak in terms of "the path
 * this enemy walks", and collapsing them would only move the branch around.
 */
export function buildPaths(grid) {
  const spawn = grid.spawns[0];
  const ground = Path.fromTiles(simplify(findTilePath(grid, spawn, grid.base)));
  return { ground, flying: ground };
}
