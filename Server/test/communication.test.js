import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Communication } from "../src/communication.js";

function makeConfig(overrides = {}) {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      maxClients: 20,
      pingIntervalMs: 0,
      maxPayloadBytes: 256 * 1024,
      maxBufferedBytes: 8 * 1024 * 1024,
      ...overrides.server,
    },
    access: {
      mode: "open",
      allowedOrigins: ["*"],
      allowedIps: ["127.0.0.1", "::1"],
      ...overrides.access,
    },
    limits: {
      maxStrokes: 1_000,
      maxPointsPerStroke: 10_000,
      maxTotalPoints: 100_000,
      maxMessagesPerSecond: 1_000,
      ...overrides.limits,
    },
    persistence: {
      enabled: false,
      file: "",
      debounceMs: 0,
      ...overrides.persistence,
    },
  };
}

async function startServer(overrides) {
  const communication = new Communication(makeConfig(overrides));
  await once(communication.server, "listening");
  const { port } = communication.server.address();
  return { communication, port };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    const waiters = [];

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const index = waiters.findIndex((waiter) => waiter.type === message.type);

      if (index !== -1) {
        const [waiter] = waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }

      messages.push(message);
    });

    ws.on("error", reject);

    ws.once("open", () => {
      resolve({
        ws,
        send(message) {
          ws.send(JSON.stringify(message));
        },
        waitFor(type, timeout = 2_000) {
          const index = messages.findIndex((message) => message.type === type);

          if (index !== -1) {
            return Promise.resolve(messages.splice(index, 1)[0]);
          }

          return new Promise((resolveWait, rejectWait) => {
            const waiter = {
              type,
              resolve: resolveWait,
              timer: null,
            };

            waiter.timer = setTimeout(() => {
              const waiterIndex = waiters.indexOf(waiter);

              if (waiterIndex !== -1) {
                waiters.splice(waiterIndex, 1);
              }

              rejectWait(new Error(`Timeout esperando el mensaje '${type}'.`));
            }, timeout);

            waiter.timer.unref();
            waiters.push(waiter);
          });
        },
        close() {
          return new Promise((resolveClose) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolveClose();
              return;
            }

            ws.once("close", resolveClose);
            ws.close();
          });
        },
      });
    });
  });
}

test("difunde trazos completos y limpia la pizarra", async () => {
  const { communication, port } = await startServer();
  const alice = await connect(port);
  const aliceSnapshot = await alice.waitFor("snapshot");
  const bob = await connect(port);
  const bobSnapshot = await bob.waitFor("snapshot");

  assert.deepEqual(aliceSnapshot.strokes, []);
  assert.deepEqual(bobSnapshot.strokes, []);
  assert.equal(typeof aliceSnapshot.clientId, "string");

  const stroke = {
    type: "stroke",
    strokeId: "stroke-1",
    points: [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ],
    style: { color: "#172033", width: 3 },
  };

  alice.send(stroke);
  const receivedStroke = await bob.waitFor("stroke");

  assert.equal(receivedStroke.strokeId, "stroke-1");
  assert.equal(receivedStroke.points.length, 2);
  assert.equal(receivedStroke.authorId, aliceSnapshot.clientId);

  alice.send({ type: "clear" });
  const receivedClear = await bob.waitFor("clear");

  assert.equal(receivedClear.authorId, aliceSnapshot.clientId);

  await alice.close();
  await bob.close();
  await communication.close();
});

test("transmite trazos en vivo y los incluye en la instantánea", async () => {
  const { communication, port } = await startServer();
  const alice = await connect(port);
  const aliceSnapshot = await alice.waitFor("snapshot");
  const bob = await connect(port);
  await bob.waitFor("snapshot");

  alice.send({
    type: "stroke-start",
    strokeId: "live-1",
    point: { x: 0.05, y: 0.05 },
    style: { color: "#ff0000", width: 5 },
  });

  const started = await bob.waitFor("stroke-start");
  assert.equal(started.strokeId, "live-1");
  assert.equal(started.authorId, aliceSnapshot.clientId);
  assert.deepEqual(started.point, { x: 0.05, y: 0.05 });

  alice.send({
    type: "stroke-points",
    strokeId: "live-1",
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
    ],
  });

  const morePoints = await bob.waitFor("stroke-points");
  assert.equal(morePoints.points.length, 2);

  alice.send({
    type: "stroke-end",
    strokeId: "live-1",
    points: [{ x: 0.3, y: 0.3 }],
  });

  const ended = await bob.waitFor("stroke-end");
  assert.equal(ended.strokeId, "live-1");
  assert.equal(ended.points.length, 1);

  const carol = await connect(port);
  const carolSnapshot = await carol.waitFor("snapshot");
  const savedStroke = carolSnapshot.strokes.find((stroke) => stroke.strokeId === "live-1");

  assert.ok(savedStroke);
  assert.equal(savedStroke.complete, true);
  assert.deepEqual(
    savedStroke.points.map((point) => [point.x, point.y]),
    [
      [0.05, 0.05],
      [0.1, 0.1],
      [0.2, 0.2],
      [0.3, 0.3],
    ],
  );

  await alice.close();
  await bob.close();
  await carol.close();
  await communication.close();
});

test("rechaza coordenadas inválidas sin modificar la pizarra", async () => {
  const { communication, port } = await startServer();
  const alice = await connect(port);
  await alice.waitFor("snapshot");

  alice.send({
    type: "stroke",
    strokeId: "invalid-1",
    points: [{ x: 2, y: 0.5 }],
  });

  const error = await alice.waitFor("error");
  assert.equal(error.code, "INVALID_POINT");
  assert.equal(communication.strokeCount, 0);

  await alice.close();
  await communication.close();
});

test("responde ping con pong", async () => {
  const { communication, port } = await startServer();
  const alice = await connect(port);
  await alice.waitFor("snapshot");

  alice.send({ type: "ping" });
  const pong = await alice.waitFor("pong");

  assert.equal(typeof pong.timestamp, "number");

  await alice.close();
  await communication.close();
});

test("bloquea clientes fuera de la lista cuando el modo es allowlist", async () => {
  const { communication, port } = await startServer({
    access: { mode: "allowlist", allowedOrigins: ["*"], allowedIps: [] },
  });
  const alice = await connect(port);

  const error = await alice.waitFor("error");
  assert.equal(error.code, "UNAUTHORIZED_CLIENT");

  await alice.close();
  await communication.close();
});

test("persiste la pizarra entre reinicios del servidor", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "board-persistence-"));
  const file = path.join(directory, "board.json");
  const options = { persistence: { enabled: true, file, debounceMs: 0 } };

  try {
    const first = await startServer(options);
    const alice = await connect(first.port);
    await alice.waitFor("snapshot");
    const bob = await connect(first.port);
    await bob.waitFor("snapshot");

    alice.send({
      type: "stroke",
      strokeId: "persisted-1",
      points: [
        { x: 0.5, y: 0.5 },
        { x: 0.6, y: 0.6 },
      ],
      style: { color: "#00aa00", width: 4 },
    });

    await bob.waitFor("stroke");

    await alice.close();
    await bob.close();
    await first.communication.close();

    assert.ok(fs.existsSync(file));

    const second = await startServer(options);
    const carol = await connect(second.port);
    const snapshot = await carol.waitFor("snapshot");
    const restored = snapshot.strokes.find((stroke) => stroke.strokeId === "persisted-1");

    assert.ok(restored);
    assert.equal(restored.points.length, 2);
    assert.equal(restored.complete, true);

    await carol.close();
    await second.communication.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
