import { PeerSocket } from "./peer-socket.js";

/**
 * Carga la librería `p2p` en Node.
 *
 * El navegador ya trae WebRTC, pero Node no. `node-datachannel/polyfill`
 * rellena `RTCPeerConnection`, `RTCSessionDescription` y `RTCIceCandidate`
 * antes de que `p2p` cree ninguna conexión.
 */
export async function loadP2P() {
  const polyfillModule = await import("node-datachannel/polyfill");
  const polyfill = polyfillModule.default || polyfillModule;

  globalThis.RTCPeerConnection ??= polyfill.RTCPeerConnection;
  globalThis.RTCSessionDescription ??= polyfill.RTCSessionDescription;
  globalThis.RTCIceCandidate ??= polyfill.RTCIceCandidate;
  globalThis.RTCDataChannel ??= polyfill.RTCDataChannel;

  const { Sender } = await import("p2p/dist/p2p.esm.js");
  return { Sender };
}

/**
 * Lado servidor de la topología P2P: el servidor es el `Sender` y cada
 * navegador es un `Receiver`. Por cada DataChannel abierto se registra un
 * `PeerSocket` en `Communication`, que sigue siendo la autoridad del tablero.
 */
export class PeerServer {
  #sender;
  #communication;
  #room;
  #sockets = new Map();
  #closed = false;

  constructor({ hub, room, iceServers, communication, Sender }) {
    this.#communication = communication;
    this.#room = room;
    this.#sender = new Sender({ driver: hub, iceServers });
    this.#wire();
  }

  get active() {
    return !this.#closed;
  }

  get peerCount() {
    return this.#sockets.size;
  }

  start() {
    if (this.#closed) {
      return;
    }

    this.#sender.start({
      room: this.#room,
      channels: { board: { ordered: true } },
    });

    console.log(`[P2P] Sender escuchando en la sala '${this.#room}'.`);
  }

  async close() {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const socket of this.#sockets.values()) {
      socket.close(1001, "Servidor apagado");
    }

    this.#sockets.clear();

    try {
      this.#sender.stop();
    } catch {}
  }

  #wire() {
    this.#sender.addEventListener("channel:open", (event) => {
      const { id, channel } = event.detail || {};

      if (this.#closed || !id || !channel) {
        return;
      }

      this.#attach(id, channel);
    });

    this.#sender.addEventListener("channel:close", (event) => {
      this.#detach(event.detail?.id, "Canal cerrado");
    });

    this.#sender.addEventListener("dispose", (event) => {
      this.#detach(event.detail?.id, "Conexión liberada");
    });

    this.#sender.addEventListener("channel:error", (event) => {
      const { id, error } = event.detail || {};
      console.warn(`[P2P] Error de canal con ${id || "peer"}: ${error?.message || "desconocido"}`);
      this.#detach(id, "Error de canal");
    });

    this.#sender.addEventListener("error", (event) => {
      const { id, error } = event.detail || {};
      console.warn(`[P2P] Error de conexión con ${id || "peer"}: ${error?.message || "desconocido"}`);
    });
  }

  #attach(peerId, channel) {
    if (this.#sockets.has(peerId)) {
      this.#detach(peerId, "Conexión reemplazada");
    }

    const socket = new PeerSocket(channel, { peerId });
    this.#sockets.set(peerId, socket);

    const client = this.#communication.attachPeer(socket, {
      peerId,
      remoteIp: "p2p",
    });

    if (!client) {
      this.#sockets.delete(peerId);
      socket.close(1013, "Servidor lleno");
    }
  }

  #detach(peerId, reason = "Desconectado") {
    if (!peerId) {
      return;
    }

    const socket = this.#sockets.get(peerId);

    if (!socket) {
      return;
    }

    this.#sockets.delete(peerId);
    socket.close(1000, reason);
  }
}
