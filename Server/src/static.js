import fs from "node:fs";
import path from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function sendText(response, status, message, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  response.end(message);
}

/**
 * Sirve los archivos estáticos del cliente (HTML, JS, CSS, fuentes...).
 * Se usa como handler del mismo servidor HTTP al que se engancha el
 * WebSocket, de modo que un solo comando expone la app completa.
 */
export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return async function handleRequest(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "Método no permitido", { Allow: "GET, HEAD" });
      return;
    }

    let pathname;

    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      sendText(response, 400, "Solicitud inválida");
      return;
    }

    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    const filePath = path.resolve(root, "." + pathname);

    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      sendText(response, 403, "Prohibido");
      return;
    }

    let stats;

    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      stats = null;
    }

    if (!stats || !stats.isFile()) {
      sendText(response, 404, "No encontrado");
      return;
    }

    const contentType =
      MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";

    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "no-cache",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };
}
