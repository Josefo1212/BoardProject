import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Communication } from "./communication.js";
import { PeerServer, loadP2P } from "./peer-server.js";
import { SignalingHub, SignalingServer } from "./signaling.js";
import { createStaticHandler } from "./static.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const config = loadConfig(path.join(rootDir, "config.yaml"), rootDir);
const clientDir = path.join(rootDir, "..", "Client");

// Un solo servidor HTTP sirve el cliente, la señalización y el WebSocket
// fallback. Render solo necesita publicar este puerto.
const httpServer = http.createServer(createStaticHandler(clientDir));
const communication = new Communication({ ...config, noServer: true });
const signalingHub = new SignalingHub({ room: config.peer.room });
const signaling = new SignalingServer({
  hub: signalingHub,
  access: config.access,
  room: config.peer.room,
  maxPayloadBytes: config.server.maxPayloadBytes,
  maxMessagesPerSecond: config.limits.maxMessagesPerSecond,
});
let peerServer = null;
let shuttingDown = false;

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, "http://localhost").pathname;

  if (pathname === "/signal") {
    signaling.handleUpgrade(request, socket, head);
    return;
  }

  if (pathname === "/board" || pathname === "/") {
    communication.handleUpgrade(request, socket, head);
    return;
  }

  socket.destroy();
});

function lanAddresses() {
  const addresses = new Set();

  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const info of interfaces ?? []) {
      if (info.family === "IPv4" && !info.internal) {
        addresses.add(info.address);
      }
    }
  }

  return [...addresses];
}

function logListening() {
  const { host, port } = config.server;
  console.log(`Servidor WebSocket escuchando en ws://${host}:${port}`);
  console.log(`Cliente web disponible en http://localhost:${port}`);

  for (const address of lanAddresses()) {
    console.log(`  En la red WiFi: http://${address}:${port}`);
  }

  console.log(
    `Modo de acceso: ${config.access.mode} | Persistencia: ${
      config.persistence.enabled ? config.persistence.file : "desactivada"
    }`,
  );
}

communication.server.on("error", (error) => {
  console.error("Error del servidor WebSocket:", error.message);
});

httpServer.listen(config.server.port, config.server.host, async () => {
  logListening();

  if (config.peer.transport === "ws") {
    console.log("[P2P] Desactivado por BOARD_TRANSPORT=ws; se usará WebSocket.");
    return;
  }

  try {
    const { Sender } = await loadP2P();
    peerServer = new PeerServer({
      hub: signalingHub,
      room: config.peer.room,
      iceServers: config.peer.iceServers,
      communication,
      Sender,
    });
    peerServer.start();
  } catch (error) {
    if (config.peer.transport === "p2p") {
      console.error("[P2P] No se pudo iniciar el transporte P2P:", error);
      process.exitCode = 1;
      return;
    }

    console.warn(`[P2P] No disponible; se usará WebSocket fallback: ${error.message}`);
  }
});

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`\n[Server] Cerrando por ${signal}...`);

  try {
    await peerServer?.close();
    await signaling.close();
    await communication.close();

    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections?.();
    });

    console.log("[Server] Servidor cerrado correctamente.");
    process.exitCode = 0;
  } catch (error) {
    console.error("[Server] Error al cerrar el servidor:", error.message);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("uncaughtException", (error) => {
  console.error("[Server] Excepción no controlada:", error);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error("[Server] Promesa rechazada sin manejar:", reason);
  shutdown("unhandledRejection");
});
