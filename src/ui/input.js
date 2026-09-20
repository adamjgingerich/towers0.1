/**
 * Pointer and keyboard input.
 *
 * Deliberately thin: it turns events into intent (hover, select, place, cancel)
 * and hands that to the game. It never mutates the world directly except
 * through the callbacks it is given, which keeps the "what should happen"
 * decisions in one place in main.js.
 */

export class Input {
  /**
   * @param {import('../render/stage.js').Stage} stage
   * @param {object} handlers
   *  onHover(tile) onPrimary(tile) onCancel() onHotkey(key)
  *  onUpgrade() onSell() onCycleTargeting() onTogglePause() onSpeed(delta) onRestart()
  *  onCallEarly()
   */
  constructor(stage, handlers) {
    this.stage = stage;
    this.handlers = handlers;
    this.hover = null;
    /** Last pointer position, so hover can be recomputed after the view moves. */
    this._lastPointer = null;

    this._bindPointer();
    this._bindKeys();
  }

  _bindPointer() {
    const canvas = this.stage.canvas;

    canvas.addEventListener('pointermove', (event) => {
      this._lastPointer = { clientX: event.clientX, clientY: event.clientY };
      this._refreshHover();
    });

    canvas.addEventListener('pointerleave', () => {
      this._lastPointer = null;
      this.hover = null;
      this.handlers.onHover(null);
    });

    canvas.addEventListener('pointerdown', (event) => {
      this._lastPointer = { clientX: event.clientX, clientY: event.clientY };
      const tile = this.stage.tileFromPointer(event);
      if (tile === null) {
        this.handlers.onCancel();
        return;
      }
      if (event.button === 2) {
        this.handlers.onCancel();
        return;
      }
      this.handlers.onPrimary(tile, event);
    });

    // Without this the browser context menu fires on every right-click cancel.
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    this._bindWheel();
  }

  _setHover(tile) {
    const changed =
      (tile === null) !== (this.hover === null) ||
      (tile !== null &&
        this.hover !== null &&
        (tile[0] !== this.hover[0] || tile[1] !== this.hover[1]));
    this.hover = tile;
    if (changed) this.handlers.onHover(tile);
  }

  /** Recompute the hovered tile -- the view may have moved under the cursor. */
  _refreshHover() {
    if (!this._lastPointer) return;
    this._setHover(this.stage.tileFromPointer(this._lastPointer));
  }

  _bindWheel() {
    const canvas = this.stage.canvas;

    // Deliberately not passive: preventing the default is the whole point, since
    // otherwise the browser zooms the page on a pinch and rubber-bands on a
    // two-finger swipe.
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();

        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        if (event.ctrlKey) {
          // Trackpad pinch and Ctrl+wheel both arrive here as a ctrlKey wheel.
          const nx = (event.clientX - rect.left) / rect.width;
          const ny = (event.clientY - rect.top) / rect.height;
          this.stage.zoomAt(nx * 2 - 1, 1 - ny * 2, Math.exp(-event.deltaY * 0.0022));
        } else {
          // Two-finger scroll pans; Shift+wheel pans horizontally.
          let dx = event.deltaX;
          let dy = event.deltaY;
          if (event.shiftKey && dx === 0) {
            dx = dy;
            dy = 0;
          }
          this.stage.panByPixels(dx, dy);
        }

        this._lastPointer = { clientX: event.clientX, clientY: event.clientY };
        this._refreshHover();
        if (this.handlers.onViewChanged) this.handlers.onViewChanged();
      },
      { passive: false },
    );
  }

  _bindKeys() {
    window.addEventListener('keydown', (event) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLElement && event.target.isContentEditable
      ) return;

      const key = event.key;

      if (key === ' ') {
        event.preventDefault();
        this.handlers.onTogglePause();
        return;
      }
      // P as well as Space: Space also scrolls the page and is swallowed by any
      // focused control, so the letter is the shortcut that always works.
      if (key === 'p' || key === 'P') {
        event.preventDefault();
        this.handlers.onTogglePause();
        return;
      }
      if (key === 'n' || key === 'N') {
        event.preventDefault();
        this.handlers.onCallEarly();
        return;
      }
      if (key === 'Escape') {
        this.handlers.onCancel();
        return;
      }
      if (key === 'u' || key === 'U') {
        this.handlers.onUpgrade();
        return;
      }
      if (key === 'x' || key === 'X') {
        this.handlers.onSell();
        return;
      }
      if (key === 't' || key === 'T') {
        this.handlers.onCycleTargeting();
        return;
      }
      if (key === 'r' || key === 'R') {
        this.handlers.onRestart();
        return;
      }
      if (key === '=' || key === '+') {
        this.handlers.onSpeedDelta(1);
        return;
      }
      if (key === '-' || key === '_') {
        this.handlers.onSpeedDelta(-1);
        return;
      }

      this.handlers.onHotkey(key);
    });
  }
}
