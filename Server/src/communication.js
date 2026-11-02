import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const CLOSE_UNAUTHORIZED = 1008;
const CLOSE_SERVER_FULL = 1013;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_POLICY_VIOLATION = 1008;
const MAX_INVALID_MESSAGES = 30;
const INVALID_MESSAGE_WINDOW_MS = 10_000;

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Communication {
  #server;
  #clients = new Set();
  #strokes = new Map();
  #totalPoints = 0;
  #allowedIps;
  #allowedOrigins;
  #allowlistEnabled;
  #maxClients;
  #maxPayloadBytes;
  #maxBufferedBytes;
  #maxStrokes;
  #maxPointsPerStroke;
  #maxTotalPoints;
  #maxMessagesPerSecond;
  #persistence;
  #persistTimer = null;
  #persistChain = Promise.resolve();
  #heartbeatTimer = null;
  #closed = false;

  constructor({ server, access, limits, persistence }) {
    this.#allowlistEnabled = access.mode === "allowlist";
    this.#allowedIps = new Set(
      access.allowedIps.map((ip) => this.#normalizeIp(ip)).filter((ip) => ip !== ""),
    );
    this.#allowedOrigins = new Set(access.allowedOrigins);
    this.#maxClients = server.maxClients;
    this.#maxPayloadBytes = server.maxPayloadBytes;
    this.#maxBufferedBytes = server.maxBufferedBytes;
    this.#maxStrokes = limits.maxStrokes;
    this.#maxPointsPerStroke = limits.maxPointsPerStroke;
    this.#maxTotalPoints = limits.maxTotalPoints;
    this.#maxMessagesPerSecond = limits.maxMessagesPerSecond;
    this.#persistence = persistence;

    // Sin memoria persistida entre sesiones
    // this.#loadPersistedBoard();

    this.#server = new WebSocketServer({
      host: server.host,
      port: server.port,
      maxPayload: this.#maxPayloadBytes,
      clientTracking: false,
      perMessageDeflate: false,
    });

    this.#server.on("connection", (socket, request) => {
      this.#handleConnection(socket, request);
    });

    if (server.pingIntervalMs > 0) {
      this.#heartbeatTimer = setInterval(() => {
        this.#checkHeartbeat();
      }, server.pingIntervalMs);
      this.#heartbeatTimer.unref();
    }
  }

  get server() {
    return this.#server;
  }

  get clientCount() {
    return this.#clients.size;
  }

  get strokeCount() {
    return this.#strokes.size;
  }

  async close() {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }

    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }

    // No guardar en disco
    // try {
    //   await this.#flushPersistence();
    // } catch (error) {
    //   console.error("[Board] No se pudo guardar la pizarra al cerrar:", error.message);
    // }

    for (const client of this.#clients) {
      this.#sendJson(client.socket, {
        type: "server-shutdown",
        message: "El servidor se está apagando.",
      });
      client.socket.close(CLOSE_GOING_AWAY, "Servidor apagado");
    }

    this.#clients.clear();
    this.#strokes.clear();
    this.#totalPoints = 0;

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
      console.error(`[WS] Error de socket: ${error.message}`);
    });

    const origin = request.headers.origin;

    if (!this.#isOriginAllowed(origin)) {
      this.#reject(
        socket,
        "ORIGIN_NOT_ALLOWED",
        `Origen no permitido: ${origin}`,
        CLOSE_UNAUTHORIZED,
      );
      return;
    }

    const remoteIp = this.#normalizeIp(request.socket.remoteAddress);

    if (this.#allowlistEnabled && !this.#allowedIps.has(remoteIp)) {
      this.#reject(
        socket,
        "UNAUTHORIZED_CLIENT",
        `La IP ${remoteIp || "desconocida"} no está autorizada.`,
        CLOSE_UNAUTHORIZED,
      );
      return;
    }

    if (this.#clients.size >= this.#maxClients) {
      this.#reject(
        socket,
        "SERVER_FULL",
        "El servidor alcanzó el número máximo de clientes.",
        CLOSE_SERVER_FULL,
      );
      return;
    }

    const client = {
      id: crypto.randomUUID(),
      socket,
      isAlive: true,
      messageWindowStart: Date.now(),
      messageCount: 0,
      rateLimited: false,
      errorWindowStart: Date.now(),
      errorCount: 0,
      strokeIds: new Set(),
    };

    this.#clients.add(client);
    console.log(`[WS] Cliente conectado: id=${client.id} ip=${remoteIp || "desconocida"}`);

    socket.on("pong", () => {
      client.isAlive = true;
    });

    socket.on("message", (rawMessage, isBinary) => {
      this.#handleMessage(client, rawMessage, isBinary);
    });

    socket.on("close", () => {
      this.#handleDisconnect(client);
    });

    this.#sendJson(socket, {
      type: "snapshot",
      clientId: client.id,
      clients: this.#clients.size,
      strokes: this.#snapshotStrokes(),
    });

    this.#broadcast({ type: "presence", clients: this.#clients.size });
  }

  #handleDisconnect(client) {
    if (!this.#clients.delete(client)) {
      return;
    }

    console.log(`[WS] Cliente desconectado: id=${client.id}`);

    // Si no quedan clientes, limpiar todo (sin memoria entre sesiones)
    if (this.#clients.size === 0) {
      this.#strokes.clear();
      this.#totalPoints = 0;
      // Limpiar archivo de persistencia si existe
      if (this.#persistence?.enabled && this.#persistence?.file) {
        try {
          fs.unlinkSync(this.#persistence.file);
        } catch {}
        try {
          fs.unlinkSync(`${this.#persistence.file}.tmp`);
        } catch {}
      }
      return;
    }

    if (!this.#closed) {
      this.#broadcast({ type: "presence", clients: this.#clients.size });
    }
  }

  #handleMessage(client, rawMessage, isBinary) {
    if (this.#closed) {
      return;
    }

    if (isBinary) {
      this.#reportError(client, "INVALID_MESSAGE", "Los mensajes deben ser texto JSON.");
      return;
    }

    if (!this.#allowMessage(client)) {
      return;
    }

    let message;

    try {
      message = JSON.parse(rawMessage.toString("utf8"));
    } catch {
      this.#reportError(client, "INVALID_MESSAGE", "El mensaje no es JSON válido.");
      return;
    }

    try {
      const result = this.#applyMessage(client, message);

      if (result.reply) {
        this.#sendJson(client.socket, result.reply);
      }

      if (result.broadcast) {
        this.#broadcast(result.broadcast, client.socket);
      }

      // No guardar en disco
      // if (result.persist) {
      //   this.#schedulePersist();
      // }
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : "INVALID_MESSAGE";
      const errorMessage = error instanceof Error ? error.message : "Mensaje inválido.";
      this.#reportError(client, code, errorMessage);
    }
  }

  #applyMessage(client, message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      throw new ProtocolError("INVALID_MESSAGE", "El mensaje debe ser un objeto.");
    }

    switch (message.type) {
      case "stroke-start":
        return this.#applyStrokeStart(client, message);
      case "stroke-points":
        return this.#applyStrokePoints(client, message);
      case "stroke-end":
        return this.#applyStrokeEnd(client, message);
      case "stroke":
        return this.#applyStroke(client, message);
      case "clear":
        return this.#applyClear(client);
      case "ping":
        return { reply: { type: "pong", timestamp: Date.now() } };
      default:
        throw new ProtocolError("UNSUPPORTED_MESSAGE", "Tipo de mensaje no soportado.");
    }
  }

  #applyStrokeStart(client, message) {
    const strokeId = this.#validateStrokeId(message.strokeId);
    const style = this.#validateStyle(message.style);
    const existing = this.#strokes.get(strokeId);

    if (existing && existing.authorId !== client.id) {
      throw new ProtocolError("STROKE_CONFLICT", "El trazo pertenece a otro cliente.");
    }

    if (!existing && this.#strokes.size >= this.#maxStrokes) {
      throw new ProtocolError("BOARD_FULL", "La pizarra alcanzó el máximo de trazos.");
    }

    const point =
      message.point === undefined || message.point === null
        ? null
        : this.#validatePoint(message.point);
    const addedPoints = point ? 1 : 0;

    if (this.#totalPoints + addedPoints > this.#maxTotalPoints) {
      throw new ProtocolError("BOARD_FULL", "La pizarra alcanzó el máximo de puntos.");
    }

    if (existing) {
      this.#totalPoints -= existing.points.length;
      existing.points = point ? [point] : [];
      existing.style = style;
      existing.complete = false;
    } else {
      this.#strokes.set(strokeId, {
        strokeId,
        points: point ? [point] : [],
        style,
        authorId: client.id,
        complete: false,
      });
    }

    this.#totalPoints += addedPoints;
    client.strokeIds.add(strokeId);

    const broadcast = {
      type: "stroke-start",
      strokeId,
      style,
      authorId: client.id,
    };

    if (point) {
      broadcast.point = point;
    }

    return { broadcast, persist: false };
  }

  #applyStrokePoints(client, message) {
    const stroke = this.#requireOwnedStroke(client, message.strokeId);
    const points = this.#validatePoints(message.points);

    this.#ensurePointCapacity(stroke, points.length);
    stroke.points.push(...points);
    this.#totalPoints += points.length;

    return {
      broadcast: {
        type: "stroke-points",
        strokeId: stroke.strokeId,
        points,
        authorId: client.id,
      },
      persist: false,
    };
  }

  #applyStrokeEnd(client, message) {
    const stroke = this.#requireOwnedStroke(client, message.strokeId);
    let finalPoints = null;

    if (
      message.points !== undefined &&
      message.points !== null &&
      (!Array.isArray(message.points) || message.points.length > 0)
    ) {
      finalPoints = this.#validatePoints(message.points);
      this.#ensurePointCapacity(stroke, finalPoints.length);
      stroke.points.push(...finalPoints);
      this.#totalPoints += finalPoints.length;
    }

    const discard = stroke.points.length === 0;

    if (discard) {
      this.#strokes.delete(stroke.strokeId);
      client.strokeIds.delete(stroke.strokeId);
    } else {
      stroke.complete = true;
    }

    const broadcast = {
      type: "stroke-end",
      strokeId: stroke.strokeId,
      authorId: client.id,
    };

    if (finalPoints && finalPoints.length > 0) {
      broadcast.points = finalPoints;
    }

    if (discard) {
      broadcast.discard = true;
    }

    return { broadcast, persist: true };
  }

  #applyStroke(client, message) {
    const strokeId = this.#validateStrokeId(message.strokeId);
    const points = this.#validatePoints(message.points);
    const style = this.#validateStyle(message.style);
    const existing = this.#strokes.get(strokeId);

    if (existing && existing.authorId !== client.id) {
      throw new ProtocolError("STROKE_CONFLICT", "El trazo pertenece a otro cliente.");
    }

    if (!existing && this.#strokes.size >= this.#maxStrokes) {
      throw new ProtocolError("BOARD_FULL", "La pizarra alcanzó el máximo de trazos.");
    }

    const previousPoints = existing ? existing.points.length : 0;

    if (this.#totalPoints - previousPoints + points.length > this.#maxTotalPoints) {
      throw new ProtocolError("BOARD_FULL", "La pizarra alcanzó el máximo de puntos.");
    }

    if (points.length > this.#maxPointsPerStroke) {
      throw new ProtocolError("STROKE_TOO_LARGE", "El trazo supera el máximo de puntos.");
    }

    if (existing) {
      existing.points = points;
      existing.style = style;
      existing.complete = true;
    } else {
      this.#strokes.set(strokeId, {
        strokeId,
        points,
        style,
        authorId: client.id,
        complete: true,
      });
    }

    this.#totalPoints += points.length - previousPoints;
    client.strokeIds.add(strokeId);

    return {
      broadcast: {
        type: "stroke",
        strokeId,
        points,
        style,
        authorId: client.id,
      },
      persist: true,
    };
  }

  #applyClear(client) {
    this.#strokes.clear();
    this.#totalPoints = 0;

    for (const connectedClient of this.#clients) {
      connectedClient.strokeIds.clear();
    }

    // Borrar archivo de persistencia si existe
    if (this.#persistence?.enabled && this.#persistence?.file) {
      try {
        fs.unlinkSync(this.#persistence.file);
      } catch {}
      try {
        fs.unlinkSync(`${this.#persistence.file}.tmp`);
      } catch {}
    }

    return {
      broadcast: { type: "clear", authorId: client.id },
      persist: false,
    };
  }

  #requireOwnedStroke(client, rawStrokeId) {
    const strokeId = this.#validateStrokeId(rawStrokeId);
    const stroke = this.#strokes.get(strokeId);

    if (!stroke) {
      throw new ProtocolError("STROKE_NOT_FOUND", "El trazo no existe.");
    }

    if (stroke.authorId !== client.id) {
      throw new ProtocolError("STROKE_CONFLICT", "El trazo pertenece a otro cliente.");
    }

    return stroke;
  }

  #ensurePointCapacity(stroke, pointsToAdd) {
    if (stroke.points.length + pointsToAdd > this.#maxPointsPerStroke) {
      throw new ProtocolError("STROKE_TOO_LARGE", "El trazo supera el máximo de puntos.");
    }

    if (this.#totalPoints + pointsToAdd > this.#maxTotalPoints) {
      throw new ProtocolError("BOARD_FULL", "La pizarra alcanzó el máximo de puntos.");
    }
  }

  #validateStrokeId(value) {
    if (typeof value !== "string") {
      throw new ProtocolError("INVALID_STROKE", "El 'strokeId' es obligatorio.");
    }

    const strokeId = value.trim();

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(strokeId)) {
      throw new ProtocolError(
        "INVALID_STROKE",
        "El 'strokeId' solo admite letras, números, guiones y guiones bajos (máximo 128).",
      );
    }

    return strokeId;
  }

  #validatePoints(value) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ProtocolError("INVALID_STROKE", "El trazo debe incluir al menos un punto.");
    }

    if (value.length > this.#maxPointsPerStroke) {
      throw new ProtocolError("STROKE_TOO_LARGE", "El trazo supera el máximo de puntos.");
    }

    return value.map((point) => this.#validatePoint(point));
  }

  #validatePoint(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ProtocolError("INVALID_POINT", "Cada punto debe ser un objeto.");
    }

    if (
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y) ||
      value.x < 0 ||
      value.x > 1 ||
      value.y < 0 ||
      value.y > 1
    ) {
      throw new ProtocolError("INVALID_POINT", "Las coordenadas deben estar entre 0 y 1.");
    }

    const point = { x: value.x, y: value.y };

    if (value.pressure !== undefined) {
      if (
        typeof value.pressure !== "number" ||
        !Number.isFinite(value.pressure) ||
        value.pressure < 0 ||
        value.pressure > 1
      ) {
        throw new ProtocolError("INVALID_POINT", "La presión debe estar entre 0 y 1.");
      }

      point.pressure = value.pressure;
    }

    return point;
  }

  #validateStyle(value) {
    if (value === undefined || value === null) {
      return {};
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      throw new ProtocolError("INVALID_STYLE", "El estilo debe ser un objeto.");
    }

    const style = {};

    if (value.color !== undefined) {
      if (typeof value.color !== "string" || value.color.trim() === "" || value.color.length > 32) {
        throw new ProtocolError("INVALID_STYLE", "El color no es válido.");
      }

      style.color = value.color.trim();
    }

    if (value.width !== undefined) {
      if (
        typeof value.width !== "number" ||
        !Number.isFinite(value.width) ||
        value.width < 0.5 ||
        value.width > 100
      ) {
        throw new ProtocolError("INVALID_STYLE", "El grosor debe estar entre 0.5 y 100.");
      }

      style.width = value.width;
    }

    if (value.opacity !== undefined) {
      if (
        typeof value.opacity !== "number" ||
        !Number.isFinite(value.opacity) ||
        value.opacity < 0 ||
        value.opacity > 1
      ) {
        throw new ProtocolError("INVALID_STYLE", "La opacidad debe estar entre 0 y 1.");
      }

      style.opacity = value.opacity;
    }

    return style;
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
        this.#sendJson(client.socket, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Demasiados mensajes por segundo.",
        });
      }

      return false;
    }

    return true;
  }

  #reportError(client, code, message) {
    const now = Date.now();

    if (now - client.errorWindowStart >= INVALID_MESSAGE_WINDOW_MS) {
      client.errorWindowStart = now;
      client.errorCount = 0;
    }

    client.errorCount += 1;
    this.#sendJson(client.socket, { type: "error", code, message });

    if (client.errorCount > MAX_INVALID_MESSAGES) {
      client.socket.close(CLOSE_POLICY_VIOLATION, "Demasiados mensajes inválidos");
    }
  }

  #broadcast(message, senderSocket = null) {
    const payload = JSON.stringify(message);
    let recipients = 0;
    let dropped = 0;

    for (const client of this.#clients) {
      if (senderSocket && client.socket === senderSocket) {
        continue;
      }

      if (client.socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      if (client.socket.bufferedAmount > this.#maxBufferedBytes) {
        dropped += 1;
        continue;
      }

      try {
        client.socket.send(payload);
        recipients += 1;
      } catch {
        dropped += 1;
      }
    }

    if (dropped > 0) {
      console.warn(`[WS] Broadcast omitido para ${dropped} cliente(s) lento(s).`);
    }

    return recipients;
  }

  #sendJson(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  #reject(socket, code, message, closeCode) {
    this.#sendJson(socket, { type: "error", code, message });
    socket.close(closeCode, message.slice(0, 120));
  }

  #checkHeartbeat() {
    for (const client of this.#clients) {
      if (!client.isAlive) {
        console.warn(`[WS] Cliente sin respuesta: id=${client.id}. Cerrando conexión.`);
        client.socket.terminate();
        continue;
      }

      client.isAlive = false;

      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }
  }

  #snapshotStrokes() {
    return [...this.#strokes.values()].map((stroke) => ({
      strokeId: stroke.strokeId,
      points: stroke.points,
      style: stroke.style,
      authorId: stroke.authorId,
      complete: stroke.complete,
    }));
  }

  #loadPersistedBoard() {
    if (!this.#persistence.enabled) {
      return;
    }

    let raw;

    try {
      raw = fs.readFileSync(this.#persistence.file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[Board] No se pudo leer el archivo persistido: ${error.message}`);
      }

      return;
    }

    try {
      const data = JSON.parse(raw);
      const strokes = Array.isArray(data?.strokes) ? data.strokes : [];

      for (const item of strokes) {
        if (this.#strokes.size >= this.#maxStrokes) {
          break;
        }

        try {
          const strokeId = this.#validateStrokeId(item?.strokeId);

          if (this.#strokes.has(strokeId)) {
            continue;
          }

          const points = this.#validatePoints(item?.points);

          if (this.#totalPoints + points.length > this.#maxTotalPoints) {
            break;
          }

          const style = this.#validateStyle(item?.style);
          const authorId =
            typeof item?.authorId === "string" && item.authorId !== ""
              ? item.authorId
              : "persisted";

          this.#strokes.set(strokeId, {
            strokeId,
            points,
            style,
            authorId,
            complete: true,
          });
          this.#totalPoints += points.length;
        } catch {
          continue;
        }
      }

      if (this.#strokes.size > 0) {
        console.log(`[Board] ${this.#strokes.size} trazo(s) restaurado(s) desde disco.`);
      }
    } catch (error) {
      console.warn(`[Board] El archivo persistido no es válido: ${error.message}`);
    }
  }

  #schedulePersist() {
    if (!this.#persistence.enabled || this.#closed || this.#persistTimer) {
      return;
    }

    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;

      this.#flushPersistence().catch((error) => {
        console.error(`[Board] No se pudo guardar la pizarra: ${error.message}`);
      });
    }, this.#persistence.debounceMs);

    this.#persistTimer.unref();
  }

  #flushPersistence() {
    if (!this.#persistence.enabled) {
      return Promise.resolve();
    }

    const strokes = [...this.#strokes.values()]
      .filter((stroke) => stroke.complete)
      .map((stroke) => ({
        strokeId: stroke.strokeId,
        points: stroke.points,
        style: stroke.style,
        authorId: stroke.authorId,
      }));

    const content = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      strokes,
    });

    const write = async () => {
      await fs.promises.mkdir(path.dirname(this.#persistence.file), { recursive: true });
      const temporaryFile = `${this.#persistence.file}.tmp`;
      await fs.promises.writeFile(temporaryFile, content, "utf8");
      await fs.promises.rename(temporaryFile, this.#persistence.file);
    };

    this.#persistChain = this.#persistChain.then(write, write);
    return this.#persistChain;
  }

  #isOriginAllowed(origin) {
    if (typeof origin !== "string" || origin === "") {
      return true;
    }

    return this.#allowedOrigins.has("*") || this.#allowedOrigins.has(origin);
  }

  #normalizeIp(ip) {
    if (typeof ip !== "string") {
      return "";
    }

    return ip.replace(/^::ffff:/, "").replace(/^\[|\]$/g, "");
  }
}
