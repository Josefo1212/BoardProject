import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const MAX_MESSAGE_SIZE = 256 * 1024;
const MAX_POINTS_PER_STROKE = 10_000;

export class Communication {
  #server;
  #clients = new Set();
  #board = [];
  #allowedIps;

  constructor({ host, port, allowedClients = [] }) {
    this.#allowedIps = new Set(
      allowedClients
        .map((client) => client?.ip)
        .filter((ip) => typeof ip === "string" && ip.trim() !== "")
        .map((ip) => this.#normalizeIp(ip)),
    );
    this.#allowedIps.add("127.0.0.1");
    this.#allowedIps.add("::1");

    this.#server = new WebSocketServer({
      host,
      port,
      maxPayload: MAX_MESSAGE_SIZE,
    });

    this.#server.on("connection", (socket, request) => {
      this.#handleConnection(socket, request);
    });
  }

  get server() {
    return this.#server;
  }

  #handleConnection(socket, request) {
    const remoteIp = this.#normalizeIp(request.socket.remoteAddress);

    if (this.#allowedIps.size > 0 && !this.#allowedIps.has(remoteIp)) {
      console.warn(`[WS] Conexión rechazada: ip=${remoteIp || "desconocida"}`);
      this.#sendJson(socket, {
        type: "error",
        code: "UNAUTHORIZED_CLIENT",
        message: `La IP ${remoteIp || "desconocida"} no está autorizada.`,
      });
      socket.close(1008, "Cliente no autorizado");
      return;
    }

    const client = {
      id: crypto.randomUUID(),
      socket,
    };

    this.#clients.add(client);
    console.log(`[WS] Cliente conectado: id=${client.id} ip=${remoteIp}`);
    this.#sendJson(socket, {
      type: "snapshot",
      strokes: this.#board,
    });

    socket.on("message", (rawMessage, isBinary) => {
      this.#handleMessage(socket, rawMessage, isBinary);
    });

    socket.on("close", () => {
      this.#clients.delete(client);
      console.log(`[WS] Cliente desconectado: id=${client.id}`);
    });

    socket.on("error", (error) => {
      console.error(`Error del cliente ${client.id}:`, error.message);
    });
  }

  #handleMessage(socket, rawMessage, isBinary) {
    if (isBinary) {
      console.warn(`[WS] Mensaje binario rechazado: cliente=${this.#getClientId(socket)}`);
      this.#sendError(socket, "INVALID_MESSAGE", "Los mensajes deben ser texto JSON.");
      return;
    }

    try {
      const message = JSON.parse(rawMessage.toString("utf8"));
      console.log(
        `[WS] Mensaje recibido: cliente=${this.#getClientId(socket)} ${this.#describeMessage(message)}`,
      );
      const validatedMessage = this.#validateMessage(message);

      if (validatedMessage.type === "clear") {
        this.#board.length = 0;
      } else {
        this.#board.push(validatedMessage);
      }

      this.#broadcast(validatedMessage, socket);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mensaje inválido.";
      console.warn(`[WS] Mensaje inválido: cliente=${this.#getClientId(socket)} error="${message}"`);
      this.#sendError(socket, "INVALID_MESSAGE", message);
    }
  }

  #validateMessage(message) {
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      throw new Error("El mensaje debe incluir un tipo.");
    }

    if (message.type === "clear") {
      return { type: "clear" };
    }

    if (message.type !== "stroke") {
      throw new Error("Tipo de mensaje no soportado.");
    }

    if (
      typeof message.strokeId !== "string" ||
      !Array.isArray(message.points) ||
      message.points.length === 0 ||
      message.points.length > MAX_POINTS_PER_STROKE
    ) {
      throw new Error("El trazo no tiene un formato válido.");
    }

    const points = message.points.map((point) => {
      if (
        !point ||
        typeof point.x !== "number" ||
        typeof point.y !== "number" ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.x > 1 ||
        point.y < 0 ||
        point.y > 1
      ) {
        throw new Error("Las coordenadas deben ser números entre 0 y 1.");
      }

      return {
        x: point.x,
        y: point.y,
        ...(typeof point.pressure === "number" ? { pressure: point.pressure } : {}),
      };
    });

    return {
      type: "stroke",
      strokeId: message.strokeId,
      points,
      ...(message.style && typeof message.style === "object"
        ? { style: message.style }
        : {}),
    };
  }

  #broadcast(message, senderSocket) {
    let recipients = 0;

    for (const client of this.#clients) {
      if (client.socket !== senderSocket && client.socket.readyState === WebSocket.OPEN) {
        this.#sendJson(client.socket, message);
        recipients += 1;
      }
    }

    console.log(
      `[WS] Broadcast enviado: tipo=${message.type} destinatarios=${recipients}`,
    );
  }

  #sendError(socket, code, message) {
    this.#sendJson(socket, { type: "error", code, message });
  }

  #sendJson(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      console.log(
        `[WS] Mensaje enviado: cliente=${this.#getClientId(socket)} ${this.#describeMessage(message)}`,
      );
    }
  }

  #getClientId(socket) {
    return [...this.#clients].find((client) => client.socket === socket)?.id ?? "desconocido";
  }

  #describeMessage(message) {
    if (!message || typeof message !== "object") {
      return "tipo=desconocido";
    }

    const details = [`tipo=${message.type ?? "desconocido"}`];

    if (message.type === "stroke") {
      details.push(`strokeId=${message.strokeId ?? "desconocido"}`);
      details.push(`puntos=${Array.isArray(message.points) ? message.points.length : 0}`);
    }

    return details.join(" ");
  }

  #normalizeIp(ip) {
    if (typeof ip !== "string") {
      return "";
    }

    return ip.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  }
}
