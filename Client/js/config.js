const params = new URLSearchParams(window.location.search);
const configuredServer = params.get("server")?.trim();
const pageHost = window.location.hostname;
const localHosts = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);
const isLocalPage = localHosts.has(pageHost.toLowerCase());

// IP o nombre de la laptop que ejecuta el servidor WebSocket (pnpm start).
//
// Modo elegido: cada laptop abre su propio Live Server (http://127.0.0.1:5500),
// por eso el navegador no puede deducir la IP del servidor y hay que ponerla
// aqui. Solo se cambia esta linea cuando cambie la IP de la laptop servidor.
//
// Si la pagina se abre desde la laptop del servidor (http://IP_DEL_SERVIDOR:5500)
// puedes dejar esto vacio y se usara el host de la pagina automaticamente.
//
// Ver la IP del servidor:  ip -brief addr  (Linux)  |  ipconfig  (Windows)
// Sobreescribir sin tocar codigo:
//   http://127.0.0.1:5500/?server=ws://IP_DEL_SERVIDOR:3005
export const SERVER_HOST = "10.150.169.177";

// Si la pagina corre en el propio localhost de cada laptop no sirve como
// referencia: sin SERVER_HOST no hay a donde conectarse.
const host = SERVER_HOST.trim() || (isLocalPage ? "" : pageHost);

export const SERVER_URL = configuredServer || (host ? `ws://${host}:3005` : "");

export const SERVER_URL_HINT =
  "Edita SERVER_HOST en Client/js/config.js con la IP de la laptop del servidor, o agrega ?server=ws://IP_DEL_SERVIDOR:3005 a la URL.";

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
