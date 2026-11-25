import { P2PCommunication } from "./P2PCommunication.js";

export class Communication {
  #socket = null;
  #p2p = null;
  #iceServers;

  constructor({ iceServers = [] } = {}) {
    this.#iceServers = iceServers;
  }

  get socket() {
    return this.#socket;
  }

  connect(url, handlers) {
    this.disconnect();
    const p2p = new P2PCommunication(url, {
      ...handlers,
      close: (event) => {
        if (this.#p2p) {
          this.#p2p = null;
          this.#socket = null;
        }
        handlers.close(event);
      },
    }, this.#iceServers);
    this.#p2p = p2p;
    this.#socket = p2p.socket;

    const fallbackTimer = setTimeout(() => {
      if (!p2p.socket.readyState) {
        p2p.close(false);
        this.#p2p = null;
        this.#socket = new WebSocket(url);
        this.#wireWebSocket(this.#socket, handlers);
      }
    }, 8_000);

    const originalOpen = handlers.open;
    p2p.socket.addEventListener?.("open", () => {
      clearTimeout(fallbackTimer);
      originalOpen();
    });

    return this.#socket;
  }

  send(message) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  disconnect() {
    this.#p2p?.close();
    this.#p2p = null;
    this.#socket?.close();
    this.#socket = null;
  }

  #wireWebSocket(socket, handlers) {
    socket.addEventListener("open", handlers.open);
    socket.addEventListener("message", handlers.message);
    socket.addEventListener("close", handlers.close);
    socket.addEventListener("error", handlers.error);
  }
}
