export class Board {
  #canvas;
  #context;
  #isDrawing = false;
  #currentPoints = [];
  #onStroke;

  constructor({ canvas, onStroke }) {
    this.#canvas = canvas;
    this.#context = canvas.getContext("2d", { willReadFrequently: true });
    this.#onStroke = onStroke;
    this.#resize();
    this.#registerEvents();
  }

  drawSnapshot(strokes) {
    strokes.forEach((stroke) => this.#drawStroke(stroke));
  }

  drawRemoteStroke(stroke) {
    this.#drawStroke(stroke);
  }

  clear() {
    this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
  }

  #registerEvents() {
    window.addEventListener("resize", () => this.#resize());
    this.#canvas.addEventListener("pointerdown", (event) => this.#startStroke(event));
    this.#canvas.addEventListener("pointermove", (event) => this.#continueStroke(event));
    this.#canvas.addEventListener("pointerup", () => this.#finishStroke());
    this.#canvas.addEventListener("pointercancel", () => this.#finishStroke());
  }

  #startStroke(event) {
    this.#canvas.setPointerCapture(event.pointerId);
    this.#isDrawing = true;
    this.#currentPoints = [this.#getPoint(event)];
    this.#drawPoint(this.#currentPoints[0]);
  }

  #continueStroke(event) {
    if (!this.#isDrawing) {
      return;
    }

    const point = this.#getPoint(event);
    this.#currentPoints.push(point);
    this.#drawSegment(this.#currentPoints.at(-2), point);
  }

  #finishStroke() {
    if (!this.#isDrawing) {
      return;
    }

    this.#isDrawing = false;
    this.#onStroke({
      type: "stroke",
      strokeId: crypto.randomUUID(),
      points: this.#currentPoints,
      style: { color: "#172033", width: 3 },
    });
    this.#currentPoints = [];
  }

  #drawStroke({ points, style = {} }) {
    if (!points?.length) {
      return;
    }

    this.#context.strokeStyle = style.color ?? "#172033";
    this.#context.lineWidth = style.width ?? 3;
    this.#context.lineCap = "round";
    this.#context.lineJoin = "round";

    points.length === 1
      ? this.#drawPoint(points[0])
      : points.slice(1).forEach((point, index) => {
          this.#drawSegment(points[index], point);
        });
  }

  #drawSegment(from, to) {
    this.#context.beginPath();
    this.#context.moveTo(from.x * this.#canvas.width, from.y * this.#canvas.height);
    this.#context.lineTo(to.x * this.#canvas.width, to.y * this.#canvas.height);
    this.#context.stroke();
  }

  #drawPoint(point) {
    const x = point.x * this.#canvas.width;
    const y = point.y * this.#canvas.height;
    this.#context.beginPath();
    this.#context.arc(x, y, 1.5, 0, Math.PI * 2);
    this.#context.fill();
  }

  #getPoint(event) {
    const bounds = this.#canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    };
  }

  #resize() {
    const bounds = this.#canvas.getBoundingClientRect();
    const image = this.#canvas.width > 0
      ? this.#context.getImageData(0, 0, this.#canvas.width, this.#canvas.height)
      : null;

    this.#canvas.width = Math.max(1, Math.floor(bounds.width));
    this.#canvas.height = Math.max(1, Math.floor(bounds.height));
    this.#context.fillStyle = "#ffffff";
    this.#context.fillRect(0, 0, this.#canvas.width, this.#canvas.height);

    if (image) {
      this.#context.putImageData(image, 0, 0);
    }
  }
}
