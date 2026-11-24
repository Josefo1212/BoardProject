import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { WebSocket } from "ws";
import {
  SignalingHub,
  SignalingServer,
  normalizeNamespace,
  namespaceKey,
  toRoomSet,
} from "../src/signaling.js";

const ACCESS = { mode: "open", allowedOrigins: ["*"], allowedIps: ["127.0.0.1", "::1"] };

const startServer = async ({ rooms = ["pizarra", "pizarra-av"], room = "pizarra" } = {}) => {
  const hub = new SignalingHub({ room, rooms });
  const signaling = new SignalingServer({ hub, access: ACCESS, room, rooms });
  const server = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url, "http://localhost").pathname;

    if (pathname === "/signal") {
      signaling.handleUpgrade(request, socket, head);
      return;
    }

    socket.destroy();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    hub,
    signaling,
    server,
    port: server.address().port,
    async close() {
      await signaling.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

const connect = (port) => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal`);
    const messages = [];
    const waiters = [];

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const index = waiters.findIndex((waiter) => waiter.op === message.op);

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
        waitFor(op, timeout = 2_000) {
          const index = messages.findIndex((message) => message.op === op);

          if (index !== -1) {
            return Promise.resolve(messages.splice(index, 1)[0]);
          }

          return new Promise((resolveWait, rejectWait) => {
            const waiter = { op, resolve: resolveWait, timer: null };

            waiter.timer = setTimeout(() => {
              const waiterIndex = waiters.indexOf(waiter);

              if (waiterIndex !== -1) {
                waiters.splice(waiterIndex, 1);
              }

              rejectWait(new Error(`Timeout esperando el mensaje '${op}'.`));
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

test("toRoomSet normaliza salas", () => {
  assert.equal(toRoomSet(null), null);
  assert.equal(toRoomSet(undefined), null);
  assert.deepEqual([...toRoomSet("pizarra")], ["pizarra"]);
  assert.deepEqual([...toRoomSet(["pizarra", "pizarra-av"])], ["pizarra", "pizarra-av"]);
  assert.deepEqual([...toRoomSet(["pizarra", "", null])], ["pizarra"]);
  assert.deepEqual([...toRoomSet([])], []);
});

test("normalizeNamespace acepta la sala del tablero y la de videollamada", () => {
  const rooms = ["pizarra", "pizarra-av"];

  assert.deepEqual(normalizeNamespace(["sender", "pizarra"], rooms), ["sender", "pizarra"]);
  assert.deepEqual(normalizeNamespace(["receiver", "pizarra-av"], rooms), [
    "receiver",
    "pizarra-av",
  ]);
  assert.deepEqual(normalizeNamespace(["sender", "pizarra-av", "peer-1"], rooms), [
    "sender",
    "pizarra-av",
    "peer-1",
  ]);
});

test("normalizeNamespace rechaza salas fuera de la lista", () => {
  const rooms = ["pizarra", "pizarra-av"];

  assert.equal(normalizeNamespace(["sender", "otra-sala"], rooms), null);
  assert.equal(normalizeNamespace(["sender", "pizarra-av-extra"], rooms), null);
  assert.equal(normalizeNamespace(["sender", "../etc"], rooms), null);
  assert.equal(namespaceKey(["receiver", "intruso"], rooms), null);
});

test("normalizeNamespace sin allowlist acepta cualquier sala válida", () => {
  assert.deepEqual(normalizeNamespace(["sender", "cualquiera"]), ["sender", "cualquiera"]);
  assert.equal(normalizeNamespace(["sender", "sala con espacios"]), null);
});

test("el servidor acepta suscripciones a la sala de videollamada", async () => {
  const { port, close } = await startServer();
  const client = await connect(port);

  try {
    const welcome = await client.waitFor("welcome");
    assert.equal(welcome.room, "pizarra");

    client.send({ op: "subscribe", namespace: ["receiver", "pizarra-av"] });
    const subscribed = await client.waitFor("subscribed");
    assert.deepEqual(subscribed.namespace, ["receiver", "pizarra-av"]);

    client.send({ op: "subscribe", namespace: ["sender", "pizarra"] });
    const boardSubscribed = await client.waitFor("subscribed");
    assert.deepEqual(boardSubscribed.namespace, ["sender", "pizarra"]);
  } finally {
    await client.close();
    await close();
  }
});

test("el servidor rechaza salas no permitidas", async () => {
  const { port, close } = await startServer();
  const client = await connect(port);

  try {
    await client.waitFor("welcome");

    client.send({ op: "subscribe", namespace: ["receiver", "otra-sala"] });
    const error = await client.waitFor("error");
    assert.equal(error.code, "INVALID_NAMESPACE");

    client.send({ op: "publish", namespace: ["sender", "otra-sala"], message: { hello: true } });
    const publishError = await client.waitFor("error");
    assert.equal(publishError.code, "INVALID_NAMESPACE");
  } finally {
    await client.close();
    await close();
  }
});

test("reenvía mensajes de señalización entre clientes de la sala -av", async () => {
  const { port, close } = await startServer();
  const alice = await connect(port);
  const bob = await connect(port);

  try {
    await alice.waitFor("welcome");
    await bob.waitFor("welcome");

    alice.send({ op: "subscribe", namespace: ["sender", "pizarra-av"] });
    await alice.waitFor("subscribed");

    bob.send({ op: "subscribe", namespace: ["sender", "pizarra-av"] });
    await bob.waitFor("subscribed");

    alice.send({
      op: "publish",
      namespace: ["sender", "pizarra-av"],
      message: { type: "offer", sdp: "v=0" },
    });

    const relayed = await bob.waitFor("message");
    assert.deepEqual(relayed.namespace, ["sender", "pizarra-av"]);
    assert.equal(relayed.message.type, "offer");

    // El emisor no se reenvía a sí mismo.
    bob.send({
      op: "publish",
      namespace: ["sender", "pizarra-av"],
      message: { type: "answer" },
    });

    const answer = await alice.waitFor("message");
    assert.equal(answer.message.type, "answer");
  } finally {
    await alice.close();
    await bob.close();
    await close();
  }
});

test("el hub solo enruta las salas de la allowlist", () => {
  const hub = new SignalingHub({ room: "pizarra", rooms: ["pizarra", "pizarra-av"] });
  const received = [];

  hub.subscribe(["sender", "pizarra-av"], (message) => received.push(message));
  assert.equal(hub.publish(["sender", "pizarra-av"], { ok: true }), 1);
  assert.deepEqual(received, [{ ok: true }]);

  assert.equal(hub.publish(["sender", "otra-sala"], { ok: true }), 0);
  assert.throws(() => hub.subscribe(["sender", "otra-sala"], () => {}));
});
