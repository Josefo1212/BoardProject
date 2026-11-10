import { Receiver } from "./vendor/p2p.esm.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class SignalingDriver {
  #socket;
  #subscriptions = new Map();
  #pending = [];

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("open", () => {
      for (const payload of this.#pending.splice(0)) {
        this.#socket.send(JSON.stringify(payload));
      }
    });
    this.#socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.op !== "message" || !Array.isArray(payload.namespace)) {
        return;
      }

      const key = payload.namespace.join(":");
      for (const handler of this.#subscriptions.get(key) || []) {
        handler(payload.message);
      }
    });
  }

  subscribe(namespace, handler) {
    const key = namespace.join(":");
    if (!this.#subscriptions.has(key)) {
      this.#subscriptions.set(key, new Set());
    }
    this.#subscriptions.get(key).add(handler);
    this.#send({ op: "subscribe", namespace });
  }

  unsubscribe(namespace, handler) {
    const key = namespace.join(":");
    this.#subscriptions.get(key)?.delete(handler);
    this.#send({ op: "unsubscribe", namespace });
  }

  publish(namespace, message) {
    this.#send({ op: "publish", namespace, message });
  }

  close() {
    this.#socket.close();
    this.#subscriptions.clear();
    this.#pending = [];
  }

  #send(payload) {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(payload));
    } else if (this.#socket.readyState === WebSocket.CONNECTING) {
      this.#pending.push(payload);
    }
  }
}

export class P2PCommunication {
  #receiver = null;
  #driver = null;
  #channel = null;
  #socket = {
    readyState: CONNECTING,
    bufferedAmount: 0,
    send: (payload) => this.send(payload),
    close: () => this.close(),
    terminate: () => this.close(),
  };
  #handlers;
  #opened = false;
  #closed = false;

  constructor(url, handlers, iceServers = []) {
    this.#handlers = handlers;
    const signalingUrl = new URL(url);
    signalingUrl.pathname = "/signal";
    signalingUrl.search = "";
    this.#driver = new SignalingDriver(signalingUrl.toString());
    this.#receiver = new Receiver({ driver: this.#driver, iceServers });
    this.#receiver.addEventListener("channel:open", (event) => {
      if (this.#closed || event.detail?.channel?.label !== "board") {
        return;
      }

      this.#channel = event.detail.channel;
      this.#channel.addEventListener("message", (message) => {
        this.#handlers.message({ data: message.data });
      });
      this.#channel.addEventListener("close", () => this.close(true, 1006));
      this.#socket.readyState = OPEN;
      this.#opened = true;
      this.#handlers.open();
    });
    this.#receiver.addEventListener("channel:error", () => {
      if (!this.#opened) this.close();
    });
    this.#receiver.addEventListener("dispose", () => this.close());
    this.#receiver.start({ room: new URL(url).searchParams.get("room") || "pizarra" });
  }

  get socket() {
    return this.#socket;
  }

  send(payload) {
    if (this.#socket.readyState !== OPEN || !this.#channel) return false;
    try {
      this.#channel.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  close(notify = true, code = this.#opened ? 1000 : 1006) {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.readyState = CLOSED;
    try {
      this.#receiver?.stop();
    } catch {}
    this.#driver?.close();
    if (notify) {
      this.#handlers.close({ code });
    }
  }
}
