/**
 * Renderer, camera and coordinate conversion.
 *
 * Top-down board game, so this is an **orthographic** camera: perspective would
 * warp the board and make range circles and tower placement read wrong.
 *
 * Two coordinate systems are in play and it is worth being precise about them:
 *
 *   tile space  - y-down, origin top-left. What the simulation speaks.
 *   world space - y-up, origin bottom-left. What three.js speaks.
 *
 * The flip happens in exactly one place, `worldFromTile` / `tileFromWorld`. The
 * simulation never learns about it, and sprite angles are negated to match.
 *
 * Colour note: no colour-space conversion is applied anywhere. Textures are
 * marked NoColorSpace and the renderer outputs linear-sRGB, so canvas colours
 * pass through untouched. That is predictable for flat placeholder art; when
 * real sRGB PNGs land, set texture.colorSpace = SRGBColorSpace here and let
 * three.js encode on output.
 */

import * as THREE from 'three';

export class Stage {
  constructor(canvas, board, area) {
    this.canvas = canvas;
    /** The element sized to the board's aspect ratio; overlays nest inside it. */
    this.board = board;
    /** The element whose available space the board is fitted into. */
    this.area = area ?? board.parentElement;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // On, now that the sheets are smooth-sampled. The sprites are drawn from
      // curves rather than pixel blocks, so their edges want antialiasing; the
      // old pixel-art look depended on nearest filtering to stay legible and
      // that is no longer what the art is.
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x0b0e13, 1);

    this.scene = new THREE.Scene();

    // Placeholder bounds; `fitToGrid` sets the real ones.
    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, -100, 100);
    this.camera.position.set(0, 0, 10);

    this.widthTiles = 1;
    this.heightTiles = 1;
    this.aspect = 1;
    this.viewportWidth = 1;
    this.viewportHeight = 1;

    // View transform. The camera always holds the *current* value, so pointer
    // picking and the DOM overlays stay exact even mid-animation; these are the
    // values it eases toward, which is what makes a pinch feel smooth.
    this.minZoom = 1;
    this.maxZoom = 8;
    /**
     * Zoom the level was framed for, and what Fit returns to.
     *
     * A level can be authored to be read up close -- a tight switchback with a
     * lot of scenery wants a nearer default than an open map. `minZoom` stays at
     * 1 so Fit always restores the whole board, and a level's own framing can
     * never permanently hide part of itself from the player.
     */
    this.defaultZoom = 1;
    this.targetZoom = 1;
    this.targetX = 0;
    this.targetY = 0;
    this._easeRate = 20;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    // The inspector panel opening changes the wrapper's size without a window
    // resize, so watch the element too.
    if (this.area && typeof ResizeObserver !== 'undefined') {
      this._observer = new ResizeObserver(() => this.resize());
      this._observer.observe(this.area);
    }
  }

  /**
   * Point the camera at the whole board, one world unit per tile.
   *
   * @param {{defaultZoom?: number, minZoom?: number, maxZoom?: number}} [framing]
   *   Per-level view preferences. A level drawn for close reading passes a
   *   `defaultZoom` above 1; everything else gets the whole board.
   */
  fitToGrid(grid, framing = {}) {
    this.grid = grid;
    this.widthTiles = grid.width;
    this.heightTiles = grid.height;
    this.aspect = grid.width / grid.height;

    // The camera sits at the board's centre in world space. The frustum bounds
    // are derived from the *view* aspect in `_applyFrustum`, so the board never
    // distorts however the window is shaped, and a widescreen window shows more
    // of the board side-to-side rather than letterboxing it away.
    this.camera.position.set(grid.width / 2, -grid.height / 2, 10);

    this.minZoom = 1;
    this.maxZoom = Math.max(8, framing.maxZoom ?? 8);
    this.defaultZoom = Math.max(1, Math.min(this.maxZoom, framing.defaultZoom ?? 1));

    this.resize();
    this.resetView();
  }

  // ----------------------------------------------------------- view transform

  /** World-space half-extents of what the camera can see, at a given zoom. */
  _halfExtents(zoom) {
    const cam = this.camera;
    return [(cam.right - cam.left) / 2 / zoom, (cam.top - cam.bottom) / 2 / zoom];
  }

  /**
   * What is on screen right now, in **tile space** (y-down).
   *
   * Weather is emitted across this rather than across the whole board, so a
   * zoomed-in view gets a dense spell instead of scattering most of its drops
   * off-screen. Tile space because that is what the particle pool speaks: the
   * camera works in world space, where y points the other way, so the y bounds
   * are negated and swapped here rather than at every emission site.
   *
   * @returns {{x0:number, y0:number, x1:number, y1:number}}
   */
  visibleTileRect() {
    const [halfW, halfH] = this._halfExtents(this.camera.zoom);
    const { x, y } = this.camera.position;
    return {
      x0: x - halfW,
      x1: x + halfW,
      y0: -(y + halfH),
      y1: -(y - halfH),
    };
  }

  /**
   * Pan limits at a given zoom, clamped to the board.
   *
   * At zoom 1 the half-extents equal half the board, so min equals max and the
   * view locks to dead centre -- which is exactly why panning does nothing
   * until you zoom in.
   */
  _limits(zoom) {
    const [halfW, halfH] = this._halfExtents(zoom);
    const W = this.widthTiles;
    const H = this.heightTiles;
    const tooWide = halfW >= W / 2;
    const tooTall = halfH >= H / 2;
    return {
      minX: tooWide ? W / 2 : halfW,
      maxX: tooWide ? W / 2 : W - halfW,
      minY: tooTall ? -H / 2 : -H + halfH,
      maxY: tooTall ? -H / 2 : -halfH,
    };
  }

  _clampTo(zoom, x, y) {
    const l = this._limits(zoom);
    return [Math.min(Math.max(x, l.minX), l.maxX), Math.min(Math.max(y, l.minY), l.maxY)];
  }

  /** Snap back to the level's framing, centred. */
  resetView() {
    this.targetZoom = this.defaultZoom;
    this.targetX = this.widthTiles / 2;
    this.targetY = -this.heightTiles / 2;
    this.applyView();
  }

  /** Write the targets straight onto the camera, without easing. */
  applyView() {
    const cam = this.camera;
    const [x, y] = this._clampTo(this.targetZoom, this.targetX, this.targetY);
    cam.zoom = this.targetZoom;
    cam.position.x = x;
    cam.position.y = y;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Ease toward the target view. Call once per rendered frame with real dt. */
  update(dt) {
    const cam = this.camera;
    const k = 1 - Math.exp(-this._easeRate * Math.min(dt, 0.1));

    const dz = this.targetZoom - cam.zoom;
    const dx = this.targetX - cam.position.x;
    const dy = this.targetY - cam.position.y;
    if (Math.abs(dz) < 1e-4 && Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return;

    cam.zoom += dz * k;
    cam.position.x += dx * k;
    cam.position.y += dy * k;

    const [cx, cy] = this._clampTo(cam.zoom, cam.position.x, cam.position.y);
    cam.position.x = cx;
    cam.position.y = cy;

    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  get zoom() {
    return this.camera.zoom;
  }

  get atMaxZoom() {
    return this.targetZoom >= this.maxZoom - 1e-6;
  }

  get atMinZoom() {
    return this.targetZoom <= this.minZoom + 1e-6;
  }

  /**
   * Zoom about a fixed screen point, so whatever is under the cursor stays put.
   *
   * @param {number} ndcX -1..1
   * @param {number} ndcY -1..1 (y up)
   * @param {number} factor greater than 1 zooms in
   */
  zoomAt(ndcX, ndcY, factor) {
    const cam = this.camera;
    const [halfW, halfH] = this._halfExtents(cam.zoom);

    // World point currently under the cursor.
    const anchorX = cam.position.x + ndcX * halfW;
    const anchorY = cam.position.y + ndcY * halfH;

    const next = Math.min(this.maxZoom, Math.max(this.minZoom, this.targetZoom * factor));
    this.targetZoom = next;

    const [nextHalfW, nextHalfH] = this._halfExtents(next);
    this.targetX = anchorX - ndcX * nextHalfW;
    this.targetY = anchorY - ndcY * nextHalfH;

    const [x, y] = this._clampTo(next, this.targetX, this.targetY);
    this.targetX = x;
    this.targetY = y;
  }

  /** Pan by a screen-pixel delta. Scroll deltas map straight onto this. */
  panByPixels(dxPx, dyPx) {
    const [halfW, halfH] = this._halfExtents(this.targetZoom);
    const ux = (2 * halfW) / Math.max(1, this.viewportWidth);
    const uy = (2 * halfH) / Math.max(1, this.viewportHeight);

    // Scrolling down reveals lower rows, and world y decreases downwards.
    this.targetX += dxPx * ux;
    this.targetY -= dyPx * uy;

    const [x, y] = this._clampTo(this.targetZoom, this.targetX, this.targetY);
    this.targetX = x;
    this.targetY = y;
  }

  /** World position at normalised device coordinates. */
  worldFromNdc(ndcX, ndcY) {
    const cam = this.camera;
    const [halfW, halfH] = this._halfExtents(cam.zoom);
    return [cam.position.x + ndcX * halfW, cam.position.y + ndcY * halfH];
  }

  // ------------------------------------------------------------------- sizing

  /**
   * Fit the camera frustum to the current view aspect, sized so the whole board
   * is visible at zoom 1. The shorter view dimension is exactly the board's; the
   * longer one shows extra board (a widescreen window sees more left-to-right)
   * instead of dead letterbox. The frustum is the only thing that changes on
   * resize -- the camera position is never moved here, so a resize cannot throw
   * away an active pan or zoom.
   */
  _applyFrustum() {
    const W = this.widthTiles;
    const H = this.heightTiles;
    if (W <= 0 || H <= 0) return;

    const viewAspect = this.viewportWidth / Math.max(1, this.viewportHeight);
    const boardAspect = W / H;

    let halfW;
    let halfH;
    if (viewAspect >= boardAspect) {
      halfH = H / 2;
      halfW = halfH * viewAspect;
    } else {
      halfW = W / 2;
      halfH = halfW / viewAspect;
    }

    const cam = this.camera;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.updateProjectionMatrix();
  }

  /**
   * Fill the wrapper with the canvas and re-fit the frustum.
   *
   * The canvas now spans the whole area rather than the board's aspect ratio:
   * the board is fitted by the frustum (`_applyFrustum`) instead of by CSS, so
   * there is no letterbox and no distortion.
   */
  resize() {
    if (!this.area) return;

    // Re-read the device pixel ratio every time: it changes when the window is
    // zoomed or moved between monitors, and a stale value leaves the drawing
    // buffer out of step with the CSS size.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const availW = Math.max(1, this.area.clientWidth);
    const availH = Math.max(1, this.area.clientHeight);

    const w = Math.max(1, Math.floor(availW));
    const h = Math.max(1, Math.floor(availH));

    this.board.style.width = `${w}px`;
    this.board.style.height = `${h}px`;
    this.renderer.setSize(w, h, false);

    this.viewportWidth = w;
    this.viewportHeight = h;

    this._applyFrustum();

    // Pan limits depend on the viewport, so re-clamp after a resize.
    const [x, y] = this._clampTo(this.camera.zoom, this.camera.position.x, this.camera.position.y);
    this.camera.position.x = x;
    this.camera.position.y = y;
    this.camera.updateMatrixWorld();
  }

  // -------------------------------------------------------------- coordinates

  /** Tile-space (y-down) to world-space (y-up). */
  static worldFromTile(x, y) {
    return [x, -y];
  }

  /** World-space back to tile indices, matching Grid.centerTile. */
  static tileFromWorld(wx, wy) {
    return [Math.floor(wx), Math.floor(-wy)];
  }

  /**
   * Pointer event to tile indices, or null when the pointer is not over a tile.
   *
   * Null means "the black" -- off the canvas, or over the canvas but outside
   * the board itself once the view is zoomed out. Returning a tile for that area
   * would make a click on empty space look like a click on whatever tile the
   * arithmetic happened to land on, which is how clicking beside the map used to
   * fire a placement attempt at the map's corner instead of dismissing anything.
   */
  tileFromPointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;

    // Go through the camera rather than assuming the board fills the canvas:
    // once the view is zoomed or panned those are no longer the same thing.
    const [wx, wy] = this.worldFromNdc(nx * 2 - 1, 1 - ny * 2);
    const tx = Math.floor(wx);
    const ty = Math.floor(-wy);

    const grid = this.grid;
    if (grid && (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height)) return null;
    return [tx, ty];
  }

  /** World-space to CSS pixel offsets within the canvas, for DOM overlays. */
  screenFromWorld(wx, wy) {
    const cam = this.camera;
    const [halfW, halfH] = this._halfExtents(cam.zoom);
    const ndcX = (wx - cam.position.x) / halfW;
    const ndcY = (wy - cam.position.y) / halfH;
    return [((ndcX + 1) / 2) * this.viewportWidth, ((1 - ndcY) / 2) * this.viewportHeight];
  }

  // ------------------------------------------------------------------- output

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this._observer) this._observer.disconnect();
    this.renderer.dispose();
  }
}
