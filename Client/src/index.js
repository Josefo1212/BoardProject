import { Board } from "./Board.js";
import { Communication } from "./Communication.js";

class ClientApp {
  #board;
  #communication;
  #serverInput = document.querySelector("#server-url");
  #connectButton = document.querySelector("#connect-button");
  #clearButton = document.querySelector("#clear-button");
  #status = document.querySelector("#status");

  constructor() {
    this.#serverInput.value = `ws://${window.location.hostname}:3005`;
    this.#board = new Board({
      canvas: document.querySelector("#board"),
      onStroke: (stroke) => this.#communication.send(stroke),
    });
    this.#communication = new Communication({
      onMessage: (message) => this.#handleMessage(message),
      onStatusChange: (status) => this.#updateStatus(status),
    });

    this.#connectButton.addEventListener("click", () => this.#connect());
    this.#clearButton.addEventListener("click", () => this.#clear());
  }

  #connect() {
    this.#communication.connect(this.#serverInput.value.trim());
  }

  #clear() {
    this.#board.clear();
    this.#communication.send({ type: "clear" });
  }

  #handleMessage(message) {
    if (message.type === "snapshot") {
      this.#board.clear();
      this.#board.drawSnapshot(message.strokes);
    }

    if (message.type === "stroke") {
      this.#board.drawRemoteStroke(message);
    }

    if (message.type === "clear") {
      this.#board.clear();
    }
  }

  #updateStatus(status) {
    this.#status.textContent = status;
    this.#clearButton.disabled = status !== "Conectado";
  }
}

new ClientApp();
