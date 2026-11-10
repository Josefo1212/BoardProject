import { WebSocketServer } from "ws";

const CLOSE_UNAUTHORIZED = 1008;
const CLOSE_GOING_AWAY = 1001;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_MESSAGES_PER_SECOND = 2_000;

const NAMESPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAMESPACE_ROOM = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Valida un namespace de señalización de la librería `p2p`.
 *
 * La librería usa dos formatos:
 *   ['sender', sala]          -> anuncio general
 *   ['sender', sala, id]      -> mensaje dirigido a un peer concreto
 *   ['receiver', sala]
 *   ['receiver', sala, id]
 *
 * Devuelve el namespace normalizado o null si no es válido.
 */
export function normalizeNamespace(namespace, room = null) {
  if (!Array.isArray(namespace) || namespace.length < 2 || namespace.length > 3) {
    return null;
  }

  const [kind, namespaceRoom, id] = namespace;

  if (kind !== "sender" && kind !== "receiver") {
    return null;
  }

  if (typeof namespaceRoom !== "string" || !NAMESPACE_ROOM.test(namespaceRoom)) {
    return null;
  }

  if (room && namespaceRoom !== room) {
    return null;
  }

  if (id !== undefined && (typeof id !== "string" || !NAMESPACE_ID.test(id))) {
    return null;
  }

  return id === undefined ? [kind, namespaceRoom] : [kind, namespaceRoom, id];
}

export function namespaceKey(namespace, room = null) {
  const normalized = normalizeNamespace(namespace, room);
  return normalized ? normalized.join(":") : null;
}

function sendJson(socket, payload) {
  if (socket.readyState !== 1) {
    return false;
  }

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function normalizeIp(ip) {
  if (typeof ip !== "string") {
    return "";
  }

  return ip.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
}

/**
 * Broker de señalización en memoria.
 *
 * Actúa como driver de la librería `p2p` en el servidor (suscripciones
 * locales) y, a la vez, enruta los mensajes de los navegadores que llegan
 * por WebSocket (suscripciones remotas).
 */
export class SignalingHub {
  #room;
  #localSubs = new Map();
  #remoteSubs = new Map();
  #remoteNamespaces = new Map();

  constructor({ room = null } = {}) {
    this.#room = room;
  }

  get room() {
    return this.#room;
  }

  get localSubscriberCount() {
    let total = 0;
    for (const handlers of this.#localSubs.values()) total += handlers.size;
    return total;
  }

  get remoteSubscriberCount() {
    let total = 0;
    for (const sockets of this.#remoteSubs.values()) total += sockets.size;
    return total;
  }

  // --- Interfaz que consume la librería `p2p` (lado servidor) ---

  subscribe(namespace, handler) {
    const key = namespaceKey(namespace, this.#room);

    if (!key) {
      throw new Error("Namespace de señalización inválido.");
    }

    if (!this.#localSubs.has(key)) {
      this.#localSubs.set(key, new Set());
    }

    this.#localSubs.get(key).add(handler);
  }

  unsubscribe(namespace, handler) {
    const key = namespaceKey(namespace, this.#room);

    if (!key) {
      return;
    }

    const handlers = this.#localSubs.get(key);

    if (!handlers) {
      return;
    }

    if (handler) {
      handlers.delete(handler);
    } else {
      handlers.clear();
    }

    if (handlers.size === 0) {
      this.#localSubs.delete(key);
    }
  }

  publish(namespace, message) {
    const normalized = normalizeNamespace(namespace, this.#room);

    if (!normalized) {
      return 0;
    }

    const key = normalized.join(":");
    let delivered = 0;

    for (const handler of this.#localSubs.get(key) ?? []) {
      try {
        handler(message);
        delivered += 1;
      } catch (error) {
        console.warn(`[Signal] Error en suscriptor local: ${error.message}`);
      }
    }

    for (const socket of this.#remoteSubs.get(key) ?? []) {
      if (sendJson(socket, { op: "message", namespace: normalized, message })) {
        delivered += 1;
      }
    }

    return delivered;
  }

  // --- Interfaz para los navegadores (lado remoto) ---

  publishRemote(socket, namespace, message) {
    const normalized = normalizeNamespace(namespace, this.#room);

    if (!normalized) {
      return 0;
    }

    const key = normalized.join(":");
    let delivered = 0;

    for (const handler of this.#localSubs.get(key) ?? []) {
      try {
        handler(message);
        delivered += 1;
      } catch (error) {
        console.warn(`[Signal] Error en suscriptor local: ${error.message}`);
      }
    }

    for (const other of this.#remoteSubs.get(key) ?? []) {
      if (other === socket) {
        continue;
      }

      if (sendJson(other, { op: "message", namespace: normalized, message })) {
        delivered += 1;
      }
    }

    return delivered;
  }

  subscribeRemote(socket, namespace) {
    const normalized = normalizeNamespace(namespace, this.#room);

    if (!normalized) {
      return null;
    }

    const key = normalized.join(":");

    if (!this.#remoteSubs.has(key)) {
      this.#remoteSubs.set(key, new Set());
    }

    this.#remoteSubs.get(key).add(socket);

    if (!this.#remoteNamespaces.has(socket)) {
      this.#remoteNamespaces.set(socket, new Set());
    }

    this.#remoteNamespaces.get(socket).add(key);

    return normalized;
  }

  unsubscribeRemote(socket, namespace) {
    const key = namespaceKey(namespace, this.#room);

    if (!key) {
      return;
    }

    const sockets = this.#remoteSubs.get(key);

    if (sockets) {
      sockets.delete(socket);

      if (sockets.size === 0) {
        this.#remoteSubs.delete(key);
      }
    }

    this.#remoteNamespaces.get(socket)?.delete(key);
  }

  removeSocket(socket) {
    const keys = this.#remoteNamespaces.get(socket);

    if (!keys) {
      return;
    }

    for (const key of keys) {
      const sockets = this.#remoteSubs.get(key);

      if (sockets) {
        sockets.delete(socket);

        if (sockets.size === 0) {
          this.#remoteSubs.delete(key);
        }
      }
    }

    this.#remoteNamespaces.delete(socket);
  }
}

/**
 * Servidor WebSocket de señalización montado en `/signal`.
 *
 * No escucha por su cuenta: se engancha al servidor HTTP mediante
 * `handleUpgrade`, igual que el WebSocket del tablero en `/board`.
 */
export class SignalingServer {
  #server;
  #hub;
  #room;
  #allowedOrigins;
  #allowlistEnabled;
  #allowedIps;
  #maxPayloadBytes;
  #maxMessagesPerSecond;
  #sockets = new Set();
  #closed = false;

  constructor({
    hub,
    access,
    room = null,
    maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
    maxMessagesPerSecond = DEFAULT_MAX_MESSAGES_PER_SECOND,
  }) {
    this.#hub = hub;
    this.#room = room;
    this.#allowedOrigins = new Set(access.allowedOrigins);
    this.#allowlistEnabled = access.mode === "allowlist";
    this.#allowedIps = new Set(access.allowedIps.map(normalizeIp).filter((ip) => ip !== ""));
    this.#maxPayloadBytes = maxPayloadBytes;
    this.#maxMessagesPerSecond = maxMessagesPerSecond;

    this.#server = new WebSocketServer({
      noServer: true,
      maxPayload: this.#maxPayloadBytes,
      clientTracking: false,
      perMessageDeflate: false,
    });

    this.#server.on("connection", (socket, request) => {
      this.#handleConnection(socket, request);
    });
  }

  get server() {
    return this.#server;
  }

  get clientCount() {
    return this.#sockets.size;
  }

  handleUpgrade(request, socket, head) {
    this.#server.handleUpgrade(request, socket, head, (ws) => {
      this.#server.emit("connection", ws, request);
    });
  }

  async close() {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const socket of this.#sockets) {
      try {
        socket.close(CLOSE_GOING_AWAY, "Servidor apagado");
      } catch {}
    }

    this.#sockets.clear();

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      timer.unref();

      try {
        this.#server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  #handleConnection(socket, request) {
    socket.on("error", (error) => {
      console.error(`[Signal] Error de socket: ${error.message}`);
    });

    const origin = request.headers.origin;

    if (!this.#isOriginAllowed(origin)) {
      sendJson(socket, {
        op: "error",
        code: "ORIGIN_NOT_ALLOWED",
        message: `Origen no permitido: ${origin}`,
      });
      socket.close(CLOSE_UNAUTHORIZED, "Origen no permitido");
      return;
    }

    const remoteIp = normalizeIp(request.socket.remoteAddress);

    if (this.#allowlistEnabled && !this.#allowedIps.has(remoteIp)) {
      sendJson(socket, {
        op: "error",
        code: "UNAUTHORIZED_CLIENT",
        message: `La IP ${remoteIp || "desconocida"} no está autorizada.`,
      });
      socket.close(CLOSE_UNAUTHORIZED, "IP no autorizada");
      return;
    }

    const client = {
      socket,
      messageWindowStart: Date.now(),
      messageCount: 0,
      rateLimited: false,
    };

    this.#sockets.add(socket);

    socket.on("message", (rawMessage) => {
      this.#handleMessage(client, rawMessage);
    });

    socket.on("close", () => {
      this.#sockets.delete(socket);
      this.#hub.removeSocket(socket);
    });

    sendJson(socket, { op: "welcome", room: this.#room });
  }

  #handleMessage(client, rawMessage) {
    if (this.#closed) {
      return;
    }

    if (!this.#allowMessage(client)) {
      return;
    }

    let payload;

    try {
      payload = JSON.parse(rawMessage.toString("utf8"));
    } catch {
      sendJson(client.socket, {
        op: "error",
        code: "INVALID_MESSAGE",
        message: "El mensaje no es JSON válido.",
      });
      return;
    }

    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      sendJson(client.socket, {
        op: "error",
        code: "INVALID_MESSAGE",
        message: "El mensaje debe ser un objeto.",
      });
      return;
    }

    const { op, namespace, message } = payload;

    if (op === "subscribe") {
      const normalized = this.#hub.subscribeRemote(client.socket, namespace);

      if (!normalized) {
        sendJson(client.socket, {
          op: "error",
          code: "INVALID_NAMESPACE",
          message: "El namespace de señalización no es válido.",
        });
        return;
      }

      sendJson(client.socket, { op: "subscribed", namespace: normalized });
      return;
    }

    if (op === "unsubscribe") {
      this.#hub.unsubscribeRemote(client.socket, namespace);
      sendJson(client.socket, { op: "unsubscribed", namespace });
      return;
    }

    if (op === "publish") {
      const normalized = normalizeNamespace(namespace, this.#room);

      if (!normalized) {
        sendJson(client.socket, {
          op: "error",
          code: "INVALID_NAMESPACE",
          message: "El namespace de señalización no es válido.",
        });
        return;
      }

      if (message === undefined) {
        sendJson(client.socket, {
          op: "error",
          code: "INVALID_MESSAGE",
          message: "Falta el mensaje a publicar.",
        });
        return;
      }

      let size = 0;

      try {
        size = JSON.stringify(message).length;
      } catch {
        sendJson(client.socket, {
          op: "error",
          code: "INVALID_MESSAGE",
          message: "El mensaje no se puede serializar.",
        });
        return;
      }

      if (size > this.#maxPayloadBytes) {
        sendJson(client.socket, {
          op: "error",
          code: "MESSAGE_TOO_LARGE",
          message: "El mensaje de señalización es demasiado grande.",
        });
        return;
      }

      this.#hub.publishRemote(client.socket, normalized, message);
      return;
    }

    sendJson(client.socket, {
      op: "error",
      code: "UNSUPPORTED_OP",
      message: "Operación de señalización no soportada.",
    });
  }

  #allowMessage(client) {
    const now = Date.now();

    if (now - client.messageWindowStart >= 1_000) {
      client.messageWindowStart = now;
      client.messageCount = 0;
      client.rateLimited = false;
    }

    client.messageCount += 1;

    if (client.messageCount > this.#maxMessagesPerSecond) {
      if (!client.rateLimited) {
        client.rateLimited = true;
        sendJson(client.socket, {
          op: "error",
          code: "RATE_LIMITED",
          message: "Demasiados mensajes de señalización por segundo.",
        });
      }

      return false;
    }

    return true;
  }

  #isOriginAllowed(origin) {
    if (typeof origin !== "string" || origin === "") {
      return true;
    }

    return this.#allowedOrigins.has("*") || this.#allowedOrigins.has(origin);
  }
}
