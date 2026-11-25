export class Board {
  #base;
  #overlay;

  constructor({ base, overlay }) {
    this.#base = base;
    this.#overlay = overlay;
  }

  get baseContext() {
    return this.#base.getContext("2d", { willReadFrequently: true });
  }

  get overlayContext() {
    return this.#overlay.getContext("2d");
  }

  resize(width, height, dpr) {
    if (this.#base.width !== width || this.#base.height !== height) {
      this.#base.width = width;
      this.#base.height = height;
      this.#overlay.width = width;
      this.#overlay.height = height;
    }

    for (const canvas of [this.#base, this.#overlay]) {
      const context = canvas.getContext("2d");
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.imageSmoothingEnabled = true;
    }
  }
}
