import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { Communication } from "./communication.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const configPath = path.join(__dirname, "..", "config.yaml");
const config = yaml.load(fs.readFileSync(configPath, "utf8"));

if (!config?.server) {
  throw new Error("La configuración debe incluir la sección 'server'.");
}

const { host } = config.server;
const port = Number(config.server.port);

if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("La configuración de host o puerto no es válida.");
}

const communication = new Communication({
  host,
  port,
  allowedClients: Array.isArray(config.clients) ? config.clients : [],
});

communication.server.on("listening", () => {
  console.log(`Servidor WebSocket escuchando en ws://${host}:${port}`);
});

communication.server.on("error", (error) => {
  console.error("Error del servidor WebSocket:", error.message);
});
