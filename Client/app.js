    import { Board } from "./js/Board.js";
    import { Communication } from "./js/Communication.js";
    import { $$, els } from "./js/dom.js";
    import { state } from "./js/state.js";
    import {
      CURSOR_THROTTLE_MS,
      ICE_SERVERS,
      MAX_WIDTH,
      MIN_WIDTH,
      PALETTE,
      POINT_BATCH_MAX,
      POINT_BATCH_MS,
      REFERENCE_WIDTH,
      SERVER_URL,
      SERVER_URL_HINT,
      STORAGE,
      TOOL_NAMES,
    } from "./js/config.js";
    import {
      clamp,
      cloneStroke,
      debounce,
      hexToRgb,
      isLightColor,
      normalizeHex,
      safeParse,
      shortId,
      storageGet,
      storageSet,
    } from "./js/utils.js";

    "use strict";

    (() => {
      const board = new Board({ base: els.base, overlay: els.overlay });
      const baseCtx = board.baseContext;
      const liveCtx = board.overlayContext;
      const communication = new Communication({ iceServers: ICE_SERVERS });

      const roundPoint = (value) => Number(value.toFixed(5));

      const saveNameLater = debounce(() => storageSet(STORAGE.name, state.userName), 350);
      const announceNameLater = debounce(() => sendHello(), 500);

      const readStoredPreferences = () => {
        const storedName = storageGet(STORAGE.name, "");
        const storedColor = storageGet(STORAGE.color, "");
        const storedTheme = storageGet(STORAGE.theme, "");
        const storedRecents = safeParse(storageGet(STORAGE.recents, "[]"), []);
        const storedBrush = Number(storageGet(STORAGE.brush, "6"));
        const storedEraser = Number(storageGet(STORAGE.eraser, "30"));

        state.userName = (typeof storedName === "string" && storedName.trim()).slice(0, 20) || "Artista";
        state.color = normalizeHex(storedColor) || "#6c5ce7";
        state.brushWidth = clamp(Number.isFinite(storedBrush) ? storedBrush : 6, MIN_WIDTH, MAX_WIDTH);
        state.eraserWidth = clamp(Number.isFinite(storedEraser) ? storedEraser : 30, MIN_WIDTH, MAX_WIDTH);

        state.recentColors = Array.isArray(storedRecents)
          ? storedRecents.map(normalizeHex).filter(Boolean).slice(0, 6)
          : [];

        if (storedTheme === "dark" || storedTheme === "light") {
          state.theme = storedTheme;
        } else {
          state.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
      }

      const saveToolWidths = () => {
        storageSet(STORAGE.brush, String(Math.round(state.brushWidth)));
        storageSet(STORAGE.eraser, String(Math.round(state.eraserWidth)));
      }

      const rememberColor = (hex) => {
        const safe = normalizeHex(hex);
        if (!safe) return;
        state.recentColors = [safe, ...state.recentColors.filter((color) => color !== safe)].slice(0, 6);
        storageSet(STORAGE.recents, JSON.stringify(state.recentColors));
        renderRecentColors();
      }

      const applyTheme = (theme, persist = true) => {
        state.theme = theme === "dark" ? "dark" : "light";
        els.root.dataset.theme = state.theme;
        els.themeToggle.setAttribute(
          "aria-label",
          state.theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro",
        );
        if (els.metaTheme) {
          els.metaTheme.setAttribute("content", state.theme === "dark" ? "#17122f" : "#fff7f1");
        }
        if (persist) storageSet(STORAGE.theme, state.theme);
      }

      const toggleTheme = () => {
        applyTheme(state.theme === "dark" ? "light" : "dark");
      }

      const renderPalette = () => {
        els.palette.innerHTML = "";
        PALETTE.forEach((color, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "swatch" + (isLightColor(color.hex) ? " is-light" : "");
          button.style.setProperty("--swatch", color.hex);
          button.dataset.color = color.hex;
          button.setAttribute("aria-label", `${color.name}${index < 9 ? `, atajo ${index + 1}` : ""}`);
          button.setAttribute("aria-pressed", "false");
          button.title = `${color.name}${index < 9 ? ` · ${index + 1}` : ""}`;
          button.addEventListener("click", () => selectColor(color.hex));
          els.palette.appendChild(button);
        });
      }

      const renderRecentColors = () => {
        els.recentColors.innerHTML = "";
        if (!state.recentColors.length) return;

        const label = document.createElement("span");
        label.className = "recent-label";
        label.textContent = "Recientes";
        els.recentColors.appendChild(label);

        state.recentColors.forEach((hex, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "swatch recent" + (isLightColor(hex) ? " is-light" : "");
          button.style.setProperty("--swatch", hex);
          button.dataset.color = hex;
          button.setAttribute("aria-label", `Color reciente ${index + 1}`);
          button.setAttribute("aria-pressed", "false");
          button.title = `Reciente ${index + 1}`;
          button.addEventListener("click", () => selectColor(hex));
          els.recentColors.appendChild(button);
        });
      }

      const selectColor = (hex, { remember = true } = {}) => {
        const safe = normalizeHex(hex);
        if (!safe) return;

        state.color = safe;
        storageSet(STORAGE.color, safe);

        if (state.tool === "eraser") {
          setTool("brush");
        }

        if (remember) {
          rememberColor(safe);
        }

        syncColorUI();
        updateCursorAppearance();

        if (connected() && hasFeature("names")) {
          announceNameLater();
        }
      }

      const syncColorUI = () => {
        const light = isLightColor(state.color);

        $$(".swatch").forEach((swatch) => {
          const active = (swatch.dataset.color || "").toLowerCase() === state.color;
          swatch.classList.toggle("is-active", active);
          swatch.setAttribute("aria-pressed", active ? "true" : "false");
        });

        els.currentColorDot.style.background = state.color;
        els.customColor.value = state.color;
        els.userAvatar.style.background = state.color;
        els.userAvatar.style.color = light ? "#2b2444" : "#ffffff";
        updateSizeUI();
      }

      const setTool = (tool) => {
        if (!TOOL_NAMES[tool]) return;

        state.tool = tool;
        els.toolButtons.forEach((button) => {
          const active = button.dataset.tool === tool;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-pressed", active ? "true" : "false");
        });

        els.sizeSlider.disabled = tool === "fill";
        els.sizeSliderMobile.disabled = tool === "fill";
        updateSizeUI();
        updateCursorAppearance();
        closeMobileColorPanel();
        closeSizePopover();

        const activeButton = els.toolButtons.find((button) => button.dataset.tool === tool);
        if (activeButton) {
          activeButton.animate(
            [
              { transform: "scale(1)" },
              { transform: "scale(1.16) rotate(-3deg)" },
              { transform: "scale(1)" },
            ],
            { duration: 280, easing: "cubic-bezier(.34,1.56,.64,1)" },
          );
        }
      }

      const activeWidth = () => {
        return state.tool === "eraser" ? state.eraserWidth : state.brushWidth;
      }

      const renderedWidth = (width) => {
        return Math.max(0.5, width * (state.viewW / REFERENCE_WIDTH));
      }

      const setSize = (value, { save = true } = {}) => {
        const width = clamp(Math.round(Number(value) || MIN_WIDTH), MIN_WIDTH, MAX_WIDTH);
        if (state.tool === "eraser") {
          state.eraserWidth = width;
        } else {
          state.brushWidth = width;
        }
        if (save) saveToolWidths();
        updateSizeUI();
        updateCursorAppearance();
      }

      const updateSizeUI = () => {
        const width = activeWidth();
        els.sizeSlider.value = String(width);
        els.sizeSliderMobile.value = String(width);
        els.sizeValue.textContent = String(width);
        els.sizePopoverValue.textContent = `${width} px`;

        const display = clamp(width, 4, 34);
        [els.sizeDot, els.sizeDotMobile, els.sizeDotPopover].forEach((dot) => {
          dot.style.width = `${display}px`;
          dot.style.height = `${display}px`;
          dot.style.background = state.tool === "eraser" ? "#9b95b3" : state.color;
        });

        const disabled = state.tool === "fill";
        els.sizeSlider.disabled = disabled;
        els.sizeSliderMobile.disabled = disabled;
      }

      const connected = () => {
        const socket = communication.socket;
        return state.status === "connected" && socket && socket.readyState === WebSocket.OPEN;
      }

      const hasFeature = (name) => {
        return state.serverFeatures.has(name);
      }

      const updateUserIdentityUI = () => {
        const name = state.userName.trim() || "Artista";
        const initial = Array.from(name)[0] || "A";
        els.userAvatar.textContent = initial.toUpperCase();
        if (document.activeElement !== els.userName) {
          els.userName.value = name;
        }
        els.userAvatar.style.background = state.color;
        els.userAvatar.style.color = isLightColor(state.color) ? "#2b2444" : "#ffffff";
        document.title = `Pizarra · ${name}`;
      }

      const layoutBoard = () => {
        const rect = els.boardHolder.getBoundingClientRect();
        const styles = getComputedStyle(els.root);
        const pad = parseFloat(styles.getPropertyValue("--frame-pad")) || 11;
        const maxCanvasWidth = 1180;

        if (rect.width < 10 || rect.height < 10) return;

        const availableW = Math.max(160, rect.width - pad * 2);
        const availableH = Math.max(120, rect.height - pad * 2);
        let innerW = Math.min(availableW, availableH * (4 / 3), maxCanvasWidth);
        innerW = Math.max(180, innerW);
        const innerH = innerW * (3 / 4);

        els.boardFrame.style.width = `${Math.round(innerW + pad * 2)}px`;
        els.boardFrame.style.height = `${Math.round(innerH + pad * 2)}px`;
      }

      const scheduleLayout = () => {
        cancelAnimationFrame(state.layoutRaf);
        state.layoutRaf = requestAnimationFrame(() => {
          layoutBoard();
          resizeCanvases();
        });
      }

      let resizeCanvases = () => {};

      const remoteCursorEls = new Map();

      resizeCanvases = () => {
        const rect = els.canvasShell.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixelW = Math.max(1, Math.round(rect.width * dpr));
        const pixelH = Math.max(1, Math.round(rect.height * dpr));

        state.viewW = rect.width;
        state.viewH = rect.height;
        state.dpr = dpr;
        board.resize(pixelW, pixelH, dpr);

        redrawBase();
        redrawLive();
        updateCursorAppearance();
      };

      const parseStyle = (style) => {
        const raw = String(style?.color || "#172033").trim();
        const info = { type: "brush", color: raw, shape: "", eraser: false };

        if (raw === "eraser") {
          info.type = "eraser";
          info.eraser = true;
          info.color = "#000000";
          return info;
        }

        if (raw.startsWith("cmd:undo:")) {
          info.type = "command";
          return info;
        }

        if (raw.startsWith("fill:")) {
          info.type = "fill";
          info.color = normalizeHex(raw.slice(5)) || "#6c5ce7";
          return info;
        }

        if (raw.startsWith("shapeL:") || raw.startsWith("shapeR:") || raw.startsWith("shapeC:")) {
          info.type = "shape";
          info.shape = raw[5];
          info.color = normalizeHex(raw.slice(7)) || "#6c5ce7";
          return info;
        }

        info.color = normalizeHex(raw) || raw || "#172033";
        return info;
      }

      const normalizePoint = (point) => {
        if (!point || typeof point !== "object") return null;
        const x = Number(point.x);
        const y = Number(point.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

        const out = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
        if (Number.isFinite(point.pressure)) {
          out.pressure = clamp(Number(point.pressure), 0, 1);
        }
        return out;
      }

      const normalizeStyle = (style) => {
        const out = {};
        if (style && typeof style === "object") {
          if (typeof style.color === "string" && style.color.trim()) {
            out.color = style.color.trim().slice(0, 64);
          }
          if (Number.isFinite(style.width)) {
            out.width = clamp(Number(style.width), 0.5, 100);
          }
          if (Number.isFinite(style.opacity)) {
            out.opacity = clamp(Number(style.opacity), 0, 1);
          }
        }
        if (!out.color) out.color = "#172033";
        if (!Number.isFinite(out.width)) out.width = 3;
        return out;
      }

      const styleWidth = (style) => {
        return renderedWidth(clamp(Number(style?.width) || 3, 0.5, 100));
      }

      const pressureFactor = (point) => {
        return Number.isFinite(point?.pressure) ? 0.5 + clamp(point.pressure, 0, 1) * 0.9 : 1;
      }

      const midpoint = (a, b) => {
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }

      const drawStroke = (ctx, stroke, pointsOverride = null) => {
        const points = pointsOverride || stroke?.points;
        if (!Array.isArray(points) || points.length === 0) return;

        const style = normalizeStyle(stroke?.style);
        const info = parseStyle(style);
        if (info.type === "fill" || info.type === "command") return;

        const pts = points.map((point) => ({
          x: clamp(point.x, 0, 1) * state.viewW,
          y: clamp(point.y, 0, 1) * state.viewH,
          pressure: point.pressure,
        }));

        const baseWidth = styleWidth(style);
        if (baseWidth <= 0.05) return;

        ctx.save();
        ctx.globalCompositeOperation = info.eraser ? "destination-out" : "source-over";
        ctx.globalAlpha = clamp(Number(style.opacity ?? 1), 0, 1);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = info.eraser ? "#000000" : info.color;
        ctx.fillStyle = info.eraser ? "#000000" : info.color;

        if (info.type === "shape") {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i += 1) {
            ctx.lineTo(pts[i].x, pts[i].y);
          }
          if (info.shape === "R" || info.shape === "C") ctx.closePath();
          ctx.lineWidth = baseWidth;
          ctx.stroke();
          ctx.restore();
          return;
        }

        if (pts.length === 1) {
          const radius = Math.max(0.35, (baseWidth * pressureFactor(points[0])) / 2);
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          return;
        }

        const hasPressure = points.some((point) => Number.isFinite(point.pressure));

        if (!hasPressure) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          if (pts.length === 2) {
            ctx.lineTo(pts[1].x, pts[1].y);
          } else {
            for (let i = 1; i < pts.length - 1; i += 1) {
              const control = pts[i];
              const end = midpoint(pts[i], pts[i + 1]);
              ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
            }
            const penultimate = pts[pts.length - 2];
            const last = pts[pts.length - 1];
            ctx.quadraticCurveTo(penultimate.x, penultimate.y, last.x, last.y);
          }
          ctx.lineWidth = baseWidth;
          ctx.stroke();
        } else {
          for (let i = 1; i < pts.length; i += 1) {
            const start = i === 1 ? pts[0] : midpoint(pts[i - 2], pts[i - 1]);
            const control = pts[i - 1];
            const end = i === pts.length - 1 ? pts[i] : midpoint(pts[i - 1], pts[i]);
            const factor = pressureFactor(points[i - 1]);
            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
            ctx.lineWidth = Math.max(0.35, baseWidth * factor);
            ctx.stroke();
          }
        }

        ctx.restore();
      }

      const redrawBase = () => {
        if (state.viewW < 2 || state.viewH < 2) return;
        baseCtx.clearRect(0, 0, state.viewW, state.viewH);

        for (const stroke of state.strokes.values()) {
          renderStrokeToBase(stroke);
        }
      }

      const redrawLive = () => {
        if (state.viewW < 2 || state.viewH < 2) return;
        liveCtx.clearRect(0, 0, state.viewW, state.viewH);

        for (const active of state.active.values()) {
          const info = parseStyle(active.style);
          if (info.type === "eraser" || info.type === "fill" || info.type === "command") continue;
          drawStroke(liveCtx, active);
        }

        if (state.localActive) {
          const local = state.localActive;
          const info = parseStyle(local.style);
          if (info.type !== "eraser" && info.type !== "fill" && info.type !== "command") {
            const points = local.preview || local.points;
            drawStroke(liveCtx, { ...local, points }, points);
          }
        }
      }

      const requestBaseRedraw = () => {
        if (state.baseRaf) return;
        state.baseRaf = requestAnimationFrame(() => {
          state.baseRaf = 0;
          redrawBase();
        });
      }

      const requestLiveRedraw = () => {
        if (state.liveRaf) return;
        state.liveRaf = requestAnimationFrame(() => {
          state.liveRaf = 0;
          redrawLive();
        });
      }

      const renderStrokeToBase = (stroke) => {
        const info = parseStyle(stroke?.style);
        if (info.type === "fill") {
          const point = stroke.points?.[0];
          if (point) floodFill(baseCtx, point.x, point.y, info.color);
          return;
        }
        if (info.type === "command") return;
        drawStroke(baseCtx, stroke);
      }

      const floodFill = (ctx, nx, ny, colorHex) => {
        const w = ctx.canvas.width;
        const h = ctx.canvas.height;
        if (!w || !h) return false;

        const seedX = clamp(Math.floor(nx * w), 0, w - 1);
        const seedY = clamp(Math.floor(ny * h), 0, h - 1);
        const image = ctx.getImageData(0, 0, w, h);
        const data = new Uint32Array(image.data.buffer);

        const fill = hexToRgb(colorHex);
        const tolerance = 46;
        const tolerance2 = tolerance * tolerance;

        const indexAt = (x, y) => y * w + x;

        const composite = (packed) => {
          const r = packed & 255;
          const g = (packed >>> 8) & 255;
          const b = (packed >>> 16) & 255;
          const a = (packed >>> 24) & 255;
          if (a === 255) return [r, g, b];
          const alpha = a / 255;
          return [
            Math.round(r * alpha + 255 * (1 - alpha)),
            Math.round(g * alpha + 255 * (1 - alpha)),
            Math.round(b * alpha + 255 * (1 - alpha)),
          ];
        };

        const seedPacked = data[indexAt(seedX, seedY)];
        const seed = composite(seedPacked);

        const seedDistance =
          (seed[0] - fill.r) ** 2 + (seed[1] - fill.g) ** 2 + (seed[2] - fill.b) ** 2;
        if (seedDistance <= 4) return false;

        const matches = (x, y) => {
          const packed = data[indexAt(x, y)];
          const [r, g, b] = composite(packed);
          return (r - seed[0]) ** 2 + (g - seed[1]) ** 2 + (b - seed[2]) ** 2 <= tolerance2;
        };

        const fillPacked =
          (255 << 24) | ((fill.b & 255) << 16) | ((fill.g & 255) << 8) | (fill.r & 255);
        const visited = new Uint8Array(w * h);
        const stack = [indexAt(seedX, seedY)];

        while (stack.length) {
          const index = stack.pop();
          if (visited[index]) continue;

          const y = Math.floor(index / w);
          const x = index - y * w;
          if (!matches(x, y)) continue;

          let left = x;
          let right = x;
          while (left > 0 && !visited[indexAt(left - 1, y)] && matches(left - 1, y)) left -= 1;
          while (right < w - 1 && !visited[indexAt(right + 1, y)] && matches(right + 1, y)) right += 1;

          for (let xx = left; xx <= right; xx += 1) {
            const i = indexAt(xx, y);
            visited[i] = 1;
            data[i] = fillPacked;
          }

          for (const row of [y - 1, y + 1]) {
            if (row < 0 || row >= h) continue;
            let inSpan = false;
            for (let xx = left; xx <= right; xx += 1) {
              const i = indexAt(xx, row);
              const can = !visited[i] && matches(xx, row);
              if (can && !inSpan) {
                stack.push(i);
                inSpan = true;
              } else if (!can) {
                inSpan = false;
              }
            }
          }
        }

        ctx.putImageData(image, 0, 0);
        return true;
      }

      const eraseDot = (point, width) => {
        const x = clamp(point.x, 0, 1) * state.viewW;
        const y = clamp(point.y, 0, 1) * state.viewH;
        const radius = Math.max(width / 2, 0.5);
        baseCtx.save();
        baseCtx.globalCompositeOperation = "destination-out";
        baseCtx.beginPath();
        baseCtx.arc(x, y, radius, 0, Math.PI * 2);
        baseCtx.fill();
        baseCtx.restore();
      }

      const eraseLine = (from, to, widthFrom, widthTo) => {
        const x1 = clamp(from.x, 0, 1) * state.viewW;
        const y1 = clamp(from.y, 0, 1) * state.viewH;
        const x2 = clamp(to.x, 0, 1) * state.viewW;
        const y2 = clamp(to.y, 0, 1) * state.viewH;
        baseCtx.save();
        baseCtx.globalCompositeOperation = "destination-out";
        baseCtx.lineCap = "round";
        baseCtx.lineJoin = "round";
        baseCtx.lineWidth = Math.max(0.5, (widthFrom + widthTo) / 2);
        baseCtx.beginPath();
        baseCtx.moveTo(x1, y1);
        baseCtx.lineTo(x2, y2);
        baseCtx.stroke();
        baseCtx.restore();
      }

      const applyEraserFrom = (active, fromIndex) => {
        if (!active || !Array.isArray(active.points) || active.points.length === 0) return;
        const width = styleWidth(active.style);

        if (fromIndex <= 0) {
          eraseDot(active.points[0], width * pressureFactor(active.points[0]));
          active.appliedIndex = 1;
          fromIndex = 1;
        }

        for (let i = Math.max(1, fromIndex); i < active.points.length; i += 1) {
          const from = active.points[i - 1];
          const to = active.points[i];
          eraseLine(
            from,
            to,
            width * pressureFactor(from),
            width * pressureFactor(to),
          );
          active.appliedIndex = i + 1;
        }
      }

      const updateArtUI = () => {
        const hasArt =
          state.strokes.size > 0 ||
          state.active.size > 0 ||
          Boolean(state.localActive);
        els.emptyState.classList.toggle("is-hidden", hasArt);
        syncHistoryUI();
      }

      const canUndo = () => {
        if (!state.undoStack.length) return false;
        return state.undoStack.some((id) => {
          const stroke = state.strokes.get(id);
          return stroke && isOwnStroke(stroke);
        });
      }

      const isOwnStroke = (stroke) => {
        if (!stroke) return false;
        if (stroke.authorId === "local") return true;
        return Boolean(state.clientId) && stroke.authorId === state.clientId;
      }

      const syncHistoryUI = () => {
        const undoAvailable = canUndo();
        els.undoButton.disabled = !undoAvailable;
        els.redoButton.disabled = state.redoStack.length === 0;
        els.undoButton.setAttribute("aria-disabled", undoAvailable ? "false" : "true");
        els.redoButton.setAttribute("aria-disabled", state.redoStack.length ? "false" : "true");
      }

      const addCommittedStroke = (stroke, { render = true, remember = true } = {}) => {
        if (!stroke || typeof stroke.strokeId !== "string") return;
        state.strokes.set(stroke.strokeId, stroke);
        if (render) renderStrokeToBase(stroke);
        if (remember) {
          state.undoStack.push(stroke.strokeId);
          const maxHistory = 400;
          if (state.undoStack.length > maxHistory) state.undoStack.splice(0, state.undoStack.length - maxHistory);
        }
        updateArtUI();
      }

      const queueOfflineStroke = (stroke) => {
        state.offlineQueue.push(cloneStroke(stroke));
        if (state.offlineQueue.length > 500) state.offlineQueue.shift();
      }

      const pointFromClient = (clientX, clientY, pressure, pointerType) => {
        const rect = els.canvasShell.getBoundingClientRect();
        const x = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        const y = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
        const point = { x: roundPoint(x), y: roundPoint(y) };

        if (pointerType === "pen" && Number.isFinite(pressure)) {
          point.pressure = roundPoint(clamp(pressure, 0.02, 1));
        } else if (pointerType === "touch" && Number.isFinite(pressure) && pressure > 0 && pressure !== 0.5) {
          point.pressure = roundPoint(clamp(pressure, 0.02, 1));
        }

        return point;
      }

      const pointFromEvent = (event) => {
        return pointFromClient(event.clientX, event.clientY, event.pressure, event.pointerType);
      }

      const serializePoint = (point) => {
        const out = { x: roundPoint(clamp(point.x, 0, 1)), y: roundPoint(clamp(point.y, 0, 1)) };
        if (Number.isFinite(point.pressure)) out.pressure = roundPoint(clamp(point.pressure, 0, 1));
        return out;
      }

      const serializeStyle = (style) => {
        return {
          color: style.color,
          width: clamp(Number(style.width) || 1, 0.5, 100),
        };
      }

      const sendStrokeStart = (active) => {
        if (!connected()) return;
        const ok = sendJson({
          type: "stroke-start",
          strokeId: active.strokeId,
          point: serializePoint(active.points[0]),
          style: serializeStyle(active.style),
        });
        if (ok) {
          active.sentStart = true;
          active.lastSend = performance.now();
        }
      }

      const flushPoints = (active) => {
        if (!active) return;
        if (!active.sentStart || !connected()) {
          active.pending.length = 0;
          return;
        }
        if (!active.pending.length) return;

        const points = active.pending.splice(0, active.pending.length).map(serializePoint);
        if (!points.length) return;
        sendJson({ type: "stroke-points", strokeId: active.strokeId, points });
        active.lastSend = performance.now();
      }

      const sendStrokeEnd = (strokeId) => {
        if (!connected()) return;
        sendJson({ type: "stroke-end", strokeId });
      }

      const sendFullStroke = (stroke) => {
        return sendJson({
          type: "stroke",
          strokeId: stroke.strokeId,
          points: stroke.points.map(serializePoint),
          style: serializeStyle(stroke.style),
        });
      }

      const addPointToStroke = (active, point, now) => {
        const last = active.points[active.points.length - 1];
        const distance = last
          ? Math.hypot((point.x - last.x) * state.viewW, (point.y - last.y) * state.viewH)
          : Infinity;
        const pressureDelta =
          last && Number.isFinite(point.pressure) && Number.isFinite(last.pressure)
            ? Math.abs(point.pressure - last.pressure)
            : 0;

        if (distance < 0.75 && pressureDelta < 0.1) return false;

        active.points.push(point);

        if (active.sentStart && connected()) {
          active.pending.push(point);
          if (
            active.pending.length >= POINT_BATCH_MAX ||
            now - (active.lastSend || 0) >= POINT_BATCH_MS
          ) {
            flushPoints(active);
          }
        }

        if (parseStyle(active.style).eraser) {
          applyEraserFrom(active, active.appliedIndex || 0);
        }

        return true;
      }

      const shapePoints = (type, start, end) => {
        if (type === "line") {
          return [start, end];
        }

        if (type === "rect") {
          return [
            start,
            { x: end.x, y: start.y },
            end,
            { x: start.x, y: end.y },
          ];
        }

        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        const rx = Math.abs(end.x - start.x) / 2;
        const ry = Math.abs(end.y - start.y) / 2;
        const points = [];
        const segments = 64;
        for (let i = 0; i < segments; i += 1) {
          const angle = (i / segments) * Math.PI * 2;
          points.push({
            x: roundPoint(cx + Math.cos(angle) * rx),
            y: roundPoint(cy + Math.sin(angle) * ry),
          });
        }
        return points;
      }

      const shapeStyle = (type) => {
        const prefix = { line: "shapeL:", rect: "shapeR:", circle: "shapeC:" }[type] || "shapeL:";
        return { color: prefix + state.color, width: state.brushWidth };
      }

      const startLocalStroke = (event) => {
        const point = pointFromEvent(event);
        state.pointerId = event.pointerId;
        state.lastCursorSend = 0;

        try {
          els.base.setPointerCapture(event.pointerId);
        } catch {}

        if (state.tool === "fill") {
          finishFillAt(point);
          state.pointerId = null;
          return;
        }

        if (state.tool === "line" || state.tool === "rect" || state.tool === "circle") {
          state.localActive = {
            kind: "shape",
            shape: state.tool,
            strokeId: shortId(),
            pointerId: event.pointerId,
            start: point,
            current: point,
            points: [point],
            preview: shapePoints(state.tool, point, point),
            style: shapeStyle(state.tool),
            sentStart: false,
          };
          requestLiveRedraw();
          updateArtUI();
          return;
        }

        const eraser = state.tool === "eraser";
        const width = eraser ? state.eraserWidth : state.brushWidth;
        const active = {
          kind: "stroke",
          strokeId: shortId(),
          pointerId: event.pointerId,
          points: [point],
          pending: [],
          style: {
            color: eraser ? "eraser" : state.color,
            width,
          },
          sentStart: false,
          lastSend: performance.now(),
          appliedIndex: 0,
          eraser,
        };

        state.localActive = active;

        if (eraser) {
          applyEraserFrom(active, 0);
        }

        requestLiveRedraw();
        updateArtUI();

        if (!connected() && !state.offlineNoticeShown) {
          state.offlineNoticeShown = true;
          showToast("info", "Estás dibujando sin conexión. Tus trazos se guardarán y se compartirán al conectar.", {
            duration: 4200,
          });
        }
      }

      const moveLocalStroke = (event) => {
        const active = state.localActive;
        if (!active) return;

        if (active.kind === "shape") {
          const point = pointFromEvent(event);
          active.current = point;
          active.preview = shapePoints(active.shape, active.start, point);
          requestLiveRedraw();
          return;
        }

        const coalesced =
          typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
        const events = coalesced.length ? coalesced : [event];
        const now = performance.now();
        let changed = false;

        for (const sample of events) {
          const point = pointFromClient(
            sample.clientX,
            sample.clientY,
            sample.pressure,
            sample.pointerType,
          );
          if (addPointToStroke(active, point, now)) changed = true;
        }

        if (changed) requestLiveRedraw();
      }

      const finishLocalStroke = () => {
        const active = state.localActive;
        if (!active) return;

        state.localActive = null;
        state.pointerId = null;

        try {
          if (els.base.hasPointerCapture?.(active.pointerId)) {
            els.base.releasePointerCapture(active.pointerId);
          }
        } catch {}

        if (active.kind === "shape") {
          const points = active.preview || shapePoints(active.shape, active.start, active.current);
          const tooSmall =
            Math.abs(active.current.x - active.start.x) < 0.001 &&
            Math.abs(active.current.y - active.start.y) < 0.001;

          if (!tooSmall && points.length) {
            const stroke = {
              strokeId: active.strokeId,
              points: points.map((point) => ({ ...point })),
              style: { ...active.style },
              authorId: state.clientId || "local",
              complete: true,
            };

            addCommittedStroke(stroke, { render: true });
            if (connected()) {
              sendFullStroke(stroke);
            } else {
              queueOfflineStroke(stroke);
            }
          }

          requestLiveRedraw();
          updateArtUI();
          return;
        }

        flushPoints(active);

        const stroke = {
          strokeId: active.strokeId,
          points: active.points.map((point) => ({ ...point })),
          style: { ...active.style },
          authorId: state.clientId || "local",
          complete: true,
        };

        if (connected()) {
          sendFullStroke(stroke);
        } else {
          queueOfflineStroke(stroke);
        }

        state.strokes.set(stroke.strokeId, stroke);
        if (!active.eraser) {
          drawStroke(baseCtx, stroke);
        }

        state.undoStack.push(stroke.strokeId);
        if (state.undoStack.length > 400) state.undoStack.shift();

        requestLiveRedraw();
        updateArtUI();
      }

      const cancelLocalStroke = () => {
        if (!state.localActive) return;
        const active = state.localActive;
        state.localActive = null;
        state.pointerId = null;
        try {
          if (els.base.hasPointerCapture?.(active.pointerId)) {
            els.base.releasePointerCapture(active.pointerId);
          }
        } catch {}
        redrawBase();
        redrawLive();
        updateArtUI();
      }

      const finishFillAt = (point) => {
        const changed = floodFill(baseCtx, point.x, point.y, state.color);
        if (!changed) return;

        const stroke = {
          strokeId: shortId(),
          points: [{ x: point.x, y: point.y }],
          style: { color: "fill:" + state.color, width: 1 },
          authorId: state.clientId || "local",
          complete: true,
        };

        addCommittedStroke(stroke, { render: false });
        if (connected()) {
          sendFullStroke(stroke);
        } else {
          queueOfflineStroke(stroke);
        }

        if (!connected() && !state.offlineNoticeShown) {
          state.offlineNoticeShown = true;
          showToast("info", "Estás dibujando sin conexión. Tus trazos se compartirán al conectar.", {
            duration: 4000,
          });
        }
      }

      const sendUndoCommand = (targetId) => {
        const color = `cmd:undo:${targetId}`;
        if (color.length > 32) return false;
        return sendJson({
          type: "stroke",
          strokeId: shortId(),
          points: [{ x: 0.5, y: 0.5 }],
          style: { color, width: 1 },
        });
      }

      const applyUndoCommand = (message) => {
        const targetId = String(message?.style?.color || "").slice("cmd:undo:".length);
        if (!targetId) return false;
        const target = state.strokes.get(targetId);
        if (!target || target.authorId !== message.authorId) return false;

        state.strokes.delete(targetId);
        state.undoStack = state.undoStack.filter((id) => id !== targetId);
        redrawBase();
        redrawLive();
        updateArtUI();
        return true;
      }

      const undo = () => {
        if (!canUndo()) {
          showToast("info", "No hay nada que deshacer.", { duration: 2200 });
          return;
        }

        let index = -1;
        for (let i = state.undoStack.length - 1; i >= 0; i -= 1) {
          const stroke = state.strokes.get(state.undoStack[i]);
          if (stroke && isOwnStroke(stroke)) {
            index = i;
            break;
          }
        }
        if (index === -1) return;

        const [strokeId] = state.undoStack.splice(index, 1);
        const stroke = state.strokes.get(strokeId);
        if (!stroke) return;

        state.strokes.delete(strokeId);
        state.offlineQueue = state.offlineQueue.filter((item) => item.strokeId !== strokeId);
        state.redoStack.push({
          points: stroke.points.map((point) => ({ ...point })),
          style: { ...stroke.style },
        });

        if (connected()) {
          sendUndoCommand(strokeId);
        } else {
          showToast("info", "Deshecho solo en este dispositivo (sin conexión).", { duration: 2600 });
        }

        redrawBase();
        redrawLive();
        updateArtUI();
      }

      const redo = () => {
        const item = state.redoStack.pop();
        if (!item) {
          showToast("info", "No hay nada que rehacer.", { duration: 2200 });
          return;
        }

        const stroke = {
          strokeId: shortId(),
          points: item.points.map((point) => ({ ...point })),
          style: { ...item.style },
          authorId: state.clientId || "local",
          complete: true,
        };

        addCommittedStroke(stroke, { render: true });
        if (connected()) {
          sendFullStroke(stroke);
        } else {
          queueOfflineStroke(stroke);
          showToast("info", "Rehecho solo en este dispositivo (sin conexión).", { duration: 2400 });
        }

        redrawLive();
        updateArtUI();
      }

      const clearBoardFromServer = (message) => {
        cancelLocalStroke();
        state.strokes.clear();
        state.active.clear();
        state.offlineQueue = [];
        state.undoStack = [];
        state.redoStack = [];
        redrawBase();
        redrawLive();
        updateArtUI();
        if (message && message.authorId !== state.clientId) {
          showToast("info", "Alguien ha limpiado la pizarra.", { icon: "sparkles" });
        }
      }

      const requestClear = () => {
        if (!state.strokes.size && !state.localActive && !state.active.size) {
          showToast("info", "La pizarra ya está vacía.", { duration: 2000 });
          return;
        }

        els.clearDescription.textContent = connected()
          ? "Esto eliminará el dibujo de todas las personas conectadas. No se puede deshacer."
          : "Se borrará tu copia local. Al conectarte volverás a ver la pizarra del servidor.";
        els.clearDialog.showModal();
      }

      const confirmClear = () => {
        cancelLocalStroke();
        state.strokes.clear();
        state.active.clear();
        state.offlineQueue = [];
        state.undoStack = [];
        state.redoStack = [];
        redrawBase();
        redrawLive();
        updateArtUI();

        if (connected()) {
          sendJson({ type: "clear" });
          showToast("success", "Pizarra limpia para todos.", { icon: "sparkles" });
        } else {
          showToast("info", "Pizarra limpia solo en este dispositivo.", { duration: 2600 });
        }
      }

      const savePng = () => {
        if (!state.strokes.size) {
          showToast("info", "Dibuja algo antes de guardar. ✏️", { duration: 2200 });
          return;
        }

        const out = document.createElement("canvas");
        out.width = els.base.width;
        out.height = els.base.height;
        const ctx = out.getContext("2d");
        if (!ctx) return;

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(els.base, 0, 0);
        ctx.drawImage(els.overlay, 0, 0);

        const pad = (value) => String(value).padStart(2, "0");
        const now = new Date();
        const filename = `pizarra-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
          now.getDate(),
        )}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;

        const triggerDownload = (url) => {
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          link.remove();
          showToast("success", "Imagen descargada con fondo blanco. 🖼️", { duration: 3000 });
        };

        if (out.toBlob) {
          out.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            triggerDownload(url);
            setTimeout(() => URL.revokeObjectURL(url), 4000);
          }, "image/png");
        } else {
          triggerDownload(out.toDataURL("image/png"));
        }
      }

      const showToast = (type, message, options = {}) => {
        const toast = document.createElement("div");
        toast.className = `toast is-${type}`;
        const duration = options.duration || 2800;

        const icon = document.createElement("div");
        icon.className = "toast-icon";
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttributeNS("http://www.w3.org/1999/xlink", "href", options.icon === "sparkles" ? "#i-sparkles" : type === "success" ? "#i-check" : type === "error" ? "#i-close" : "#i-info");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "icon");
        svg.setAttribute("aria-hidden", "true");
        svg.appendChild(use);
        icon.appendChild(svg);

        const text = document.createElement("span");
        text.textContent = message;

        toast.appendChild(icon);
        toast.appendChild(text);
        els.toastStack.appendChild(toast);

        const timer = setTimeout(() => {
          toast.classList.add("is-out");
          setTimeout(() => toast.remove(), 280);
        }, duration);

        toast.addEventListener("click", () => {
          clearTimeout(timer);
          toast.classList.add("is-out");
          setTimeout(() => toast.remove(), 280);
        });
      }

      const burstConfetti = () => {
        const colors = ["#6c5ce7", "#ff4d6d", "#ffb703", "#2ec4b6", "#4cc9f0", "#9bdc28", "#ff6fb5"];
        const count = 36;
        for (let i = 0; i < count; i += 1) {
          const piece = document.createElement("div");
          piece.className = "confetti";
          const left = 45 + Math.random() * 10;
          piece.style.setProperty("--x", left + "%");
          piece.style.setProperty("--c", colors[i % colors.length]);
          piece.style.setProperty("--w", (4 + Math.random() * 8) + "px");
          piece.style.setProperty("--h", (8 + Math.random() * 12) + "px");
          piece.style.setProperty("--rad", Math.random() > 0.5 ? "999px" : "2px");
          piece.style.setProperty("--drift", (Math.random() - 0.5) * 220 + "px");
          piece.style.setProperty("--spin", (360 + Math.random() * 540) + "deg");
          piece.style.setProperty("--dur", (1.6 + Math.random() * 0.9) + "s");
          piece.style.setProperty("--delay", (Math.random() * 0.25) + "s");
          els.confettiLayer.appendChild(piece);
          setTimeout(() => piece.remove(), 3200);
        }
      }

      const updateCursorAppearance = () => {
        const ring = els.cursorRing;
        const core = ring.querySelector(".cursor-core");
        const customCursor =
          window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
          state.hoverPointerType !== "touch";

        els.canvasShell.classList.toggle("has-custom-cursor", customCursor);
        ring.classList.remove("is-visible", "is-eraser", "is-bucket", "is-shape");

        if (!state.cursorVisible || !customCursor) return;

        const w = Math.max(14, renderedWidth(activeWidth()) + 10);
        ring.style.width = `${w}px`;
        ring.style.height = `${w}px`;
        ring.style.borderColor = state.tool === "eraser" ? "#7d7799" : state.color;

        if (state.tool === "eraser") {
          ring.classList.add("is-eraser");
          core.style.background = "#9b95b3";
        } else if (state.tool === "fill") {
          ring.classList.add("is-bucket");
          core.style.background = state.color;
        } else if (state.tool === "line" || state.tool === "rect" || state.tool === "circle") {
          ring.classList.add("is-shape");
          core.style.background = state.color;
        } else {
          core.style.background = state.color;
        }

        ring.classList.add("is-visible");
      }

      const setStatus = (status, text) => {
        state.status = status;
        els.statusPill.classList.remove("is-connected", "is-connecting", "is-reconnecting", "is-off");
        if (status === "connected") els.statusPill.classList.add("is-connected");
        else if (status === "connecting") els.statusPill.classList.add("is-connecting");
        else if (status === "reconnecting") els.statusPill.classList.add("is-reconnecting");
        else els.statusPill.classList.add("is-off");

        const label = text || (status === "connected" ? "Conectado" : status === "connecting" ? "Conectando..." : status === "reconnecting" ? "Reconectando..." : "Desconectado");
        els.statusText.textContent = label;
        els.statusPill.title = label;

        if (status === "connected") {
          els.connectButton.classList.add("is-connected");
          els.connectButton.classList.remove("is-connecting");
          els.connectLabel.textContent = "Desconectar";
          els.liveBadge.classList.add("is-live");
          els.liveText.textContent = "En directo";
          els.canvasTip.textContent = "Dibuja en equipo en tiempo real";
        } else if (status === "connecting" || status === "reconnecting") {
          els.connectButton.classList.remove("is-connected");
          els.connectButton.classList.add("is-connecting");
          els.connectLabel.textContent = "Conectando";
          els.liveBadge.classList.remove("is-live");
          els.liveText.textContent = status === "reconnecting" ? "Reconectando" : "Conectando";
          els.canvasTip.textContent = "Conectando al servidor...";
        } else {
          els.connectButton.classList.remove("is-connected", "is-connecting");
          els.connectLabel.textContent = "Conectar";
          els.liveBadge.classList.remove("is-live");
          els.liveText.textContent = "Solo local";
          els.canvasTip.textContent = "Conéctate para dibujar en equipo";
          state.userCount = 0;
          updatePresenceUI();
        }
        updateArtUI();
      }

      const sendJson = (message) => {
        try {
          return communication.send(message);
        } catch {
          return false;
        }
      }

      const clearRemoteCursors = () => {
        els.remoteCursors.innerHTML = "";
        remoteCursorEls.clear();
      }

      const updatePresenceUI = () => {
        const count = state.userCount || 0;
        els.userCount.textContent = String(count);
        els.usersPill.title = `${count} persona${count === 1 ? "" : "s"} conectada${count === 1 ? "" : "s"}`;
        els.usersPill.setAttribute(
          "aria-label",
          `${count} persona${count === 1 ? "" : "s"} conectada${count === 1 ? "" : "s"}`,
        );
        if (state.status === "connected") {
          els.liveText.textContent = `En directo · ${count}`;
        }
      }

      const resetBoardForSnapshot = () => {
        cancelLocalStroke();
        state.strokes.clear();
        state.active.clear();
        state.redoStack = [];
        state.undoStack = [];
        clearRemoteCursors();
        redrawBase();
        redrawLive();
        updateArtUI();
      }

      const flushOfflineQueue = () => {
        if (!connected() || !state.offlineQueue.length) return;

        const queue = state.offlineQueue.splice(0, state.offlineQueue.length);
        let synced = 0;

        for (const original of queue) {
          const stroke = cloneStroke(original);
          stroke.authorId = state.clientId || "local";
          stroke.complete = true;

          const existing = state.strokes.get(stroke.strokeId) || state.active.get(stroke.strokeId);
          if (existing && existing.authorId !== state.clientId) {
            state.strokes.delete(stroke.strokeId);
            state.active.delete(stroke.strokeId);
            stroke.strokeId = shortId();
          }

          state.strokes.set(stroke.strokeId, stroke);
          state.undoStack.push(stroke.strokeId);
          renderStrokeToBase(stroke);
          sendFullStroke(stroke);
          synced += 1;
        }

        if (state.undoStack.length > 400) {
          state.undoStack.splice(0, state.undoStack.length - 400);
        }

        redrawBase();
        redrawLive();
        updateArtUI();

        if (synced > 0) {
          showToast(
            "success",
            `${synced} trazo${synced === 1 ? "" : "s"} local${synced === 1 ? "" : "es"} sincronizado${synced === 1 ? "" : "s"}.`,
            { duration: 3200 },
          );
        }
      }

      const sendHello = () => {
        if (!connected() || !hasFeature("names")) return;
        const name = state.userName.trim() || "Artista";
        sendJson({ type: "hello", name, color: state.color });
      }

      const sendCursor = (point, visible = true) => {
        if (!connected() || !hasFeature("cursors")) return;
        const now = performance.now();
        if (visible && now - state.lastCursorSend < CURSOR_THROTTLE_MS) return;
        state.lastCursorSend = now;
        sendJson({
          type: "cursor",
          x: roundPoint(point.x),
          y: roundPoint(point.y),
          name: state.userName.trim() || "Artista",
          color: state.color,
          visible,
        });
      }

      const updateRemoteCursor = (message) => {
        if (!hasFeature("cursors")) return;
        if (!message.authorId || message.authorId === state.clientId) return;

        const x = clamp(Number(message.x), 0, 1);
        const y = clamp(Number(message.y), 0, 1);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;

        let entry = remoteCursorEls.get(message.authorId);
        if (!entry) {
          const el = document.createElement("div");
          el.className = "remote-cursor is-hidden";
          el.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2.8 20 11l-6.6 1.7L9.5 21 4 2.8Z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="remote-cursor-name"></span>';
          els.remoteCursors.appendChild(el);
          entry = { el, name: el.querySelector(".remote-cursor-name"), path: el.querySelector("path"), timer: 0 };
          remoteCursorEls.set(message.authorId, entry);
        }

        clearTimeout(entry.timer);
        if (message.visible === false) {
          entry.el.classList.add("is-hidden");
          return;
        }

        const color = normalizeHex(message.color) || "#6c5ce7";
        entry.el.style.left = `${x * 100}%`;
        entry.el.style.top = `${y * 100}%`;
        entry.el.classList.remove("is-hidden");
        entry.name.textContent = String(message.name || "Artista").slice(0, 20);
        entry.name.style.background = color;
        entry.path.setAttribute("fill", color);

        entry.timer = setTimeout(() => entry.el.classList.add("is-hidden"), 6000);
      }

      const handleMessage = (raw) => {
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;

        switch (message.type) {
          case "snapshot": {
            resetBoardForSnapshot();
            state.clientId = message.clientId || state.clientId;
            if (typeof message.clients === "number") {
              state.userCount = message.clients;
              updatePresenceUI();
            }
            if (Array.isArray(message.features)) {
              state.serverFeatures = new Set(message.features);
            }
            if (Array.isArray(message.capabilities)) {
              for (const feature of message.capabilities) {
                state.serverFeatures.add(feature);
              }
            }
            const strokes = Array.isArray(message.strokes) ? message.strokes : [];
            for (const s of strokes) {
              const stroke = {
                strokeId: s.strokeId,
                points: Array.isArray(s.points) ? s.points.map((p) => normalizePoint(p)).filter(Boolean) : [],
                style: normalizeStyle(s.style),
                authorId: s.authorId || "server",
                complete: s.complete !== false,
              };
              if (!stroke.points.length || typeof stroke.strokeId !== "string") continue;

              if (parseStyle(stroke.style).type === "command") {
                const targetId = String(stroke.style.color || "").slice("cmd:undo:".length);
                const target = state.strokes.get(targetId);
                if (target && target.authorId === stroke.authorId) {
                  state.strokes.delete(targetId);
                }
                continue;
              }

              if (stroke.complete) {
                state.strokes.set(stroke.strokeId, stroke);
              } else {
                state.active.set(stroke.strokeId, stroke);
              }
            }
            redrawBase();
            for (const activeStroke of state.active.values()) {
              if (parseStyle(activeStroke.style).eraser) {
                applyEraserFrom(activeStroke, 0);
              }
            }
            redrawLive();
            updateArtUI();
            flushOfflineQueue();
            sendHello();
            break;
          }
          case "presence": {
            if (typeof message.clients === "number") {
              state.userCount = message.clients;
              updatePresenceUI();
            }
            break;
          }
          case "stroke-start": {
            if (!message.strokeId) break;
            const style = normalizeStyle(message.style);
            const info = parseStyle(style);
            if (info.type === "fill" || info.type === "command") break;
            const stroke = {
              strokeId: message.strokeId,
              points: [],
              style,
              authorId: message.authorId || "remote",
              complete: false,
            };
            if (message.point) {
              const p = normalizePoint(message.point);
              if (p) stroke.points.push(p);
            }
            if (info.type === "eraser") {
              stroke.appliedIndex = 0;
              applyEraserFrom(stroke, 0);
            }
            state.active.set(stroke.strokeId, stroke);
            redrawLive();
            updateArtUI();
            break;
          }
          case "stroke-points": {
            const active = state.active.get(message.strokeId);
            if (!active) break;
            const info = parseStyle(active.style);
            const points = Array.isArray(message.points) ? message.points.map((p) => normalizePoint(p)).filter(Boolean) : [];
            for (const p of points) {
              active.points.push(p);
            }
            if (info.type === "eraser") {
              applyEraserFrom(active, active.appliedIndex || 0);
            }
            redrawLive();
            break;
          }
          case "stroke-end": {
            const active = state.active.get(message.strokeId);
            if (!active) break;
            const info = parseStyle(active.style);
            if (message.discard) {
              state.active.delete(message.strokeId);
              if (info.type === "eraser") redrawBase();
              redrawLive();
              updateArtUI();
              break;
            }
            if (Array.isArray(message.points)) {
              const points = message.points.map((p) => normalizePoint(p)).filter(Boolean);
              for (const p of points) active.points.push(p);
            }
            state.active.delete(message.strokeId);
            active.complete = true;
            state.strokes.set(active.strokeId, active);

            if (info.type === "eraser") {
              applyEraserFrom(active, active.appliedIndex || 0);
            } else if (info.type === "fill") {
              const point = active.points[0];
              if (point) floodFill(baseCtx, point.x, point.y, info.color);
            } else if (info.type !== "command") {
              renderStrokeToBase(active);
            }

            redrawLive();
            updateArtUI();
            break;
          }
          case "stroke": {
            const style = normalizeStyle(message.style);
            const info = parseStyle(style);
            if (info.type === "command") {
              applyUndoCommand({ style, authorId: message.authorId });
              break;
            }
            if (info.type === "fill") {
              const point = Array.isArray(message.points) ? normalizePoint(message.points[0]) : null;
              if (point && floodFill(baseCtx, point.x, point.y, info.color)) {
                state.active.delete(message.strokeId);
                state.strokes.set(message.strokeId, {
                  strokeId: message.strokeId,
                  points: [{ x: point.x, y: point.y }],
                  style,
                  authorId: message.authorId || "remote",
                  complete: true,
                });
                updateArtUI();
              }
              break;
            }
            const stroke = {
              strokeId: message.strokeId,
              points: Array.isArray(message.points) ? message.points.map((p) => normalizePoint(p)).filter(Boolean) : [],
              style,
              authorId: message.authorId || "remote",
              complete: true,
            };
            if (!stroke.points.length) break;
            state.active.delete(stroke.strokeId);
            state.strokes.set(stroke.strokeId, stroke);
            renderStrokeToBase(stroke);
            redrawLive();
            updateArtUI();
            break;
          }
          case "clear": {
            clearBoardFromServer(message);
            break;
          }
          case "error": {
            const msg = message.message || "Error del servidor";
            if (message.code === "RATE_LIMITED") {
              showToast("warning", "Vas un poco rápido. Espera un momento.", { duration: 2800 });
            } else {
              showToast("error", msg, { duration: 3600 });
            }
            break;
          }
          case "cursor": {
            updateRemoteCursor(message);
            break;
          }
          case "pong": {
            if (state.pingSentAt) {
              state.latency = Math.round(performance.now() - state.pingSentAt);
              state.pingSentAt = 0;
            }
            break;
          }
          default:
            break;
        }
      }

      const scheduleReconnect = () => {
        if (state.manualClose) return;
        if (state.reconnectTimer) return;
        state.reconnectAttempts += 1;
        const delay = Math.min(1500 * Math.pow(1.8, Math.min(state.reconnectAttempts - 1, 6)), 10000);
        setStatus("reconnecting", `Reconectando (${state.reconnectAttempts})...`);
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          connect();
        }, delay);
      }

      const normalizeServerUrl = (raw) => {
        let value = String(raw || "").trim();
        if (!value) return null;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "ws://" + value;

        let url;
        try {
          url = new URL(value);
        } catch {
          return null;
        }

        if (url.protocol === "http:") url.protocol = "ws:";
        if (url.protocol === "https:") url.protocol = "wss:";
        if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
        if (!url.hostname) return null;
        if (url.pathname === "/" || url.pathname === "") url.pathname = "/board";
        return url.toString();
      }

      const connect = () => {
        const currentSocket = communication.socket;
        if (
          currentSocket &&
          (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING)
        ) {
          return;
        }

        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
        state.manualClose = false;
        state.serverFeatures = new Set();

        const url = normalizeServerUrl(SERVER_URL);
        if (!url) {
          showToast("warning", SERVER_URL_HINT, { duration: 7000 });
          setStatus("disconnected", "Desconectado");
          return;
        }

        const generation = ++state.socketGeneration;
        setStatus(state.reconnectAttempts > 0 ? "reconnecting" : "connecting");

        try {
          let opened = false;
          const socket = communication.connect(url, {
            open: () => {
              if (generation !== state.socketGeneration) return;
              opened = true;
              state.everConnected = true;
              state.reconnectAttempts = 0;
              clearTimeout(state.reconnectTimer);
              state.reconnectTimer = null;
              setStatus("connected", "Conectado");
              burstConfetti();
            },
            message: (event) => {
              if (generation !== state.socketGeneration) return;
              handleMessage(event.data);
            },
            close: (event) => {
              if (generation !== state.socketGeneration) return;
              state.socket = null;

              if (state.localActive) finishLocalStroke();
              state.active.clear();
              clearRemoteCursors();
              redrawLive();
              updateArtUI();

              if (state.manualClose || event.code === 1000) {
                setStatus("disconnected", "Desconectado");
                return;
              }

              if (event.code === 1008) {
                setStatus("disconnected", "Desconectado");
                showToast("error", "El servidor rechazó la conexión. Revisa el origen o la IP permitida.", {
                  duration: 4600,
                });
                return;
              }

              if (!opened && !state.everConnected) {
                setStatus("disconnected", "Desconectado");
                if (event.code === 1006) {
                  showToast("error", "No se pudo conectar. Revisa que el servidor esté encendido y el puerto 3005 abierto en su firewall.", {
                    duration: 5200,
                  });
                } else if (event.code === 1013) {
                  showToast("error", "El servidor está lleno. Inténtalo de nuevo en un momento.", {
                    duration: 4400,
                  });
                } else {
                  showToast("warning", `No se pudo conectar (código ${event.code}).`, { duration: 4000 });
                }
                return;
              }

              if (event.code === 1006) {
                showToast("error", "Se perdió la conexión. Revisa que el servidor siga encendido y accesible en la red WiFi.", {
                  duration: 4600,
                });
              } else if (event.code === 1001) {
                showToast("warning", "El servidor se está apagando. Intentando reconectar...", {
                  duration: 3600,
                });
              }

              scheduleReconnect();
            },
            error: () => {},
          });
          state.socket = socket;
        } catch {
          state.socket = null;
          setStatus("disconnected", "Desconectado");
          showToast("error", "No se pudo conectar. ¿Está encendido el servidor?", { duration: 4400 });
        }
      }

      const disconnect = () => {
        state.manualClose = true;
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;

        if (state.localActive) finishLocalStroke();

        communication.disconnect();

        state.socket = null;
        state.socketGeneration += 1;
        state.reconnectAttempts = 0;
        state.active.clear();
        clearRemoteCursors();
        redrawLive();
        setStatus("disconnected", "Desconectado");
        showToast("info", "Desconectado. Puedes seguir dibujando en local.", { duration: 2800 });
      }

      const closeMobileColorPanel = () => {
        els.dock.classList.remove("is-palette-open");
        els.colorToggle.setAttribute("aria-expanded", "false");
        els.colorToggle.setAttribute("aria-label", "Abrir paleta de colores");
        els.colorToggle.setAttribute("title", "Paleta de colores");
      }

      const closeSizePopover = () => {
        els.sizePopover.classList.remove("is-open");
        els.sizeToggle.setAttribute("aria-expanded", "false");
      }

      const init = () => {
        if (state.initialized) return;
        state.initialized = true;

        document.addEventListener("submit", (e) => {
          const form = e.target;
          if (form && form instanceof HTMLFormElement) {
            if (form.getAttribute("method") === "dialog") {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
          }
        }, true);

        document.addEventListener("selectstart", (e) => {
          if (state.pointerId !== null) {
            e.preventDefault();
          }
        }, true);

        els.canvasShell.addEventListener("contextmenu", (e) => {
          if (e.target === els.base || e.target === els.overlay) {
            e.preventDefault();
          }
        });

        els.base.addEventListener("dragstart", (e) => e.preventDefault());
        els.overlay.addEventListener("dragstart", (e) => e.preventDefault());

        readStoredPreferences();
        applyTheme(state.theme, false);
        state.userName = state.userName.trim() || "Artista";
        els.userName.value = state.userName;
        updateUserIdentityUI();
        renderPalette();
        renderRecentColors();
        selectColor(state.color, { remember: false });
        setTool(state.tool);
        updateSizeUI();

        layoutBoard();
        scheduleLayout();
        resizeCanvases();

        els.toolButtons.forEach((btn) => {
          btn.addEventListener("click", () => {
            setTool(btn.dataset.tool);
          });
        });

        const onSize = (e) => setSize(e.target.value, { save: false });
        const onSizeCommitted = (e) => setSize(e.target.value, { save: true });
        els.sizeSlider.addEventListener("input", onSize);
        els.sizeSliderMobile.addEventListener("input", onSize);
        els.sizeSlider.addEventListener("change", onSizeCommitted);
        els.sizeSliderMobile.addEventListener("change", onSizeCommitted);

        els.customColor.addEventListener("input", (e) => {
          selectColor(e.target.value, { remember: false });
        });
        els.customColor.addEventListener("change", (e) => {
          selectColor(e.target.value, { remember: true });
        });
        els.colorToggle.addEventListener("click", () => {
          const open = els.dock.classList.toggle("is-palette-open");
          els.colorToggle.setAttribute("aria-expanded", open ? "true" : "false");
          els.colorToggle.setAttribute("aria-label", open ? "Cerrar paleta de colores" : "Abrir paleta de colores");
          els.colorToggle.setAttribute("title", open ? "Cerrar paleta de colores" : "Paleta de colores");
          closeSizePopover();
        });
        els.sizeToggle.addEventListener("click", () => {
          const open = els.sizePopover.classList.toggle("is-open");
          els.sizeToggle.setAttribute("aria-expanded", open ? "true" : "false");
          closeMobileColorPanel();
        });
        document.addEventListener("click", (e) => {
          if (!els.dock.contains(e.target) && !els.sizePopover.contains(e.target)) {
            closeMobileColorPanel();
          }
          if (!els.sizeToggle.contains(e.target) && !els.sizePopover.contains(e.target)) {
            closeSizePopover();
          }
        });

        els.themeToggle.addEventListener("click", toggleTheme);
        els.helpButton.addEventListener("click", () => els.helpDialog.showModal());
        els.connectButton.addEventListener("click", () => {
          if (connected() || state.status === "connecting" || state.status === "reconnecting") {
            disconnect();
          } else {
            connect();
          }
        });
        els.userName.addEventListener("input", () => {
          state.userName = els.userName.value.slice(0, 20);
          updateUserIdentityUI();
          saveNameLater();
          announceNameLater();
        });

        els.undoButton.addEventListener("click", undo);
        els.redoButton.addEventListener("click", redo);
        els.clearButton.addEventListener("click", requestClear);
        els.confirmClear.addEventListener("click", () => {
          els.clearDialog.close();
          confirmClear();
        });
        els.saveButton.addEventListener("click", savePng);

        els.canvasShell.addEventListener("pointerdown", (e) => {
          if (e.target !== els.base) return;
          if (e.pointerType === "mouse" && e.button !== 0) return;
          if (state.pointerId !== null) return;
          e.preventDefault();
          state.cursorVisible = true;
          state.hoverPointerType = e.pointerType;
          startLocalStroke(e);
          updateCursorAppearance();
        });
        els.canvasShell.addEventListener("pointermove", (e) => {
          if (state.pointerId !== null && e.target === els.base) {
            e.preventDefault();
          }
          state.hoverPointerType = e.pointerType;
          const ring = els.cursorRing;
          const rect = els.canvasShell.getBoundingClientRect();
          ring.style.left = (e.clientX - rect.left) + "px";
          ring.style.top = (e.clientY - rect.top) + "px";
          state.lastCursorPoint = pointFromClient(e.clientX, e.clientY, undefined, "mouse");
          sendCursor(state.lastCursorPoint, true);
          if (state.pointerId === e.pointerId) {
            moveLocalStroke(e);
          }
          updateCursorAppearance();
        });
        els.canvasShell.addEventListener("pointerup", (e) => {
          if (e.target === els.base || e.target === els.overlay) {
            e.preventDefault();
            e.stopPropagation();
          }
          if (state.pointerId === e.pointerId) finishLocalStroke();
          updateCursorAppearance();
        });
        els.canvasShell.addEventListener("pointercancel", (e) => {
          if (e.target === els.base || e.target === els.overlay) {
            e.preventDefault();
            e.stopPropagation();
          }
          if (state.pointerId === e.pointerId) cancelLocalStroke();
          updateCursorAppearance();
        });
        els.canvasShell.addEventListener("pointerleave", () => {
          if (state.pointerId !== null) {
            cancelLocalStroke();
          }
          state.cursorVisible = false;
          els.cursorRing.classList.remove("is-visible");
          if (state.lastCursorPoint) sendCursor(state.lastCursorPoint, false);
        });
        els.canvasShell.addEventListener("pointerenter", () => {
          state.cursorVisible = true;
          updateCursorAppearance();
        });

        document.addEventListener("keydown", (e) => {
          if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
            if (e.key === "Escape") e.target.blur();
            return;
          }
          if (document.querySelector("dialog[open]")) return;

          const key = e.key.toLowerCase();
          if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
            e.preventDefault();
            els.helpDialog.showModal();
            return;
          }
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "z") {
            e.preventDefault();
            undo();
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "z") {
            e.preventDefault();
            redo();
            return;
          }
          if ((e.ctrlKey || e.metaKey) && key === "y") {
            e.preventDefault();
            redo();
            return;
          }
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          if (key === "b") { e.preventDefault(); setTool("brush"); return; }
          if (key === "e") { e.preventDefault(); setTool("eraser"); return; }
          if (key === "g") { e.preventDefault(); setTool("fill"); return; }
          if (key === "l") { e.preventDefault(); setTool("line"); return; }
          if (key === "r") { e.preventDefault(); setTool("rect"); return; }
          if (key === "c") { e.preventDefault(); setTool("circle"); return; }
          if (key === "[") { e.preventDefault(); setSize(activeWidth() - 1); return; }
          if (key === "]") { e.preventDefault(); setSize(activeWidth() + 1); return; }
          if (key >= "1" && key <= "9") {
            const idx = Number(key) - 1;
            if (PALETTE[idx]) { e.preventDefault(); selectColor(PALETTE[idx].hex); }
            return;
          }
        });

        window.addEventListener("resize", scheduleLayout);
        window.addEventListener("orientationchange", scheduleLayout);

        setStatus("disconnected", "Desconectado");
        updateArtUI();
        syncHistoryUI();
        updateCursorAppearance();
      }

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
      } else {
        init();
      }
    })();