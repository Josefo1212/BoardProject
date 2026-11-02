export class Communication {
  #socket = null;

  get socket() {
    return this.#socket;
  }

  connect(url, handlers) {
    this.disconnect();
    this.#socket = new WebSocket(url);

    this.#socket.addEventListener("open", handlers.open);
    this.#socket.addEventListener("message", handlers.message);
    this.#socket.addEventListener("close", handlers.close);
    this.#socket.addEventListener("error", handlers.error);

    return this.#socket;
  }

  send(message) {
    if (this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(JSON.stringify(message));
    return true;
  }

  disconnect() {
    this.#socket?.close();
    this.#socket = null;
  }
}
