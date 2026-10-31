export class Communication {
  #socket = null;
  #onMessage;
  #onStatusChange;

  constructor({ onMessage, onStatusChange }) {
    this.#onMessage = onMessage;
    this.#onStatusChange = onStatusChange;
  }

  connect(url) {
    this.disconnect();
    this.#onStatusChange("Conectando...");
    this.#socket = new WebSocket(url);

    this.#socket.addEventListener("open", () => {
      this.#onStatusChange("Conectado");
    });

    this.#socket.addEventListener("message", ({ data }) => {
      try {
        const message = JSON.parse(data);
        this.#onMessage(message);

        if (message.type === "error") {
          this.#onStatusChange(message.message);
        }
      } catch {
        this.#onStatusChange("Mensaje inválido recibido");
      }
    });

    this.#socket.addEventListener("close", ({ code, reason }) => {
      const detail = reason || `código ${code}`;
      this.#onStatusChange(`Desconectado (${detail})`);
    });

    this.#socket.addEventListener("error", () => {
      this.#onStatusChange("Error de conexión: revisa la URL y el servidor");
    });
  }

  send(message) {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.#socket.send(JSON.stringify(message));
    return true;
  }

  disconnect() {
    this.#socket?.close();
    this.#socket = null;
  }
}
