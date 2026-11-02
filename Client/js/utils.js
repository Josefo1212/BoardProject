export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const safeParse = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const storageGet = (key, fallback = null) => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
};

export const storageSet = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // La aplicación continúa aunque el almacenamiento no esté disponible.
  }
};

export const isHexColor = (value) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export const normalizeHex = (value) => {
  if (typeof value !== "string") return null;
  let hex = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    hex = `#${hex.slice(1).split("").map((char) => char + char).join("")}`;
  }
  return isHexColor(hex) ? hex.toLowerCase() : null;
};

export const hexToRgb = (hex) => {
  const safe = normalizeHex(hex) || "#000000";
  return {
    r: parseInt(safe.slice(1, 3), 16),
    g: parseInt(safe.slice(3, 5), 16),
    b: parseInt(safe.slice(5, 7), 16),
  };
};

export const isLightColor = (hex) => {
  const { r, g, b } = hexToRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 168;
};

export const shortId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const cloneStroke = (stroke) => ({
  strokeId: stroke.strokeId,
  points: stroke.points.map((point) => ({ ...point })),
  style: { ...stroke.style },
  authorId: stroke.authorId,
  complete: stroke.complete !== false,
});

export const debounce = (fn, wait) => {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};
