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

const autoHost = (() => {
  if (!isHttpPage) return "";
  // Servido por el propio servidor de la pizarra: mismo host y puerto.
  // En Render, el proxy publica el servicio en HTTPS/WSS sin exponer el
  // puerto interno asignado mediante PORT.
  if (pagePort === "3005" || pagePort === "") return `${window.location.host}/board`;
  // Servido desde otra máquina de la red: apunta al puerto del WebSocket.
  if (!isLocalPage) return `${pageHost}:3005/board`;
  return "";
})();

const manualHost = SERVER_HOST.trim();
const host = manualHost ? `${manualHost}:3005/board` : autoHost;

export const SERVER_URL = configuredServer || (host ? `${wsProtocol}//${host}` : "");

export const SERVER_URL_HINT =
  "Abre la página desde la laptop del servidor (http://IP_DEL_SERVIDOR:3005) o agrega ?server=ws://IP_DEL_SERVIDOR:3005 a la URL.";

export const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

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
