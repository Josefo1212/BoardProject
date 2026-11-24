const params = new URLSearchParams(window.location.search);
const configuredServer = params.get("server")?.trim();
const pageHost = window.location.hostname;
const pagePort = window.location.port;
const pageProtocol = window.location.protocol;
const isHttpPage = pageProtocol === "http:" || pageProtocol === "https:";
const localHosts = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);
const isLocalPage = localHosts.has(pageHost.toLowerCase());

// IP o nombre de la laptop que ejecuta el servidor WebSocket.
//
// Déjalo vacío ("") para detección automática. Es lo recomendado:
// - Si la página la sirve el propio servidor (http://IP_DEL_SERVIDOR:3005),
//   el cliente usa ese mismo host y funciona en cualquier red.
// - Si la página se sirve desde otra máquina (por ejemplo Live Server en
//   http://IP_DEL_SERVIDOR:5500), el cliente usa esa IP con el puerto 3005.
//
// Solo rellénalo si cada laptop abre su propio Live Server en 127.0.0.1
// y necesitas apuntar manualmente a la laptop del servidor, por ejemplo:
//   export const SERVER_HOST = "192.168.1.125";
//
// También puedes sobreescribirlo sin tocar código:
//   http://127.0.0.1:5500/?server=ws://IP_DEL_SERVIDOR:3005
export const SERVER_HOST = "";

const wsProtocol = pageProtocol === "https:" ? "wss:" : "ws:";

// Detección automática del servidor:
// - Servido por el propio servidor (mismo host y puerto, incluido Render).
// - Servido desde otra máquina de la red: apunta al puerto 3005 del host.
const autoHost = (() => {
  if (!isHttpPage) return "";
  if (pagePort === "3005" || pagePort === "") return window.location.host;
  if (!isLocalPage) return `${pageHost}:3005`;
  return "";
})();

const manualHost = SERVER_HOST.trim();
const host = manualHost ? `${manualHost}:3005` : autoHost;

export const SERVER_URL = configuredServer || (host ? `${wsProtocol}//${host}` : "");

export const SERVER_URL_HINT =
  "Abre la página desde la laptop del servidor (http://IP_DEL_SERVIDOR:3005) o agrega ?server=ws://IP_DEL_SERVIDOR:3005 a la URL.";

// Servidores ICE para WebRTC.
//
// STUN descubre la IP pública; TURN reenvía el vídeo cuando el P2P directo
// falla (NAT simétrico, datos móviles, VPN...). Usamos el TURN gratuito de
// Metered Open Relay. Las credenciales se renuevan al arrancar con
// loadIceServers(); debajo queda una copia estática como respaldo.
const METERED_TURN_URL = "https://pizarra.metered.live/api/v1/turn/credentials";
const METERED_TURN_API_KEY = "39ad1d604a088f20f0d8ae675aecd624629a";

export const TURN_SERVERS = [
  { urls: "turn:global.relay.metered.ca:80", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
  { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
  { urls: "turn:global.relay.metered.ca:443", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
  { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
];

function readTurnParam(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((server) => server && typeof server === "object" && server.urls);
    }
  } catch {
    // No es JSON: se interpreta como "url|usuario|clave".
  }

  const [urls, username, credential] = value.split("|").map((part) => part.trim());
  return urls ? [{ urls, username: username || undefined, credential: credential || undefined }] : [];
}

const BASE_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

function withUrlTurn(servers) {
  return [...servers, ...readTurnParam(params.get("turn")?.trim())];
}

export const ICE_SERVERS = withUrlTurn([...BASE_ICE_SERVERS, ...TURN_SERVERS]);

export async function loadIceServers() {
  try {
    const response = await fetch(METERED_TURN_URL + "?apiKey=" + encodeURIComponent(METERED_TURN_API_KEY));
    if (!response.ok) throw new Error("HTTP " + response.status);
    const servers = await response.json();
    if (!Array.isArray(servers) || !servers.some((server) => String(server?.urls || "").startsWith("turn"))) {
      throw new Error("Respuesta TURN inválida");
    }
    return withUrlTurn([...BASE_ICE_SERVERS, ...servers]);
  } catch (error) {
    console.warn("[ICE] No se pudieron renovar las credenciales TURN; se usa la configuración estática.", error);
    return ICE_SERVERS;
  }
}

export const STORAGE = {
  name: "pizarra.name.v1",
  color: "pizarra.color.v1",
  theme: "pizarra.theme.v1",
  recents: "pizarra.recents.v1",
  brush: "pizarra.brush.v1",
  eraser: "pizarra.eraser.v1",
};

export const PALETTE = [
  { hex: "#ff4d6d", name: "Coral" },
  { hex: "#ff7a45", name: "Naranja" },
  { hex: "#ffb703", name: "Amarillo" },
  { hex: "#9bdc28", name: "Lima" },
  { hex: "#2ec4b6", name: "Menta" },
  { hex: "#4cc9f0", name: "Celeste" },
  { hex: "#4361ee", name: "Azul" },
  { hex: "#7b2cbf", name: "Violeta" },
  { hex: "#ff6fb5", name: "Rosa" },
  { hex: "#e63946", name: "Rojo" },
  { hex: "#172033", name: "Tinta" },
  { hex: "#7b8092", name: "Gris" },
  { hex: "#a67c52", name: "Marrón" },
  { hex: "#ffffff", name: "Blanco" },
  { hex: "#fde2e4", name: "Rosa pastel" },
  { hex: "#d0f4de", name: "Verde pastel" },
  { hex: "#fff1b8", name: "Amarillo pastel" },
  { hex: "#d7e3ff", name: "Azul pastel" },
  { hex: "#c77dff", name: "Lavanda" },
  { hex: "#ffd166", name: "Dorado" },
];

export const TOOL_NAMES = {
  brush: "Pincel",
  eraser: "Borrador",
  fill: "Cubeta",
  line: "Línea",
  rect: "Rectángulo",
  circle: "Círculo",
};

export const MIN_WIDTH = 1;
export const MAX_WIDTH = 80;
export const REFERENCE_WIDTH = 900;
export const POINT_PRECISION = 5;
export const POINT_BATCH_MS = 55;
export const POINT_BATCH_MAX = 32;
export const CURSOR_THROTTLE_MS = 80;
