/**
 * Zoom buttons and the zoom readout, overlaid on the board.
 *
 * Wheel and pinching cover the common case, but an on-screen affordance makes
 * the feature discoverable and gives one-click access to the fitted view -- the
 * only reliable way back if you have zoomed in and lost your bearings.
 */

const STEPS = 1.35;

export class ViewControls {
  constructor(stage) {
    this.stage = stage;
    this.el = {
      out: document.getElementById('btn-zoom-out'),
      fit: document.getElementById('btn-zoom-fit'),
      in: document.getElementById('btn-zoom-in'),
    };

    if (this.el.out) {
      this.el.out.addEventListener('click', () => this.stage.zoomAt(0, 0, 1 / STEPS));
    }
    if (this.el.in) {
      this.el.in.addEventListener('click', () => this.stage.zoomAt(0, 0, STEPS));
    }
    if (this.el.fit) {
      this.el.fit.addEventListener('click', () => this.stage.resetView());
    }

    this._lastLabel = '';
    this.update();
  }

  /** Cheap: write text only when it actually changes. */
  update() {
    const stage = this.stage;

    const label = stage.zoom < 1.005 ? 'Fit' : `${Math.round(stage.zoom * 100)}%`;
    if (this.el.fit && label !== this._lastLabel) {
      this.el.fit.textContent = label;
      this._lastLabel = label;
    }

    if (this.el.out) this.el.out.disabled = stage.atMinZoom;
    if (this.el.in) this.el.in.disabled = stage.atMaxZoom;
  }
}
