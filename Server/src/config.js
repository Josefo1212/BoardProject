import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const DEFAULTS = {
  server: {
    host: "0.0.0.0",
    port: 3005,
    maxClients: 100,
    pingIntervalMs: 30_000,
    maxPayloadBytes: 256 * 1024,
    maxBufferedBytes: 8 * 1024 * 1024,
  },
  access: {
    mode: "open",
    allowedOrigins: ["*"],
    allowedIps: [],
  },
  limits: {
    maxStrokes: 5_000,
    maxPointsPerStroke: 10_000,
    maxTotalPoints: 2_000_000,
    maxMessagesPerSecond: 500,
  },
  persistence: {
    enabled: false,
    file: "data/board.json",
    debounceMs: 500,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value, fallback, name, { allowEmpty = false } = {}) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`La configuración de '${name}' debe ser un texto válido.`);
  }

  return value.trim();
}

function readNumber(value, fallback, name, { min, max, integer = false }) {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`La configuración de '${name}' debe ser un número.`);
  }

  if (integer && !Number.isInteger(value)) {
    throw new Error(`La configuración de '${name}' debe ser un número entero.`);
  }

  if (value < min || value > max) {
    throw new Error(`La configuración de '${name}' debe estar entre ${min} y ${max}.`);
  }

  return value;
}

function readStringList(value, fallback, name) {
  if (value === undefined) {
    return [...fallback];
  }

  if (!Array.isArray(value)) {
    throw new Error(`La configuración de '${name}' debe ser una lista.`);
  }

  const items = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");

  return items.length > 0 ? items : [...fallback];
}

export function loadConfig(configPath, rootDir) {
  let raw;

  try {
    raw = yaml.load(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`No se pudo leer la configuración (${configPath}): ${error.message}`);
  }

  if (!isPlainObject(raw)) {
    throw new Error("La configuración debe ser un objeto YAML válido.");
  }

  const rawServer = isPlainObject(raw.server) ? raw.server : {};
  const rawAccess = isPlainObject(raw.access) ? raw.access : {};
  const rawLimits = isPlainObject(raw.limits) ? raw.limits : {};
  const rawPersistence = isPlainObject(raw.persistence) ? raw.persistence : {};

  const legacyClients = Array.isArray(raw.clients) ? raw.clients : [];
  const legacyIps = legacyClients
    .map((client) => (isPlainObject(client) ? client.ip : null))
    .filter((ip) => typeof ip === "string" && ip.trim() !== "")
    .map((ip) => ip.trim());

  const mode = readString(
    rawAccess.mode,
    legacyIps.length > 0 ? "allowlist" : "open",
    "access.mode",
  );

  if (mode !== "open" && mode !== "allowlist") {
    throw new Error("La configuración de 'access.mode' debe ser 'open' o 'allowlist'.");
  }

  const configuredIps = Array.isArray(rawAccess.allowedIps) ? rawAccess.allowedIps : [];
  const allowedIps = [
    ...legacyIps,
    ...configuredIps.filter((ip) => typeof ip === "string" && ip.trim() !== "").map((ip) => ip.trim()),
    "127.0.0.1",
    "::1",
  ];

  const persistenceFile = readString(
    rawPersistence.file,
    DEFAULTS.persistence.file,
    "persistence.file",
  );

  const server = {
    host: readString(rawServer.host, DEFAULTS.server.host, "server.host"),
    port: readNumber(rawServer.port, DEFAULTS.server.port, "server.port", {
      min: 1,
      max: 65_535,
      integer: true,
    }),
    maxClients: readNumber(rawServer.maxClients, DEFAULTS.server.maxClients, "server.maxClients", {
      min: 1,
      max: 10_000,
      integer: true,
    }),
    pingIntervalMs: readNumber(
      rawServer.pingIntervalMs,
      DEFAULTS.server.pingIntervalMs,
      "server.pingIntervalMs",
      { min: 0, max: 600_000, integer: true },
    ),
    maxPayloadBytes: readNumber(
      rawServer.maxPayloadBytes,
      DEFAULTS.server.maxPayloadBytes,
      "server.maxPayloadBytes",
      { min: 1_024, max: 16 * 1024 * 1024, integer: true },
    ),
    maxBufferedBytes: readNumber(
      rawServer.maxBufferedBytes,
      DEFAULTS.server.maxBufferedBytes,
      "server.maxBufferedBytes",
      { min: 1_024, max: 128 * 1024 * 1024, integer: true },
    ),
  };

  const access = {
    mode,
    allowedOrigins: readStringList(
      rawAccess.allowedOrigins,
      DEFAULTS.access.allowedOrigins,
      "access.allowedOrigins",
    ),
    allowedIps,
  };

  const limits = {
    maxStrokes: readNumber(rawLimits.maxStrokes, DEFAULTS.limits.maxStrokes, "limits.maxStrokes", {
      min: 1,
      max: 1_000_000,
      integer: true,
    }),
    maxPointsPerStroke: readNumber(
      rawLimits.maxPointsPerStroke,
      DEFAULTS.limits.maxPointsPerStroke,
      "limits.maxPointsPerStroke",
      { min: 1, max: 1_000_000, integer: true },
    ),
    maxTotalPoints: readNumber(
      rawLimits.maxTotalPoints,
      DEFAULTS.limits.maxTotalPoints,
      "limits.maxTotalPoints",
      { min: 1, max: 50_000_000, integer: true },
    ),
    maxMessagesPerSecond: readNumber(
      rawLimits.maxMessagesPerSecond,
      DEFAULTS.limits.maxMessagesPerSecond,
      "limits.maxMessagesPerSecond",
      { min: 1, max: 100_000, integer: true },
    ),
  };

  const persistence = {
    enabled:
      rawPersistence.enabled === undefined
        ? DEFAULTS.persistence.enabled
        : Boolean(rawPersistence.enabled),
    file: path.isAbsolute(persistenceFile)
      ? persistenceFile
      : path.resolve(rootDir, persistenceFile),
    debounceMs: readNumber(
      rawPersistence.debounceMs,
      DEFAULTS.persistence.debounceMs,
      "persistence.debounceMs",
      { min: 0, max: 60_000, integer: true },
    ),
  };

  return { server, access, limits, persistence };
}
