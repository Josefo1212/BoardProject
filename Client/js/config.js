const params = new URLSearchParams(window.location.search);
const configuredServer = params.get("server")?.trim();
const pageHost = window.location.hostname;
const pagePort = window.location.port;
const pageProtocol = window.location.protocol;
const isHttpPage = pageProtocol === "http:" || pageProtocol === "https:";
const localHosts = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);
const isLocalPage = localHosts.has(pageHost.toLowerCase());

export const SERVER_HOST = "";

const wsProtocol = pageProtocol === "https:" ? "wss:" : "ws:";

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

const METERED_TURN_URL = "https://pizarra.metered.live/api/v1/turn/credentials";
const METERED_TURN_API_KEY = "39ad1d604a088f20f0d8ae675aecd624629a";

const TURN_SERVERS = [
  { urls: "turn:global.relay.metered.ca:80", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
  { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
  { urls: "turn:global.relay.metered.ca:443", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
  { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "7d2a705e0dd61740debf9aa6", credential: "vdHB01ZJrfou6YEO" },
];

const readTurnParam = (value) => {
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

const withUrlTurn = (servers) => {
  return [...servers, ...readTurnParam(params.get("turn")?.trim())];
}

const ICE_SERVERS = withUrlTurn([...BASE_ICE_SERVERS, ...TURN_SERVERS]);

export const loadIceServers = async () => {
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
