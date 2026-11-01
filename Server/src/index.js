import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Communication } from "./communication.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..");
const config = loadConfig(path.join(rootDir, "config.yaml"), rootDir);

const communication = new Communication(config);
let shuttingDown = false;

communication.server.on("listening", () => {
  const { host, port } = config.server;
  console.log(`Servidor WebSocket escuchando en ws://${host}:${port}`);
  console.log(
    `Modo de acceso: ${config.access.mode} | Persistencia: ${
      config.persistence.enabled ? config.persistence.file : "desactivada"
    }`,
  );
});

communication.server.on("error", (error) => {
  console.error("Error del servidor WebSocket:", error.message);
});

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`\n[Server] Cerrando por ${signal}...`);

  try {
    await communication.close();
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
