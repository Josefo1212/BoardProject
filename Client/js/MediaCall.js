import { Receiver, Sender } from "./vendor/p2p.esm.js";
import { SignalingDriver } from "./P2PCommunication.js";
import { clamp, isLightColor, normalizeHex } from "./utils.js";

// La videollamada vive en una sala propia ("<sala>-av") para no mezclarse con
// el DataChannel del tablero. El servidor solo reenvía la señalización.
const CALL_ROOM_SUFFIX = "-av";

const SPEAK_THRESHOLD = 0.045;
const SPEAK_HOLD_MS = 420;
const SPEAK_POLL_MS = 160;

const VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24 },
};

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const MEDIA_CONSTRAINTS = { video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS };
const AUDIO_ONLY_CONSTRAINTS = { video: false, audio: AUDIO_CONSTRAINTS };

const CAMERA_MISSING_ERRORS = new Set([
  "NotFoundError",
  "DevicesNotFoundError",
  "OverconstrainedError",
  "ConstraintNotSatisfiedError",
]);

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createElement(tag, className, attributes = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  return node;
}

function icon(symbol, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${symbol}`);
  svg.appendChild(use);
  return svg;
}

/**
 * Videollamada entre pares (mesh) sobre la señalización del servidor.
 *
 * Cada cliente publica su cámara/micrófono con un `Sender` y recibe a los
 * demás con un `Receiver`. El vídeo nunca pasa por el servidor: solo se
 * intercambian las ofertas/respuestas SDP y los candidatos ICE.
 *
 * Es un `EventTarget` por si se prefiere escuchar eventos, pero la integración
 * con la app usa las callbacks `onChange` / `onNotice` / `announce`.
 */
export class MediaCall extends EventTarget {
  #getServerUrl;
  #room;
  #iceServers;
  #onNotice;
  #onChange;
  #announce;
  #mount;

  #selfId = randomId();
  #active = false;
  #joining = false;
  #leaving = false;

  #driver = null;
  #sender = null;
  #receiver = null;

  #stream = null;
  #audioOnly = false;
  #media = { mic: true, cam: true };
  #identity = { name: "Artista", color: "#6c5ce7" };

  #peers = new Map();
  #dom = null;
  #dragState = null;

  #audio = { ctx: null, nodes: new Map() };
  #speaking = new Map();
  #speakTimer = 0;

  #devices = { cameras: [], mics: [] };

  constructor({
    serverUrl,
    room = "pizarra",
    iceServers = [],
    onNotice = null,
    onChange = null,
    announce = null,
    mount = null,
  } = {}) {
    super();
    this.#getServerUrl = typeof serverUrl === "function" ? serverUrl : () => serverUrl;
    this.#room = room || "pizarra";
    this.#iceServers = Array.isArray(iceServers) ? iceServers : [];
    this.#onNotice = onNotice;
    this.#onChange = onChange;
    this.#announce = announce;
    this.#mount = mount;
  }

  get active() {
    return this.#active;
  }

  get peerCount() {
    return this.#peers.size;
  }

  /** Actualiza el nombre y el color que ven los demás. */
  setIdentity({ name, color } = {}) {
    const nextName = (typeof name === "string" ? name.trim() : "").slice(0, 20) || this.#identity.name;
    const nextColor = normalizeHex(color) || this.#identity.color;

    if (nextName === this.#identity.name && nextColor === this.#identity.color) {
      return;
    }

    this.#identity = { name: nextName, color: nextColor };
    this.#renderLocalTile();
    this.#broadcastState();
  }

  async join() {
    if (this.#active || this.#joining) return;

    const url = this.#resolveUrl();

    if (!url) {
      this.#notice("error", "No hay servidor disponible para la videollamada. Conéctate primero.");
      return;
    }

    this.#joining = true;
    this.#emitChange();

    const stream = await this.#openMedia();

    if (!stream) {
      this.#joining = false;
      this.#emitChange();
      return;
    }

    this.#stream = stream;
    this.#active = true;

    this.#buildDom();
    this.#showPanel();
    this.#attachLocalStream();
    this.#renderControls();
    this.#renderLocalTile();

    try {
      this.#startSignaling(url);
    } catch (error) {
      this.#notice("error", "No se pudo iniciar la videollamada en este servidor.");
      this.leave({ silent: true });
      return;
    }

    this.#startSpeakingLoop();
    this.#joining = false;
    this.#announceCall("Videollamada iniciada.");
    this.#emitChange();
  }

  leave({ silent = false } = {}) {
    if (!this.#active && !this.#stream) {
      this.#joining = false;
      return;
    }

    this.#leaving = true;
    this.#active = false;
    this.#joining = false;

    try {
      this.#sender?.stop();
    } catch {}
    try {
      this.#receiver?.stop();
    } catch {}
    try {
      this.#driver?.close();
    } catch {}

    this.#sender = null;
    this.#receiver = null;
    this.#driver = null;

    for (const id of this.#audio.nodes.keys()) {
      this.#stopAnalyser(id);
    }
    this.#peers.clear();
    this.#speaking.clear();

    if (this.#stream) {
      for (const track of this.#stream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.#stream = null;
    }

    this.#stopSpeakingLoop();
    this.#closeAudioContext();
    this.#hidePanel();
    this.#media = { mic: true, cam: true };
    this.#audioOnly = false;
    this.#leaving = false;

    if (!silent) this.#announceCall("Videollamada finalizada.");
    this.#emitChange();
  }

  toggleMic() {
    const track = this.#stream?.getAudioTracks()[0];
    if (!track) return;

    this.#media.mic = !this.#media.mic;
    track.enabled = this.#media.mic;
    this.#renderControls();
    this.#renderLocalTile();
    this.#broadcastState();
    this.#emitChange();
    this.#announceCall(this.#media.mic ? "Micrófono activado." : "Micrófono silenciado.");
  }

  toggleCamera() {
    if (this.#audioOnly) {
      this.#notice("info", "No hay cámara disponible en este dispositivo.");
      return;
    }

    const track = this.#stream?.getVideoTracks()[0];
    if (!track) return;

    this.#media.cam = !this.#media.cam;
    track.enabled = this.#media.cam;
    this.#renderControls();
    this.#renderLocalTile();
    this.#broadcastState();
    this.#emitChange();
    this.#announceCall(this.#media.cam ? "Cámara encendida." : "Cámara apagada.");
  }

  // --- Medios locales -----------------------------------------------------

  #resolveUrl() {
    const raw = typeof this.#getServerUrl === "function" ? this.#getServerUrl() : this.#getServerUrl;
    if (!raw) return null;

    try {
      const url = new URL(raw);
      url.pathname = "/signal";
      url.search = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  async #openMedia() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.#notice(
        "error",
        "La videollamada necesita un contexto seguro. Abre la página en https:// o en http://localhost.",
      );
      return null;
    }

    if (window.isSecureContext === false) {
      this.#notice(
        "error",
        "La videollamada necesita HTTPS o localhost. Revisa la documentación para probarla en tu red WiFi.",
      );
      return null;
    }

    try {
      return await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
    } catch (error) {
      if (CAMERA_MISSING_ERRORS.has(error?.name)) {
        return this.#openAudioOnly(error);
      }

      this.#notifyMediaError(error);
      return null;
    }
  }

  async #openAudioOnly() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(AUDIO_ONLY_CONSTRAINTS);
      this.#audioOnly = true;
      this.#media.cam = false;
      this.#notice("warning", "No se encontró cámara. La llamada continúa solo con audio.");
      return stream;
    } catch (error) {
      this.#notifyMediaError(error);
      return null;
    }
  }

  #notifyMediaError(error) {
    const name = error?.name || "";

    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      this.#notice(
        "error",
        "Permiso de cámara o micrófono denegado. Habilítalo en el navegador para usar la videollamada.",
      );
    } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      this.#notice("error", "No se encontró cámara ni micrófono en este dispositivo.");
    } else if (name === "NotReadableError" || name === "TrackStartError") {
      this.#notice(
        "error",
        "No se pudo acceder a la cámara o al micrófono: puede que otro programa los esté usando.",
      );
    } else if (name === "OverconstrainedError") {
      this.#notice("error", "La cámara no admite la resolución solicitada.");
    } else {
      this.#notice("error", "No se pudo iniciar la videollamada. Revisa los permisos del navegador.");
    }
  }

  // --- Señalización -------------------------------------------------------

  #avRoom() {
    return `${this.#room}${CALL_ROOM_SUFFIX}`;
  }

  #metadata() {
    return {
      peerId: this.#selfId,
      name: this.#identity.name,
      color: this.#identity.color,
      mic: this.#media.mic,
      cam: this.#media.cam && !this.#audioOnly,
    };
  }

  #startSignaling(url) {
    this.#driver = new SignalingDriver(url, {
      close: () => {
        if (!this.#active || this.#leaving) return;
        this.#notice("warning", "Se perdió la conexión de la videollamada.");
        this.leave({ silent: true });
      },
      error: () => {},
    });

    this.#sender = new Sender({
      driver: this.#driver,
      iceServers: this.#iceServers,
      // Evita que un cliente se conecte consigo mismo: cada Receiver publica
      // su `selfId` como credencial y el Sender rechaza la suya.
      verify: ({ credentials }) => !credentials || credentials.selfId !== this.#selfId,
    });
    this.#sender.addEventListener("channel:open", (event) => {
      const channel = event.detail?.channel;
      if (channel?.label === "av-state") this.#sendStateTo(channel);
    });
    this.#sender.addEventListener("error", (event) => {
      console.warn("[MediaCall] Error del Sender:", event.detail?.error?.message || event.detail?.error);
    });
    this.#sender.start({
      room: this.#avRoom(),
      stream: this.#stream,
      metadata: this.#metadata(),
      channels: { "av-state": { ordered: true } },
    });

    this.#receiver = new Receiver({
      driver: this.#driver,
      iceServers: this.#iceServers,
      connectionTimeout: 30,
      pingInterval: 20,
      pingAttempts: 5,
    });
    this.#receiver.addEventListener("stream", (event) => this.#onRemoteStream(event.detail));
    this.#receiver.addEventListener("channel:message", (event) => this.#onRemoteState(event.detail));
    this.#receiver.addEventListener("channel:close", (event) => {
      // Si se cierra el canal de estado, el par se está yendo: quitamos su ficha.
      // `dispose` suele llegar después y `#removePeer` ignora duplicados.
      if (event.detail?.channel?.label === "av-state") this.#removePeer(event.detail?.id);
    });
    this.#receiver.addEventListener("dispose", (event) => this.#removePeer(event.detail?.id));
    this.#receiver.addEventListener("error", (event) => {
      console.warn("[MediaCall] Error del Receiver:", event.detail?.error?.message || event.detail?.error);
    });
    this.#receiver.start({ room: this.#avRoom(), credentials: { selfId: this.#selfId } });
  }

  #onRemoteStream(detail) {
    const { id, stream, metadata } = detail || {};
    if (!id || !stream) return;
    if (metadata?.peerId && metadata.peerId === this.#selfId) return;

    let peer = this.#peers.get(id);

    if (!peer) {
      peer = this.#createPeer(id, metadata);
      this.#peers.set(id, peer);
    }

    peer.stream = stream;
    if (peer.videoEl) peer.videoEl.srcObject = stream;
    this.#applyMetadata(peer, metadata);
    this.#attachAnalyser(stream, id);
    this.#updateTile(peer);
    this.#renderTiles();
    this.#announceCall(`${peer.name} se unió a la videollamada.`);
  }

  #onRemoteState(detail) {
    const { id, channel, data } = detail || {};
    if (!id || channel?.label !== "av-state") return;

    let payload;
    try {
      payload = JSON.parse(typeof data === "string" ? data : "");
    } catch {
      return;
    }

    let peer = this.#peers.get(id);

    if (!peer) {
      peer = this.#createPeer(id, payload);
      this.#peers.set(id, peer);
      this.#renderTiles();
    }

    this.#applyMetadata(peer, payload);
    this.#updateTile(peer);
  }

  #createPeer(id, metadata) {
    const peer = {
      id,
      peerId: metadata?.peerId || id,
      name: (metadata?.name || "Invitado").slice(0, 20),
      color: normalizeHex(metadata?.color) || "#6c5ce7",
      mic: metadata?.mic !== false,
      cam: metadata?.cam !== false,
      stream: null,
      videoEl: null,
      speaking: false,
    };

    peer.tile = this.#createTile(peer);
    return peer;
  }

  #applyMetadata(peer, metadata) {
    if (!metadata) return;
    if (typeof metadata.name === "string" && metadata.name.trim()) peer.name = metadata.name.slice(0, 20);
    if (normalizeHex(metadata.color)) peer.color = normalizeHex(metadata.color);
    if (typeof metadata.mic === "boolean") peer.mic = metadata.mic;
    if (typeof metadata.cam === "boolean") peer.cam = metadata.cam;
    if (typeof metadata.peerId === "string" && metadata.peerId) peer.peerId = metadata.peerId;
  }

  #removePeer(id) {
    const peer = this.#peers.get(id);
    if (!peer) return;

    this.#stopAnalyser(id);
    peer.tile?.remove();
    this.#peers.delete(id);
    this.#renderTiles();
    this.#announceCall(`${peer.name} salió de la videollamada.`);
  }

  #broadcastState() {
    if (!this.#sender) return;
    const payload = JSON.stringify(this.#metadata());

    for (const connection of this.#sender.connections.values()) {
      const channel = connection.channels?.get("av-state");
      this.#sendStateTo(channel, payload);
    }
  }

  #sendStateTo(channel, payload = JSON.stringify(this.#metadata())) {
    if (!channel || channel.readyState !== "open") return;
    try {
      channel.send(payload);
    } catch {}
  }

  // --- Indicador de voz ---------------------------------------------------

  #ensureAudioContext() {
    if (this.#audio.ctx) return this.#audio.ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    try {
      this.#audio.ctx = new AudioCtx();
    } catch {
      return null;
    }

    return this.#audio.ctx;
  }

  #attachAnalyser(stream, id) {
    const ctx = this.#ensureAudioContext();
    if (!ctx || !stream.getAudioTracks?.().length) return;

    this.#stopAnalyser(id);

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.65;
      const gain = ctx.createGain();
      gain.gain.value = 0; // solo analizamos: el audio se oye por el <video>.
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      this.#audio.nodes.set(id, { source, analyser, gain, data: new Uint8Array(analyser.fftSize) });
    } catch {}
  }

  #stopAnalyser(id) {
    const node = this.#audio.nodes.get(id);
    if (!node) return;

    try {
      node.source.disconnect();
      node.analyser.disconnect();
      node.gain.disconnect();
    } catch {}

    this.#audio.nodes.delete(id);
    this.#speaking.delete(id);
  }

  #startSpeakingLoop() {
    if (this.#speakTimer) return;
    this.#speakTimer = window.setInterval(() => this.#pollSpeaking(), SPEAK_POLL_MS);
  }

  #stopSpeakingLoop() {
    if (!this.#speakTimer) return;
    clearInterval(this.#speakTimer);
    this.#speakTimer = 0;
  }

  #pollSpeaking() {
    const now = performance.now();

    for (const [id, node] of this.#audio.nodes) {
      node.analyser.getByteTimeDomainData(node.data);

      let sum = 0;
      for (let i = 0; i < node.data.length; i += 1) {
        const value = (node.data[i] - 128) / 128;
        sum += value * value;
      }

      const rms = Math.sqrt(sum / node.data.length);
      const hold = rms > SPEAK_THRESHOLD ? now + SPEAK_HOLD_MS : this.#speaking.get(id) || 0;
      this.#speaking.set(id, hold);
      const speaking = hold > now;

      if (id === "local") {
        this.#dom?.local?.classList.toggle("is-speaking", speaking);
      } else {
        const peer = this.#peers.get(id);
        if (peer && peer.speaking !== speaking) {
          peer.speaking = speaking;
          peer.tile?.classList.toggle("is-speaking", speaking);
        }
      }
    }
  }

  #closeAudioContext() {
    if (this.#audio.ctx) {
      try {
        this.#audio.ctx.close();
      } catch {}
      this.#audio.ctx = null;
    }
    this.#audio.nodes.clear();
  }

  // --- DOM ----------------------------------------------------------------

  #buildDom() {
    if (this.#dom) return;

    const panel = createElement("section", "call-panel", {
      id: "call-panel",
      "aria-label": "Videollamada",
      "data-state": "open",
    });
    panel.hidden = true;

    const head = createElement("header", "call-head", { id: "call-drag" });
    head.appendChild(createElement("span", "call-live", { "aria-hidden": "true" }));
    const headAvatar = createElement("span", "call-head-avatar", {
      id: "call-head-avatar",
      "aria-hidden": "true",
    });
    head.appendChild(headAvatar);

    const headText = createElement("div", "call-head-text");
    const title = createElement("h2", "call-title");
    title.textContent = "Videollamada";
    headText.appendChild(title);
    const sub = createElement("span", "call-sub");
    sub.id = "call-sub";
    sub.textContent = "1 en la llamada";
    headText.appendChild(sub);
    head.appendChild(headText);

    const headActions = createElement("div", "call-head-actions");
    const minButton = createElement("button", "call-icon-btn", {
      id: "call-min",
      type: "button",
      "aria-label": "Minimizar videollamada",
      title: "Minimizar",
    });
    minButton.appendChild(icon("i-chevron"));
    headActions.appendChild(minButton);
    head.appendChild(headActions);
    panel.appendChild(head);

    const stage = createElement("div", "call-stage");
    const grid = createElement("div", "call-grid", { id: "call-grid", role: "list", "data-tiles": "0" });
    stage.appendChild(grid);

    const empty = createElement("p", "call-empty");
    empty.id = "call-empty";
    empty.textContent = "Esperando a que se una alguien…";
    stage.appendChild(empty);

    const local = createElement("div", "call-local", { id: "call-local" });
    const localVideo = createElement("video", "call-video", { id: "call-local-video", autoplay: "", playsinline: "", muted: "" });
    localVideo.muted = true;
    const localAvatar = createElement("span", "call-avatar", { id: "call-local-avatar", "aria-hidden": "true" });
    const localLabel = createElement("span", "call-local-label", { id: "call-local-label" });
    localLabel.textContent = "Tú";
    const localMic = createElement("span", "call-mic", { id: "call-local-mic", "aria-hidden": "true" });
    localMic.appendChild(icon("i-mic-off"));
    local.append(localVideo, localAvatar, localLabel, localMic);
    stage.appendChild(local);
    panel.appendChild(stage);

    const bar = createElement("div", "call-bar", { role: "group", "aria-label": "Controles de la videollamada" });
    const micButton = this.#createControl("call-mic", "Silenciar micrófono", ["i-mic", "i-mic-off"]);
    const camButton = this.#createControl("call-cam", "Apagar cámara", ["i-video", "i-video-off"]);
    const devicesButton = createElement("button", "call-btn", {
      id: "call-devices",
      type: "button",
      "aria-label": "Elegir cámara o micrófono",
      "aria-expanded": "false",
      title: "Dispositivos",
    });
    devicesButton.appendChild(icon("i-settings"));
    const hangButton = createElement("button", "call-btn is-danger", {
      id: "call-hangup",
      type: "button",
      "aria-label": "Colgar la videollamada",
      title: "Colgar",
    });
    hangButton.appendChild(icon("i-phone-off"));
    bar.append(micButton, camButton, devicesButton, hangButton);
    panel.appendChild(bar);

    const devices = createElement("div", "call-devices", { id: "call-devices-menu" });
    devices.hidden = true;
    const cameraSelect = this.#createDeviceSelect("call-camera-select", "Cámara");
    const micSelect = this.#createDeviceSelect("call-mic-select", "Micrófono");
    devices.append(cameraSelect.label, micSelect.label);
    panel.appendChild(devices);

    (this.#mount || document.body).appendChild(panel);

    this.#dom = {
      panel,
      grid,
      empty,
      sub,
      headAvatar,
      local,
      localVideo,
      localAvatar,
      localMic,
      micButton,
      camButton,
      devicesButton,
      hangButton,
      devicesMenu: devices,
      cameraSelect: cameraSelect.select,
      micSelect: micSelect.select,
    };

    micButton.addEventListener("click", () => this.toggleMic());
    camButton.addEventListener("click", () => this.toggleCamera());
    hangButton.addEventListener("click", () => this.leave());
    minButton.addEventListener("click", () => this.#toggleMinimize());
    devicesButton.addEventListener("click", () => this.#toggleDevices());
    cameraSelect.select.addEventListener("change", () => this.#switchVideo(cameraSelect.select.value));
    micSelect.select.addEventListener("change", () => this.#switchAudio(micSelect.select.value));

    this.#wireDrag(head, panel);
  }

  #createControl(id, label, [onSymbol, offSymbol]) {
    const button = createElement("button", "call-btn", {
      id,
      type: "button",
      "aria-label": label,
      "aria-pressed": "false",
    });
    button.appendChild(icon(onSymbol, "icon icon-on"));
    button.appendChild(icon(offSymbol, "icon icon-off"));
    return button;
  }

  #createDeviceSelect(id, labelText) {
    const label = createElement("label", "call-device");
    const text = createElement("span");
    text.textContent = labelText;
    const select = createElement("select", null, { id });
    label.append(text, select);
    return { label, select };
  }

  #showPanel() {
    if (!this.#dom) return;
    this.#dom.panel.hidden = false;
    this.#dom.panel.dataset.state = "open";
    this.#renderTiles();
  }

  #hidePanel() {
    if (!this.#dom) return;
    this.#dom.panel.hidden = true;
    this.#dom.devicesMenu.hidden = true;
    this.#dom.devicesButton.setAttribute("aria-expanded", "false");
    this.#dom.grid.replaceChildren();
    this.#dom.grid.dataset.tiles = "0";
  }

  #toggleMinimize() {
    if (!this.#dom) return;
    const panel = this.#dom.panel;
    const minimized = panel.dataset.state !== "min";
    panel.dataset.state = minimized ? "min" : "open";
    if (!minimized) this.#clampIntoView();
    this.#emitChange();
    this.#announceCall(minimized ? "Videollamada minimizada." : "Videollamada restaurada.");
  }

  async #toggleDevices() {
    if (!this.#dom) return;
    const menu = this.#dom.devicesMenu;
    const open = menu.hidden;

    if (open) {
      await this.#refreshDevices();
    }

    menu.hidden = !open;
    this.#dom.devicesButton.setAttribute("aria-expanded", open ? "true" : "false");
  }

  async #refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.#devices.cameras = devices.filter((device) => device.kind === "videoinput");
      this.#devices.mics = devices.filter((device) => device.kind === "audioinput");
      this.#renderDeviceMenu();
    } catch {}
  }

  #renderDeviceMenu() {
    if (!this.#dom) return;
    const currentVideo = this.#stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    const currentAudio = this.#stream?.getAudioTracks()[0]?.getSettings?.().deviceId;
    this.#fillDeviceSelect(this.#dom.cameraSelect, this.#devices.cameras, currentVideo, "Cámara");
    this.#fillDeviceSelect(this.#dom.micSelect, this.#devices.mics, currentAudio, "Micrófono");
  }

  #fillDeviceSelect(select, list, current, label) {
    select.replaceChildren();

    if (!list.length) {
      const option = createElement("option");
      option.value = "";
      option.textContent = "Sin dispositivos";
      select.appendChild(option);
      select.disabled = true;
      return;
    }

    select.disabled = false;

    list.forEach((device, index) => {
      const option = createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `${label} ${index + 1}`;
      if (device.deviceId === current) option.selected = true;
      select.appendChild(option);
    });
  }

  async #switchVideo(deviceId) {
    if (!this.#stream || !deviceId) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) return;

      this.#replaceTrack("video", track);
      track.enabled = this.#media.cam;
      this.#audioOnly = false;
      this.#renderControls();
      this.#renderLocalTile();
    } catch (error) {
      this.#notifyMediaError(error);
    }
  }

  async #switchAudio(deviceId) {
    if (!this.#stream || !deviceId) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } },
        video: false,
      });
      const track = stream.getAudioTracks()[0];
      if (!track) return;

      this.#replaceTrack("audio", track);
      track.enabled = this.#media.mic;
      this.#attachLocalStream();
      this.#renderControls();
    } catch (error) {
      this.#notifyMediaError(error);
    }
  }

  #replaceTrack(kind, track) {
    if (!this.#stream) return;

    const oldTrack = this.#stream.getTracks().find((item) => item.kind === kind);
    if (oldTrack) {
      this.#stream.removeTrack(oldTrack);
      try {
        oldTrack.stop();
      } catch {}
    }

    this.#stream.addTrack(track);

    if (this.#sender) {
      for (const connection of this.#sender.connections.values()) {
        try {
          for (const sender of connection.peer?.getSenders?.() ?? []) {
            if (sender.track?.kind === kind) sender.replaceTrack(track);
          }
        } catch {}
      }
    }

    if (kind === "video") {
      this.#attachLocalStream();
    }
  }

  #attachLocalStream() {
    if (!this.#dom || !this.#stream) return;
    this.#dom.localVideo.srcObject = this.#stream;
    this.#dom.localVideo.play?.().catch(() => {});
    this.#attachAnalyser(this.#stream, "local");
  }

  #createTile(peer) {
    const tile = createElement("article", "call-tile", { role: "listitem" });
    const video = createElement("video", "call-video", { autoplay: "", playsinline: "" });
    const avatar = createElement("span", "call-avatar", { "aria-hidden": "true" });
    const name = createElement("span", "call-name");
    const mic = createElement("span", "call-mic", { "aria-hidden": "true" });
    mic.appendChild(icon("i-mic-off"));
    tile.append(video, avatar, name, mic);
    peer.videoEl = video;
    peer.avatarEl = avatar;
    peer.nameEl = name;
    peer.micEl = mic;
    return tile;
  }

  #updateTile(peer) {
    if (!peer.tile) return;

    const name = (peer.name || "Invitado").trim() || "Invitado";
    const color = normalizeHex(peer.color) || "#6c5ce7";

    peer.tile.style.setProperty("--peer", color);
    peer.tile.style.setProperty("--peer-ink", isLightColor(color) ? "#2b2444" : "#ffffff");
    peer.avatarEl.textContent = (Array.from(name)[0] || "?").toUpperCase();
    peer.nameEl.textContent = name;
    peer.tile.classList.toggle("is-cam-off", !peer.cam || !peer.stream);
    peer.tile.classList.toggle("is-mic-off", !peer.mic);
    peer.tile.setAttribute(
      "aria-label",
      `${name}${peer.mic ? "" : ", micrófono silenciado"}${peer.cam ? "" : ", cámara apagada"}`,
    );
  }

  #renderLocalTile() {
    if (!this.#dom) return;
    const name = this.#identity.name;
    const initial = (Array.from(name)[0] || "A").toUpperCase();
    const ink = isLightColor(this.#identity.color) ? "#2b2444" : "#ffffff";

    this.#dom.localAvatar.textContent = initial;
    this.#dom.local.style.setProperty("--peer", this.#identity.color);
    this.#dom.local.style.setProperty("--peer-ink", ink);
    this.#dom.local.classList.toggle("is-cam-off", !this.#media.cam || this.#audioOnly);
    this.#dom.local.classList.toggle("is-mic-off", !this.#media.mic);
    this.#dom.localVideo.classList.toggle("is-mirrored", !this.#audioOnly);

    // Píldora minimizada: avatar con el color del usuario.
    this.#dom.headAvatar.textContent = initial;
    this.#dom.headAvatar.style.setProperty("--peer", this.#identity.color);
    this.#dom.headAvatar.style.setProperty("--peer-ink", ink);
  }

  #renderControls() {
    if (!this.#dom) return;

    this.#dom.micButton.classList.toggle("is-off", !this.#media.mic);
    this.#dom.micButton.setAttribute("aria-pressed", this.#media.mic ? "false" : "true");
    this.#dom.micButton.setAttribute("aria-label", this.#media.mic ? "Silenciar micrófono" : "Activar micrófono");

    this.#dom.camButton.classList.toggle("is-off", !this.#media.cam);
    this.#dom.camButton.setAttribute("aria-pressed", this.#media.cam ? "false" : "true");
    this.#dom.camButton.setAttribute("aria-label", this.#media.cam ? "Apagar cámara" : "Encender cámara");
    this.#dom.camButton.disabled = this.#audioOnly;
    this.#dom.camButton.title = this.#audioOnly ? "No hay cámara disponible" : "";
  }

  #renderTiles() {
    if (!this.#dom) return;

    const grid = this.#dom.grid;
    const tiles = [...this.#peers.values()].map((peer) => peer.tile).filter(Boolean);
    grid.replaceChildren(...tiles);
    grid.dataset.tiles = String(tiles.length);
    grid.classList.toggle("is-many", tiles.length > 4);
    this.#dom.empty.hidden = tiles.length > 0;
    this.#dom.sub.textContent = `${this.#peers.size + 1} en la llamada`;
  }

  // --- Arrastre -----------------------------------------------------------

  #topLimit() {
    const topbar = document.querySelector(".topbar");
    const rect = topbar?.getBoundingClientRect();
    if (rect && rect.height > 0) return rect.bottom + 8;
    return 90;
  }

  #wireDrag(handle, panel) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      if (window.matchMedia("(max-width: 620px)").matches) return;
      if (panel.dataset.state === "min") return;

      const rect = panel.getBoundingClientRect();
      this.#dragState = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        rect,
        moved: false,
      };

      panel.style.right = "auto";
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.classList.add("is-dragging");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {}
    });

    handle.addEventListener("pointermove", (event) => {
      const drag = this.#dragState;
      if (!drag || drag.id !== event.pointerId) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;

      const maxLeft = Math.max(8, window.innerWidth - drag.rect.width - 8);
      const maxTop = Math.max(this.#topLimit(), window.innerHeight - drag.rect.height - 8);
      panel.style.left = `${clamp(drag.rect.left + dx, 8, maxLeft)}px`;
      panel.style.top = `${clamp(drag.rect.top + dy, this.#topLimit(), maxTop)}px`;
    });

    const end = (event) => {
      const drag = this.#dragState;
      if (!drag || drag.id !== event.pointerId) return;
      this.#dragState = null;
      panel.classList.remove("is-dragging");
      this.#clampIntoView();
    };

    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  #clampIntoView() {
    if (!this.#dom) return;
    const panel = this.#dom.panel;
    if (!panel.style.left) return;

    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(this.#topLimit(), window.innerHeight - rect.height - 8);
    panel.style.left = `${clamp(rect.left, 8, maxLeft)}px`;
    panel.style.top = `${clamp(rect.top, this.#topLimit(), maxTop)}px`;
  }

  // --- Utilidades ---------------------------------------------------------

  #notice(type, message) {
    this.#onNotice?.(type, message);
    this.dispatchEvent(new CustomEvent("notice", { detail: { type, message } }));
  }

  #announceCall(message) {
    this.#announce?.(message);
    this.dispatchEvent(new CustomEvent("announce", { detail: { message } }));
  }

  #emitChange() {
    const info = {
      active: this.#active,
      joining: this.#joining,
      mic: this.#media.mic,
      cam: this.#media.cam && !this.#audioOnly,
      peers: this.#peers.size,
      minimized: this.#dom?.panel?.dataset.state === "min",
    };

    this.#onChange?.(info);
    this.dispatchEvent(new CustomEvent("change", { detail: info }));
  }
}
