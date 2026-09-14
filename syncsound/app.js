(() => {
  "use strict";

  const APP_ID = "us.jolty.syncsound.public.v2";
  const LOBBY_ID = "syncsound-public-lobby-v2";
  const ROOM_PREFIX = "syncsound-room-v2-";
  const ANNOUNCEMENT_TTL = 16000;
  const JOIN_TIMEOUT = 18000;
  const state = {
    role: null,
    room: null,
    participantId: null,
    adminPeerId: null,
    localStream: null,
    displayStream: null,
    micStream: null,
    networkRoom: null,
    lobby: null,
    lobbyActions: null,
    roomActions: null,
    publicRooms: new Map(),
    muted: false,
    networkReady: null,
    joinTimer: null,
    announceTimer: null
  };

  const $ = (id) => document.getElementById(id);
  const landing = $("landing-view");
  const roomView = $("room-view");
  const adminLayout = $("admin-layout");
  const guestLayout = $("guest-layout");
  const modalBackdrop = $("modal-backdrop");
  const urlRoom = new URLSearchParams(location.search).get("room")?.trim().toUpperCase() || "";
  let pendingJoinCode = urlRoom;
  let joinRoomNetwork = null;
  let networkSelfId = null;

  function randomCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
  }

  function initials(name = "?") {
    return name.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;"
    })[character]);
  }

  function roomLink(code) {
    return `${location.origin}${location.pathname}?room=${code}`;
  }

  function notify(message, type = "info") {
    const stack = $("toast-stack");
    const duplicate = [...stack.children].find((toast) => toast.dataset.message === message);
    duplicate?.remove();
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.dataset.message = message;
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  function setTopStatus(text) {
    $("top-status").textContent = text;
  }

  function setJoinBusy(busy) {
    const button = $("join-form").querySelector("button[type='submit']");
    button.disabled = busy;
    button.innerHTML = busy ? "Buscando anfitrión…" : "Ingresar a la sala <span>→</span>";
  }

  async function ensureNetwork() {
    if (state.networkReady) return state.networkReady;
    state.networkReady = (async () => {
      try {
        setTopStatus("Conectando a la red pública…");
        const module = await import("https://esm.run/trystero@0.25.4");
        joinRoomNetwork = module.joinRoom;
        networkSelfId = module.selfId;
        state.participantId = networkSelfId;
        setupLobby();
        setTopStatus("Red pública activa");
        return true;
      } catch (error) {
        console.error("No se pudo iniciar la señalización pública", error);
        setTopStatus("Red pública no disponible");
        notify("No se pudo conectar con la red pública. Revisa Internet o bloqueadores del navegador.", "error");
        return false;
      }
    })();
    return state.networkReady;
  }

  function setupLobby() {
    state.lobby = joinRoomNetwork({ appId: APP_ID }, LOBBY_ID, {
      onJoinError: () => setTopStatus("Reconectando la lista pública…")
    });
    const announce = state.lobby.makeAction("room-announce");
    const query = state.lobby.makeAction("room-query");
    state.lobbyActions = { announce, query };

    announce.onMessage = (data) => receiveAnnouncement(data);
    query.onMessage = (_data, { peerId }) => announceCurrentRoom(peerId);
    state.lobby.onPeerJoin = (peerId) => {
      announceCurrentRoom(peerId);
      query.send({ requestedAt: Date.now() }, { target: peerId }).catch(() => {});
    };
    query.send({ requestedAt: Date.now() }).catch(() => {});
    state.announceTimer = setInterval(() => {
      announceCurrentRoom();
      prunePublicRooms();
    }, 5000);
  }

  function publicRoomPayload() {
    if (state.role !== "admin" || !state.room || state.room.closed) return null;
    return {
      code: state.room.code,
      name: state.room.name,
      adminName: state.room.adminName,
      maxParticipants: state.room.maxParticipants,
      participantCount: Object.keys(state.room.participants || {}).length,
      locked: Boolean(state.room.locked),
      activeSource: state.room.activeSource || null,
      updatedAt: Date.now()
    };
  }

  function announceCurrentRoom(target) {
    const payload = publicRoomPayload();
    if (!payload || !state.lobbyActions) return;
    receiveAnnouncement(payload);
    state.lobbyActions.announce.send(payload, target ? { target } : undefined).catch(() => {});
  }

  function receiveAnnouncement(data) {
    if (!data || !/^[A-Z2-9]{6}$/.test(data.code || "") || !data.name || !data.adminName) return;
    state.publicRooms.set(data.code, { ...data, receivedAt: Date.now() });
    renderPublicRooms();
  }

  function prunePublicRooms() {
    const now = Date.now();
    for (const [code, room] of state.publicRooms) {
      if (state.room?.code === code && state.role === "admin") continue;
      if (now - room.receivedAt > ANNOUNCEMENT_TTL) state.publicRooms.delete(code);
    }
    renderPublicRooms();
  }

  function renderPublicRooms() {
    const list = $("public-room-list");
    const rooms = [...state.publicRooms.values()]
      .filter((room) => Date.now() - room.receivedAt <= ANNOUNCEMENT_TTL)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    $("public-rooms-status").textContent = state.lobby ? "Sincronizado entre dispositivos" : "Conectando…";
    if (!rooms.length) {
      list.innerHTML = `<div class="public-rooms-empty"><span>◌</span><p>No hay salas públicas activas.<br /><small>Las salas aparecerán mientras su anfitrión esté conectado.</small></p></div>`;
      return;
    }

    list.innerHTML = rooms.map((room) => {
      const full = room.participantCount >= room.maxParticipants;
      const unavailable = room.locked || full;
      const status = room.locked ? "Bloqueada" : full ? "Completa" : `${room.participantCount}/${room.maxParticipants} personas`;
      return `<div class="public-room"><span class="public-room-live"></span><div class="public-room-info"><span class="public-room-name">${escapeHtml(room.name)}</span><span class="public-room-meta">${escapeHtml(room.adminName)} · ${status}</span></div><span class="public-room-code">${room.code}</span><button class="secondary-button" type="button" data-public-room="${room.code}" ${unavailable ? "disabled" : ""}>Entrar</button></div>`;
    }).join("");

    list.querySelectorAll("[data-public-room]").forEach((button) => {
      button.addEventListener("click", () => openModal("join", button.dataset.publicRoom));
    });
  }

  function openModal(kind, code = "") {
    modalBackdrop.classList.remove("hidden");
    ["create-modal", "join-modal", "help-modal"].forEach((id) => $(id).classList.toggle("hidden", id !== `${kind}-modal`));
    if (kind === "join") {
      pendingJoinCode = (code || urlRoom || "").toUpperCase();
      const direct = Boolean(pendingJoinCode);
      $("join-code").value = pendingJoinCode;
      $("join-code-field").classList.toggle("hidden", direct);
      $("join-code").required = !direct;
      $("join-copy").textContent = direct ? "Escribe solamente tu nombre para entrar a esta sala pública." : "Usa el código de seis caracteres o elige una sala pública.";
      setJoinBusy(false);
    }
    const focusId = kind === "create" ? "create-room-name" : kind === "join" ? (pendingJoinCode ? "join-name" : "join-code") : "modal-close";
    setTimeout(() => $(focusId).focus(), 0);
  }

  function closeModal() {
    modalBackdrop.classList.add("hidden");
  }

  function showRoom(role) {
    landing.classList.add("hidden");
    roomView.classList.remove("hidden");
    adminLayout.classList.toggle("hidden", role !== "admin");
    guestLayout.classList.toggle("hidden", role !== "guest");
  }

  function participantRecord(id, name, role) {
    return { id, name: name.trim(), role, joinedAt: Date.now() };
  }

  function cloneRoom() {
    return JSON.parse(JSON.stringify(state.room));
  }

  function renderParticipants() {
    const participants = Object.values(state.room?.participants || {});
    const list = state.role === "admin" ? $("admin-participant-list") : $("guest-participant-list");
    list.innerHTML = "";
    participants.forEach((participant) => {
      const row = document.createElement("div");
      row.className = "participant";
      row.innerHTML = `<span class="avatar ${participant.role === "admin" ? "admin" : ""}">${initials(participant.name)}</span><span class="participant-info"><span class="participant-name">${escapeHtml(participant.name)}${participant.id === state.participantId ? " (tú)" : ""}</span><span class="participant-role">${participant.role === "admin" ? "Anfitrión" : "Escuchando"}</span></span>${state.role === "admin" && participant.role !== "admin" ? `<button class="kick-button" type="button" data-kick="${participant.id}" aria-label="Expulsar a ${escapeHtml(participant.name)}">×</button>` : ""}`;
      list.appendChild(row);
    });
    const count = participants.length;
    $("admin-participant-count").textContent = `${count} / ${state.room?.maxParticipants || 8}`;
    $("participant-count-badge").textContent = count;
    $("guest-participant-count").textContent = count;
    document.querySelectorAll("[data-kick]").forEach((button) => button.addEventListener("click", () => kickParticipant(button.dataset.kick)));
  }

  function updateRoomUI() {
    const room = state.room;
    if (!room) return;
    $("room-code-top").textContent = room.code;
    $("admin-room-code").textContent = room.code;
    $("guest-room-code").textContent = room.code;
    $("admin-room-name").textContent = room.name;
    $("guest-room-name").textContent = room.name;
    $("guest-admin-name").textContent = room.adminName;
    $("admin-room-link").textContent = roomLink(room.code);
    $("admin-lock-status").textContent = room.locked ? "Bloqueado" : "Abierto";
    $("lock-label").textContent = room.locked ? "Desbloquear nuevos ingresos" : "Bloquear nuevos ingresos";
    $("room-state-label").textContent = room.closed ? "SALA CERRADA" : "SALA ACTIVA";
    const sourceLabel = room.activeSource?.label || "Ninguna";
    $("admin-active-source").textContent = sourceLabel;
    $("guest-active-source").textContent = sourceLabel === "Ninguna" ? "Sin transmisión" : sourceLabel;
    $("stop-source").classList.toggle("hidden", !room.activeSource);
    $("toggle-mic").classList.toggle("hidden", !room.activeSource?.kind?.includes("mic"));
    $("toggle-mic").textContent = state.muted ? "Activar micrófono" : "Silenciar micrófono";
    $("guest-placeholder-title").textContent = room.activeSource?.hasVideo ? "La pantalla se está preparando" : room.activeSource ? "Transmisión de audio activa" : "Esperando transmisión";
    $("guest-placeholder-copy").textContent = room.activeSource ? "El audio llegará directamente desde el anfitrión." : "El anfitrión todavía no ha elegido una fuente.";
    $("admin-stage-overlay").classList.toggle("hidden", !room.activeSource);
    $("guest-stage-overlay").classList.toggle("hidden", !room.activeSource);
    $("admin-overlay-label").textContent = room.activeSource?.label || "Transmitiendo";
    $("guest-overlay-label").textContent = room.activeSource?.label || "En vivo";
    renderParticipants();
  }

  function setupNetworkRoom() {
    state.networkRoom?.leave();
    state.networkRoom = joinRoomNetwork({ appId: APP_ID }, `${ROOM_PREFIX}${state.room.code.toLowerCase()}`, {
      onJoinError: () => {
        if (state.role === "guest") failGuestJoin("No se pudo establecer la conexión WebRTC con el anfitrión.");
      }
    });
    const presence = state.networkRoom.makeAction("presence");
    const roomState = state.networkRoom.makeAction("room-state");
    const control = state.networkRoom.makeAction("room-control");
    state.roomActions = { presence, roomState, control };

    presence.onMessage = (data, { peerId }) => {
      if (state.role !== "admin" || data?.type !== "join" || !data.name) return;
      const participantCount = Object.keys(state.room.participants).length;
      if (state.room.locked) return sendRoomState(peerId, "rejected", "La sala está bloqueada.");
      if (participantCount >= state.room.maxParticipants) return sendRoomState(peerId, "rejected", "La sala está completa.");
      state.room.participants[peerId] = participantRecord(peerId, String(data.name).slice(0, 30), "guest");
      sendRoomState(peerId, "accepted");
      broadcastRoomState();
      if (state.localStream) Promise.allSettled(state.networkRoom.addStream(state.localStream, { target: peerId, metadata: state.room.activeSource }));
      updateRoomUI();
      announceCurrentRoom();
    };

    roomState.onMessage = (data, { peerId }) => {
      if (state.role !== "guest" || !data?.room) return;
      if (data.status === "rejected") return failGuestJoin(data.reason || "El anfitrión rechazó el ingreso.");
      state.adminPeerId = peerId;
      state.room = data.room;
      clearTimeout(state.joinTimer);
      setJoinBusy(false);
      closeModal();
      showRoom("guest");
      updateRoomUI();
      $("guest-connection-status").textContent = "Conectado";
      setTopStatus("Conectado con el anfitrión");
      if (data.status === "accepted") notify(`Entraste a ${state.room.name}.`);
    };

    control.onMessage = (data, { peerId }) => {
      if (state.role !== "guest" || (state.adminPeerId && peerId !== state.adminPeerId)) return;
      if (data?.type === "kicked") {
        notify("El anfitrión te expulsó de la sala.", "error");
        leaveRoom(true, false);
      } else if (data?.type === "closed") {
        notify("El anfitrión cerró la sala.", "error");
        leaveRoom(true, false);
      }
    };

    state.networkRoom.onPeerJoin = (peerId) => {
      if (state.role === "guest") {
        state.roomActions.presence.send({ type: "join", name: state.room.participants[state.participantId].name }, { target: peerId }).catch(() => {});
      }
    };

    state.networkRoom.onPeerLeave = (peerId) => {
      if (state.role === "admin" && state.room.participants[peerId]) {
        delete state.room.participants[peerId];
        updateRoomUI();
        broadcastRoomState();
        announceCurrentRoom();
      } else if (state.role === "guest" && peerId === state.adminPeerId) {
        notify("El anfitrión se desconectó y la sala se cerró.", "error");
        leaveRoom(true, false);
      }
    };

    state.networkRoom.onPeerStream = (stream, peerId) => {
      if (state.role !== "guest" || (state.adminPeerId && peerId !== state.adminPeerId)) return;
      $("guest-video").srcObject = stream;
      $("guest-video").muted = true;
      $("guest-audio").srcObject = stream;
      const hasVideo = stream.getVideoTracks().length > 0;
      $("guest-video").classList.toggle("hidden", !hasVideo);
      $("guest-media-placeholder").classList.toggle("hidden", hasVideo);
      $("guest-audio").play().catch(() => notify("Toca la pantalla para habilitar el audio del navegador.", "info"));
    };
  }

  function sendRoomState(peerId, status = "update", reason = "") {
    state.roomActions.roomState.send({ status, reason, room: cloneRoom() }, peerId ? { target: peerId } : undefined).catch(() => {});
  }

  function broadcastRoomState() {
    if (state.role === "admin" && state.roomActions) sendRoomState();
  }

  async function createRoom(event) {
    event.preventDefault();
    if (!await ensureNetwork()) return;
    const form = new FormData(event.currentTarget);
    const code = randomCode();
    state.role = "admin";
    state.adminPeerId = state.participantId;
    state.room = {
      code,
      name: String(form.get("roomName")).trim(),
      adminName: String(form.get("adminName")).trim(),
      maxParticipants: Number(form.get("maxParticipants")) || 8,
      locked: false,
      closed: false,
      activeSource: null,
      participants: {}
    };
    state.room.participants[state.participantId] = participantRecord(state.participantId, state.room.adminName, "admin");
    setupNetworkRoom();
    closeModal();
    showRoom("admin");
    updateRoomUI();
    setTopStatus("Anfitrión conectado");
    announceCurrentRoom();
    notify(`Sala ${code} creada y publicada.`);
  }

  async function joinPublicRoom(event) {
    event.preventDefault();
    if (!await ensureNetwork()) return;
    const form = new FormData(event.currentTarget);
    const code = String(form.get("roomCode") || pendingJoinCode || urlRoom || "").trim().toUpperCase();
    const name = String(form.get("guestName") || "").trim();
    if (!/^[A-Z2-9]{6}$/.test(code)) return notify("El código debe tener seis caracteres.", "error");
    if (!name) return notify("Escribe tu nombre para entrar.", "error");
    setJoinBusy(true);
    state.role = "guest";
    state.adminPeerId = null;
    state.room = {
      code,
      name: state.publicRooms.get(code)?.name || "Conectando…",
      adminName: state.publicRooms.get(code)?.adminName || "Buscando anfitrión",
      maxParticipants: state.publicRooms.get(code)?.maxParticipants || 8,
      locked: false,
      closed: false,
      activeSource: null,
      participants: {}
    };
    state.room.participants[state.participantId] = participantRecord(state.participantId, name, "guest");
    showRoom("guest");
    updateRoomUI();
    $("guest-connection-status").textContent = "Buscando anfitrión";
    setTopStatus("Buscando anfitrión…");
    setupNetworkRoom();
    clearTimeout(state.joinTimer);
    state.joinTimer = setTimeout(() => failGuestJoin("No se encontró al anfitrión. Comprueba el código y que la sala siga abierta."), JOIN_TIMEOUT);
  }

  function failGuestJoin(message) {
    clearTimeout(state.joinTimer);
    state.networkRoom?.leave();
    state.networkRoom = null;
    state.roomActions = null;
    state.role = null;
    state.room = null;
    state.adminPeerId = null;
    roomView.classList.add("hidden");
    landing.classList.remove("hidden");
    setJoinBusy(false);
    setTopStatus("Red pública activa");
    notify(message, "error");
  }

  async function requestSource(kind) {
    if (state.role !== "admin") return;
    const displayKinds = ["tab", "app-audio", "screen", "mix"];
    if (!navigator.mediaDevices?.getDisplayMedia && displayKinds.includes(kind)) return notify("Este navegador no permite compartir pantalla o audio.", "error");
    if (!navigator.mediaDevices?.getUserMedia && ["mic", "mix"].includes(kind)) return notify("Este navegador no permite acceder al micrófono.", "error");
    try {
      await stopLocalStream(false);
      let tracks = [];
      if (displayKinds.includes(kind)) {
        state.displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const displayVideo = state.displayStream.getVideoTracks()[0];
        displayVideo?.addEventListener("ended", () => stopLocalStream(true));
        tracks.push(...(kind === "app-audio" ? state.displayStream.getAudioTracks() : state.displayStream.getTracks()));
      }
      if (["mic", "mix"].includes(kind)) {
        state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tracks.push(...state.micStream.getAudioTracks());
      }
      if (kind === "app-audio" && !tracks.length) throw new Error("NO_AUDIO");
      if (!tracks.length) throw new Error("NO_MEDIA");
      state.localStream = new MediaStream(tracks);
      state.muted = false;
      const videoTrack = state.localStream.getVideoTracks()[0];
      if (videoTrack) {
        $("admin-preview").srcObject = new MediaStream([videoTrack]);
        $("admin-preview").classList.remove("hidden");
        $("admin-stage-placeholder").classList.add("hidden");
      } else {
        $("admin-preview").classList.add("hidden");
        $("admin-stage-placeholder").classList.remove("hidden");
      }
      const labels = { tab: "Pestaña + audio", "app-audio": "Solo audio de app", screen: "Pantalla + audio", mic: "Micrófono", mix: "Pantalla + micrófono" };
      state.room.activeSource = { kind, label: labels[kind], hasVideo: Boolean(videoTrack), hasAudio: state.localStream.getAudioTracks().length > 0 };
      Promise.allSettled(state.networkRoom.addStream(state.localStream, { metadata: state.room.activeSource }));
      updateRoomUI();
      broadcastRoomState();
      announceCurrentRoom();
      document.querySelectorAll(".source-button").forEach((button) => button.classList.toggle("active", button.dataset.source === kind));
      notify(`Transmitiendo: ${state.room.activeSource.label}.`);
    } catch (error) {
      if (error?.name === "NotAllowedError") notify("Permiso rechazado. Puedes intentarlo nuevamente.", "error");
      else if (error?.message === "NO_AUDIO") notify("La fuente seleccionada no entregó audio. Elige una pestaña o app y activa “Compartir audio”.", "error");
      else notify("No se pudo iniciar la transmisión en este navegador.", "error");
      await stopLocalStream(false);
    }
  }

  async function stopLocalStream(updateRoom = true) {
    if (state.localStream && state.networkRoom) {
      try { state.networkRoom.removeStream(state.localStream); } catch {}
    }
    state.localStream?.getTracks().forEach((track) => track.stop());
    state.displayStream?.getTracks().forEach((track) => track.stop());
    state.micStream?.getTracks().forEach((track) => track.stop());
    state.localStream = null;
    state.displayStream = null;
    state.micStream = null;
    state.muted = false;
    $("admin-preview").srcObject = null;
    $("admin-preview").classList.add("hidden");
    $("admin-stage-placeholder").classList.remove("hidden");
    document.querySelectorAll(".source-button").forEach((button) => button.classList.remove("active"));
    if (updateRoom && state.room) {
      state.room.activeSource = null;
      updateRoomUI();
      broadcastRoomState();
      announceCurrentRoom();
      notify("La transmisión se detuvo.");
    }
  }

  function toggleMicMute() {
    if (!state.micStream) return notify("Esta fuente no utiliza el micrófono.");
    state.muted = !state.muted;
    state.micStream.getAudioTracks().forEach((track) => { track.enabled = !state.muted; });
    updateRoomUI();
    notify(state.muted ? "Micrófono silenciado." : "Micrófono activo.");
  }

  function kickParticipant(id) {
    if (state.role !== "admin" || !state.room.participants[id]) return;
    const name = state.room.participants[id].name;
    state.roomActions.control.send({ type: "kicked" }, { target: id }).catch(() => {});
    state.networkRoom.getPeers()[id]?.close();
    delete state.room.participants[id];
    updateRoomUI();
    broadcastRoomState();
    announceCurrentRoom();
    notify(`${name} fue expulsado de la sala.`);
  }

  function toggleRoomLock() {
    if (state.role !== "admin" || !state.room) return;
    state.room.locked = !state.room.locked;
    updateRoomUI();
    broadcastRoomState();
    announceCurrentRoom();
    notify(state.room.locked ? "La sala está bloqueada." : "La sala vuelve a aceptar invitados.");
  }

  async function leaveRoom(showLanding = true, tellPeers = true) {
    clearTimeout(state.joinTimer);
    if (state.role === "admin" && state.room) {
      state.room.closed = true;
      if (tellPeers) state.roomActions?.control.send({ type: "closed" }).catch(() => {});
      state.publicRooms.delete(state.room.code);
    }
    await stopLocalStream(false);
    state.networkRoom?.leave();
    state.networkRoom = null;
    state.roomActions = null;
    state.room = null;
    state.role = null;
    state.adminPeerId = null;
    if (showLanding) {
      roomView.classList.add("hidden");
      landing.classList.remove("hidden");
      renderPublicRooms();
      setTopStatus("Red pública activa");
    }
  }

  function copyText(value) {
    navigator.clipboard?.writeText(value).then(() => notify("Enlace copiado.")).catch(() => notify("No se pudo copiar automáticamente.", "error"));
  }

  function bindEvents() {
    $("open-create").addEventListener("click", () => openModal("create"));
    $("open-join").addEventListener("click", () => openModal("join"));
    $("help-button").addEventListener("click", () => openModal("help"));
    $("modal-close").addEventListener("click", closeModal);
    modalBackdrop.addEventListener("click", (event) => { if (event.target === modalBackdrop) closeModal(); });
    $("create-form").addEventListener("submit", createRoom);
    $("join-form").addEventListener("submit", joinPublicRoom);
    $("toggle-lock").addEventListener("click", toggleRoomLock);
    $("close-room").addEventListener("click", () => { if (confirm("¿Cerrar la sala para todos?")) leaveRoom(true); });
    $("copy-room-link").addEventListener("click", () => copyText(roomLink(state.room.code)));
    $("copy-invite").addEventListener("click", () => copyText(roomLink(state.room.code)));
    $("stop-source").addEventListener("click", () => stopLocalStream(true));
    $("toggle-mic").addEventListener("click", toggleMicMute);
    $("guest-leave").addEventListener("click", () => leaveRoom(true));
    $("leave-room-top").addEventListener("click", () => leaveRoom(true));
    $("guest-volume").addEventListener("input", (event) => {
      $("guest-audio").volume = Number(event.target.value);
      $("volume-value").textContent = `${Math.round(Number(event.target.value) * 100)}%`;
    });
    $("guest-fullscreen").addEventListener("click", () => {
      const target = $("guest-video").classList.contains("hidden") ? $("guest-media-placeholder") : $("guest-video");
      target.requestFullscreen?.();
    });
    document.querySelectorAll(".source-button").forEach((button) => button.addEventListener("click", () => requestSource(button.dataset.source)));
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });
  }

  window.addEventListener("online", () => { setTopStatus("Red pública activa"); ensureNetwork(); });
  window.addEventListener("offline", () => setTopStatus("Sin conexión a Internet"));
  window.addEventListener("beforeunload", () => state.networkRoom?.leave());

  bindEvents();
  renderPublicRooms();
  ensureNetwork();
  if (urlRoom) openModal("join", urlRoom);
})();
