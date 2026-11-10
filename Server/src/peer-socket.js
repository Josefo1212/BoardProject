import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const CHUNK_SIZE = 16_000;
const CHUNK_PREFIX = "P2P1|";
const REASSEMBLY_TIMEOUT_MS = 15_000;

const OPEN = 1;
const CLOSED = 3;

function toText(data) {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  return String(data);
}

/**
 * Adaptador que hace que un RTCDataChannel se comporte como un socket `ws`.
 *
 * `Communication` solo necesita `readyState`, `bufferedAmount`, `send`,
 * `close`, `terminate`, `ping` y los eventos `message` / `close` / `error`.
 * Los mensajes grandes (por ejemplo el snapshot) se trocean en ambos sentidos.
 */
export class PeerSocket extends EventEmitter {
  #channel;
  #peerId;
  #readyState = OPEN;
  #chunks = new Map();
  #chunkTimers = new Map();
  #closeEmitted = false;

  constructor(channel, { peerId = null } = {}) {
    super();

    this.#channel = channel;
    this.#peerId = peerId;
    this.#readyState = channel.readyState === "open" ? OPEN : 0;

    channel.addEventListener("close", () => {
      this.#readyState = CLOSED;
      this.#clearChunks();
      this.#emitClose();
    });

    channel.addEventListener("error", (event) => {
      this.emit("error", event?.error || event);
    });

    channel.addEventListener("message", (event) => {
      this.#handleIncoming(event.data);
    });
  }

  get peerId() {
    return this.#peerId;
  }

  get isPeer() {
    return true;
  }

  get readyState() {
    return this.#readyState;
  }

  get bufferedAmount() {
    try {
      return Number(this.#channel.bufferedAmount) || 0;
    } catch {
      return 0;
    }
  }

  send(payload) {
    if (this.#readyState !== OPEN) {
      return false;
    }

    const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");

    try {
      if (text.length <= CHUNK_SIZE) {
        this.#channel.send(text);
        return true;
      }

      const id = crypto.randomUUID();
      const total = Math.ceil(text.length / CHUNK_SIZE);

      for (let index = 0; index < total; index += 1) {
        const data = text.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
        this.#channel.send(CHUNK_PREFIX + JSON.stringify({ id, i: index, n: total, d: data }));
      }

      return true;
    } catch {
      return false;
    }
  }

  ping() {
    // Los DataChannels no usan ping/pong de WebSocket. La conexión se
    // supervisa con los eventos ICE y con el cierre del canal.
  }

  pong() {}

  terminate() {
    this.close();
  }

  close() {
    this.#readyState = CLOSED;

    try {
      this.#channel.close();
    } catch {}

    this.#clearChunks();
    this.#emitClose();
  }

  #emitClose() {
    if (this.#closeEmitted) {
      return;
    }

    this.#closeEmitted = true;
    this.emit("close");
  }

  #handleIncoming(data) {
    const text = toText(data);

    if (!text.startsWith(CHUNK_PREFIX)) {
      this.emit("message", text, false);
      return;
    }

    let chunk;

    try {
      chunk = JSON.parse(text.slice(CHUNK_PREFIX.length));
    } catch {
      return;
    }

    if (
      !chunk ||
      typeof chunk.id !== "string" ||
      !Number.isInteger(chunk.i) ||
      !Number.isInteger(chunk.n) ||
      chunk.n < 1 ||
      chunk.i < 0 ||
      chunk.i >= chunk.n ||
      typeof chunk.d !== "string"
    ) {
      return;
    }

    let entry = this.#chunks.get(chunk.id);

    if (!entry) {
      entry = { total: chunk.n, parts: new Array(chunk.n), received: 0 };
      this.#chunks.set(chunk.id, entry);

      const timer = setTimeout(() => {
        this.#chunks.delete(chunk.id);
        this.#chunkTimers.delete(chunk.id);
      }, REASSEMBLY_TIMEOUT_MS);
      timer.unref?.();
      this.#chunkTimers.set(chunk.id, timer);
    }

    if (entry.parts[chunk.i] === undefined) {
      entry.parts[chunk.i] = chunk.d;
      entry.received += 1;
    }

    if (entry.received === entry.total) {
      clearTimeout(this.#chunkTimers.get(chunk.id));
      this.#chunkTimers.delete(chunk.id);
      this.#chunks.delete(chunk.id);
      this.emit("message", entry.parts.join(""), false);
    }
  }

  #clearChunks() {
    for (const timer of this.#chunkTimers.values()) {
      clearTimeout(timer);
    }

    this.#chunkTimers.clear();
    this.#chunks.clear();
  }
}
