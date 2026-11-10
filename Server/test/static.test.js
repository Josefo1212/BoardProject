import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticHandler } from "../src/static.js";

const clientDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "Client",
);

async function startServer() {
  const server = http.createServer(createStaticHandler(clientDir));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

async function stopServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test("sirve index.html en la raíz", async () => {
  const { server, port } = await startServer();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(body, /Pizarra/);
  } finally {
    await stopServer(server);
  }
});

test("sirve módulos JavaScript con el tipo correcto", async () => {
  const { server, port } = await startServer();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/js/config.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
    assert.match(body, /SERVER_URL/);
  } finally {
    await stopServer(server);
  }
});

test("no sirve archivos fuera del directorio del cliente", async () => {
  const { server, port } = await startServer();

  try {
    const result = await new Promise((resolve, reject) => {
      // Socket crudo para enviar la ruta tal cual, sin normalizar los "..".
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /../Server/config.yaml HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${port}\r\n` +
            "Connection: close\r\n\r\n",
        );
      });

      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });

    assert.doesNotMatch(result, /server:\s*\n\s*host:/);
    assert.match(result, /^HTTP\/1\.1 (403|404)/);
  } finally {
    await stopServer(server);
  }
});

test("devuelve 404 para archivos inexistentes y 405 para métodos no permitidos", async () => {
  const { server, port } = await startServer();

  try {
    const missing = await fetch(`http://127.0.0.1:${port}/no-existe.js`);
    assert.equal(missing.status, 404);

    const post = await fetch(`http://127.0.0.1:${port}/index.html`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await stopServer(server);
  }
});
