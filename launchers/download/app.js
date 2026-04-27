/*
  SyncSound — Audio + Screen sharing via WebRTC + Firebase
  v2: room browser, optional password, max quality & min latency
*/

const FB_URL = 'https://syncsound-f06ec-default-rtdb.firebaseio.com';
let useFirebase = true;

// ─── TARGET BITRATES ──────────────────────────────────────────────────────────
const BITRATE = {
  screen: {
    video: 8_000_000,   // 8 Mbps — crisp 1080p60
    audio: 320_000,     // 320 kbps stereo
  },
  audio: {
    audio: 320_000,
  },
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  role: null,
  roomCode: null,
  roomPass: null,
  roomName: null,
  myName: null,
  peer: null,
  connections: {},
  audioStream: null,
  screenStream: null,
  mediaSource: null,
  calls: {},
  remoteStream: null,
  participants: [],
  myPeerId: null,
  adminPeerId: null,
  sharingScreen: false,
  statsInterval: null,
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3800);
}

function showModal(id) { document.getElementById(id).classList.add('open'); }
function hideModal(id) { document.getElementById(id).classList.remove('open'); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function setStatus(text, online = false) {
  document.getElementById('statusText').textContent = text;
  const badge = document.getElementById('connectionStatus');
  badge.className = 'status-badge' + (online ? ' online' : '');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function togglePassField() {
  const noPass = document.getElementById('createNoPass').checked;
  document.getElementById('passFieldGroup').style.display = noPass ? 'none' : '';
}

// ─── FIREBASE / STORAGE ───────────────────────────────────────────────────────
async function fbRequest(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${FB_URL}${path}`, opts);
  if (!res.ok) throw new Error(`Firebase ${res.status}`);
  return res.json();
}

async function saveRoom(code, data) {
  if (useFirebase) {
    try {
      await fbRequest(`/rooms/${code}.json`, 'PUT', { ...data, ts: Date.now() });
      return;
    } catch (e) { useFirebase = false; }
  }
  localStorage.setItem('ss_room_' + code, JSON.stringify(data));
}

async function getRoom(code) {
  if (useFirebase) {
    try {
      const data = await fbRequest(`/rooms/${code}.json`);
      return data?.adminPeerId ? data : null;
    } catch (e) { useFirebase = false; }
  }
  const raw = localStorage.getItem('ss_room_' + code);
  return raw ? JSON.parse(raw) : null;
}

async function getAllRooms() {
  if (useFirebase) {
    try {
      const data = await fbRequest('/rooms.json');
      if (!data) return [];
      const now = Date.now();
      return Object.entries(data)
        .filter(([, r]) => r?.adminPeerId && (now - (r.ts || 0)) < 8 * 3600_000)
        .map(([code, r]) => ({ code, ...r }))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    } catch (e) { useFirebase = false; }
  }
  // Fallback: scan localStorage
  const rooms = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('ss_room_')) {
      try {
        const r = JSON.parse(localStorage.getItem(key));
        if (r?.adminPeerId) rooms.push({ code: key.replace('ss_room_', ''), ...r });
      } catch (e) {}
    }
  }
  return rooms;
}

async function removeRoom(code) {
  if (useFirebase) {
    try { await fbRequest(`/rooms/${code}.json`, 'DELETE'); } catch (e) {}
  }
  localStorage.removeItem('ss_room_' + code);
}

// ─── ROOM BROWSER ─────────────────────────────────────────────────────────────
let selectedRoom = null;

async function openJoinModal() {
  showModal('joinModal');
  selectedRoom = null;
  document.getElementById('joinCode').value = '';
  document.getElementById('joinPass').value = '';
  document.getElementById('joinPassGroup').style.display = '';
  await loadRoomList();
}

async function loadRoomList() {
  const listEl = document.getElementById('roomList');
  const statusEl = document.getElementById('roomListStatus');
  listEl.innerHTML = '<div class="loading-rooms">Buscando salas activas...</div>';
  statusEl.textContent = 'cargando...';

  try {
    const rooms = await getAllRooms();
    statusEl.textContent = `${rooms.length} sala${rooms.length !== 1 ? 's' : ''}`;

    if (rooms.length === 0) {
      listEl.innerHTML = '<div class="no-rooms">No hay salas activas en este momento.<br>Puedes crear una o ingresar un código.</div>';
      return;
    }

    listEl.innerHTML = rooms.map(room => {
      const isOpen = !room.pass;
      const age = Math.round((Date.now() - (room.ts || 0)) / 60_000);
      const ageStr = age < 1 ? 'ahora mismo' : `hace ${age} min`;
      return `
        <div class="room-entry" data-code="${escHtml(room.code)}" data-pass="${isOpen ? '' : escHtml(room.pass || '')}" data-name="${escHtml(room.name || room.code)}" data-open="${isOpen}" onclick="selectRoom(this)">
          <div class="room-entry-icon">${isOpen ? '🔓' : '🔒'}</div>
          <div class="room-entry-info">
            <div class="room-entry-name">${escHtml(room.name || room.code)}</div>
            <div class="room-entry-meta">${escHtml(room.code)} · ${ageStr}</div>
          </div>
          <div class="room-entry-badge ${isOpen ? 'open' : 'locked'}">${isOpen ? 'Abierta' : 'Con clave'}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    statusEl.textContent = 'error';
    listEl.innerHTML = '<div class="no-rooms">No se pudieron cargar las salas. Ingresa el código manualmente.</div>';
  }
}

function selectRoom(el) {
  document.querySelectorAll('.room-entry').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');

  const code = el.dataset.code;
  const pass = el.dataset.pass;
  const isOpen = el.dataset.open === 'true';

  selectedRoom = { code, pass, isOpen };

  document.getElementById('joinCode').value = code;

  if (isOpen) {
    document.getElementById('joinPassGroup').style.display = 'none';
    document.getElementById('joinPass').value = '';
  } else {
    document.getElementById('joinPassGroup').style.display = '';
    document.getElementById('joinPass').value = '';
    document.getElementById('joinPass').focus();
  }
}

// ─── PEER SETUP ───────────────────────────────────────────────────────────────
function createPeer(onReady) {
  const peer = new Peer(undefined, {
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
      ],
      sdpSemantics: 'unified-plan',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    }
  });

  peer.on('open', (id) => {
    state.myPeerId = id;
    setStatus('Conectado', true);
    onReady(id);
  });

  peer.on('error', (err) => {
    console.error('PeerJS error:', err.type, err);
    if (err.type === 'peer-unavailable') {
      toast('No se pudo alcanzar al admin. ¿Está en línea?', 'error');
    } else {
      toast('Error de red: ' + err.type, 'error');
    }
    setStatus('Error');
  });

  peer.on('disconnected', () => {
    setStatus('Reconectando...');
    setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 2000);
  });

  return peer;
}

// ─── BITRATE BOOSTING ─────────────────────────────────────────────────────────
async function boostBitrate(call, isScreen) {
  // Give the connection a moment to initialize
  await new Promise(r => setTimeout(r, 800));
  try {
    const pc = call.peerConnection;
    if (!pc) return;
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (!sender.track) continue;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      if (sender.track.kind === 'video' && isScreen) {
        params.encodings[0].maxBitrate = BITRATE.screen.video;
        params.encodings[0].maxFramerate = 60;
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';
        // Prefer detail over motion smoothness
        sender.track.contentHint = 'detail';
      } else if (sender.track.kind === 'audio') {
        params.encodings[0].maxBitrate = isScreen
          ? BITRATE.screen.audio
          : BITRATE.audio.audio;
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';
      }
      await sender.setParameters(params).catch(e => console.warn('setParameters:', e));
    }
  } catch (e) {
    console.warn('boostBitrate failed:', e);
  }
}

// ─── ADMIN: CREATE ROOM ────────────────────────────────────────────────────────
async function createRoom() {
  const roomName = document.getElementById('createRoomName').value.trim();
  const adminName = document.getElementById('createAdminName').value.trim();
  const noPass = document.getElementById('createNoPass').checked;
  const roomPass = noPass ? '' : document.getElementById('createRoomPass').value.trim();

  if (!roomName || !adminName) {
    toast('Completa el nombre de sala y tu nombre', 'error');
    return;
  }
  if (!noPass && !roomPass) {
    toast('Ingresa una contraseña o activa "sin contraseña"', 'error');
    return;
  }

  hideModal('createModal');
  setStatus('Iniciando...', false);
  toast('Creando sala...', 'info');

  const code = genCode();
  state.role = 'admin';
  state.roomCode = code;
  state.roomPass = roomPass;
  state.roomName = roomName;
  state.myName = adminName;

  state.peer = createPeer(async (peerId) => {
    await saveRoom(code, {
      name: roomName,
      pass: roomPass,
      adminPeerId: peerId,
    });
    setupAdminListeners();
    renderAdminScreen();
    toast('¡Sala creada! Comparte el código con tus participantes.', 'success');
  });
}

// ─── ADMIN: LISTENERS ─────────────────────────────────────────────────────────
function setupAdminListeners() {
  state.peer.on('connection', (conn) => {
    conn.on('open', () => {
      conn.on('data', (data) => {
        if (data.type === 'join') {
          const needsPass = !!state.roomPass;
          if (needsPass && data.pass !== state.roomPass) {
            conn.send({ type: 'rejected', reason: 'Contraseña incorrecta' });
            conn.close();
            return;
          }

          const listenerId = conn.peer;
          state.connections[listenerId] = conn;
          state.participants.push({ name: data.name, peerId: listenerId });
          renderParticipants();
          updateListenerCount();

          conn.send({
            type: 'accepted',
            roomName: state.roomName,
            sharingScreen: state.sharingScreen,
          });

          const activeStream = state.screenStream || state.audioStream;
          if (activeStream) callListener(listenerId, activeStream);

          toast(`${escHtml(data.name)} se unió 🎧`, 'success');
        }
      });

      conn.on('close', () => {
        const idx = state.participants.findIndex(p => p.peerId === conn.peer);
        if (idx >= 0) {
          toast(`${escHtml(state.participants[idx].name)} salió`);
          state.participants.splice(idx, 1);
        }
        delete state.connections[conn.peer];
        if (state.calls[conn.peer]) {
          try { state.calls[conn.peer].close(); } catch (e) {}
          delete state.calls[conn.peer];
        }
        renderParticipants();
        updateListenerCount();
      });
    });
  });
}

function callListener(peerId, stream) {
  if (!state.calls[peerId]) {
    try { state.calls[peerId].close(); } catch (e) {}
  }
  try {
    const call = state.peer.call(peerId, stream);
    state.calls[peerId] = call;
    const isScreen = state.sharingScreen;
    boostBitrate(call, isScreen);
    call.on('error', e => console.warn('Call error:', e));
    call.on('close', () => delete state.calls[peerId]);
  } catch (e) { console.warn('Error calling listener:', e); }
}

function callAllListeners(stream) {
  Object.keys(state.connections).forEach(pid => callListener(pid, stream));
}

function broadcastStreamType(type) {
  Object.values(state.connections).forEach(conn => {
    try { conn.send({ type: 'streamType', streamType: type }); } catch (e) {}
  });
}

// ─── ADMIN: RENDER ────────────────────────────────────────────────────────────
function renderAdminScreen() {
  document.getElementById('adminRoomName').textContent = state.roomName;
  document.getElementById('adminRoomCode').textContent = state.roomCode;
  document.getElementById('shareCode').textContent = state.roomCode;

  const noPass = !state.roomPass;
  document.getElementById('adminPassBadge').style.display = noPass ? '' : 'none';
  document.getElementById('sharePassLine').style.display = noPass ? 'none' : '';
  document.getElementById('sharePass').textContent = state.roomPass;

  updateListenerCount();
  renderParticipants();
  showScreen('adminScreen');
}

function updateListenerCount() {
  const n = state.participants.length;
  document.getElementById('listenerCount').textContent = `${n} oyente${n !== 1 ? 's' : ''}`;
}

function renderParticipants() {
  const list = document.getElementById('participantsList');
  if (state.participants.length === 0) {
    list.innerHTML = `<div style="color:var(--muted);font-size:0.83rem;text-align:center;padding:14px">Esperando participantes...</div>`;
    return;
  }
  list.innerHTML = state.participants.map(p => `
    <div class="participant listening">
      <div class="participant-avatar">${escHtml(p.name[0].toUpperCase())}</div>
      <div class="participant-name">${escHtml(p.name)}</div>
      <div class="participant-role">🎧 Escuchando</div>
    </div>
  `).join('');
}

function copyRoomInfo() {
  const passLine = state.roomPass ? `\nContraseña: ${state.roomPass}` : '\n🔓 Sin contraseña';
  const text = `🔊 SyncSound\nSala: ${state.roomName}\nCódigo: ${state.roomCode}${passLine}\n\nAbre la app → "Unirse" y usa estos datos.`;
  navigator.clipboard.writeText(text)
    .then(() => toast('¡Datos copiados al portapapeles!', 'success'))
    .catch(() => toast('No se pudo copiar automáticamente.', 'error'));
}

// ─── ADMIN: AUDIO SOURCES ─────────────────────────────────────────────────────

// High-quality audio constraints for system audio / tab capture
const AUDIO_HIFI = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: 48000,
  sampleSize: 16,
  channelCount: 2,
};

// Mic constraints (some processing helps here)
const AUDIO_MIC = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  sampleRate: 48000,
  sampleSize: 16,
  channelCount: 1,
};

async function shareTabAudio() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1, frameRate: 1 }, // minimal video just to get audio
      audio: AUDIO_HIFI,
      systemAudio: 'include',       // Chrome 105+
      selfBrowserSurface: 'exclude',
    });

    // Drop the dummy video track
    stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });

    if (stream.getAudioTracks().length === 0) {
      toast('⚠️ No se capturó audio. Activa "compartir audio del sistema" en el diálogo.', 'error');
      return;
    }

    setAudioStream(stream, 'tab', '🌐 Audio de pestaña / sistema');
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      toast('Error: ' + err.message, 'error');
    }
  }
}

async function shareMicAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_MIC });
    setAudioStream(stream, 'mic', '🎤 Micrófono');
  } catch (err) {
    toast('Error al acceder al micrófono: ' + err.message, 'error');
  }
}

// ─── ADMIN: SCREEN SHARE ──────────────────────────────────────────────────────
async function shareScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 60, max: 60 },
        width:  { ideal: 3840, max: 3840 }, // 4K if available, else 1080p
        height: { ideal: 2160, max: 2160 },
        displaySurface: 'monitor',          // prefer full screen
        logicalSurface: true,
      },
      audio: AUDIO_HIFI,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    });

    // Set content hint for crisp text/UI (not motion)
    stream.getVideoTracks().forEach(t => {
      t.contentHint = 'detail';
    });

    state.sharingScreen = true;
    state.screenStream = stream;

    if (state.audioStream) {
      state.audioStream.getTracks().forEach(t => t.stop());
      state.audioStream = null;
    }

    Object.values(state.calls).forEach(c => { try { c.close(); } catch (e) {} });
    state.calls = {};

    // Local preview
    const previewWrap = document.getElementById('adminScreenPreview');
    const previewVid = document.getElementById('adminPreviewVideo');
    previewVid.srcObject = stream;
    previewVid.play().catch(e => console.warn(e));
    previewWrap.style.display = 'block';

    // UI
    const hasAudio = stream.getAudioTracks().length > 0;
    const vt = stream.getVideoTracks()[0];
    const s = vt?.getSettings?.() || {};
    document.getElementById('adminAudioTitle').textContent =
      '🖥️ Pantalla compartida' + (hasAudio ? ' (con audio)' : ' (sin audio)');
    document.getElementById('adminAudioSub').textContent = hasAudio
      ? `Video ${s.width || '?'}×${s.height || '?'} @ ${s.frameRate?.toFixed(0) || '?'}fps + audio HiFi`
      : 'Solo video. Activa "compartir audio de pestaña" para incluir sonido.';
    document.getElementById('adminAudioIcon').textContent = '🖥️';
    document.getElementById('adminVisualizer').classList.remove('paused');
    document.getElementById('btnStopAudio').disabled = false;
    document.getElementById('btnShareScreen').classList.add('active-source');
    document.getElementById('adminAudioStatus').classList.add('active');

    showQualityChips(stream, true);

    // Stop via browser UI
    stream.getVideoTracks()[0].onended = () => {
      if (state.screenStream === stream) stopAudio();
    };

    callAllListeners(stream);
    broadcastStreamType('screen');
    toast('🖥️ Pantalla compartida — máxima calidad', 'success');
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      toast('Error al compartir pantalla: ' + err.message, 'error');
    }
  }
}

function setAudioStream(stream, source, label) {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
    state.sharingScreen = false;
    document.getElementById('adminScreenPreview').style.display = 'none';
    document.getElementById('adminPreviewVideo').srcObject = null;
    document.getElementById('btnShareScreen').classList.remove('active-source');
  }

  if (state.audioStream) {
    state.audioStream.getTracks().forEach(t => t.stop());
  }
  Object.values(state.calls).forEach(c => { try { c.close(); } catch (e) {} });
  state.calls = {};

  state.audioStream = stream;
  state.mediaSource = source;
  state.sharingScreen = false;

  stream.getTracks().forEach(track => {
    track.onended = () => { if (state.audioStream === stream) stopAudio(); };
  });

  document.getElementById('adminAudioTitle').textContent = label;
  const at = stream.getAudioTracks()[0];
  const s = at?.getSettings?.() || {};
  document.getElementById('adminAudioSub').textContent =
    `${s.sampleRate ? (s.sampleRate / 1000).toFixed(0) + ' kHz' : '48 kHz'} · ${s.channelCount === 2 ? 'Estéreo' : 'Mono'} · 320 kbps`;
  document.getElementById('adminAudioIcon').textContent = source === 'mic' ? '🎤' : '🌐';
  document.getElementById('adminVisualizer').classList.remove('paused');
  document.getElementById('btnStopAudio').disabled = false;
  document.getElementById('adminAudioStatus').classList.add('active');
  showQualityChips(stream, false);

  callAllListeners(stream);
  broadcastStreamType('audio');
  toast('🔴 Audio HiFi en vivo — todos escuchan', 'success');
}

function showQualityChips(stream, isScreen) {
  const row = document.getElementById('qualityRow');
  row.style.display = 'flex';

  if (isScreen) {
    const vt = stream.getVideoTracks()[0];
    const s = vt?.getSettings?.() || {};
    document.getElementById('qFps').textContent = `⚡ ${s.frameRate?.toFixed(0) || 60} fps`;
    document.getElementById('qRes').textContent = `📐 ${s.width || '?'}×${s.height || '?'}`;
    document.getElementById('qFps').className = 'q-chip active';
    document.getElementById('qRes').className = 'q-chip active';
  } else {
    document.getElementById('qFps').style.display = 'none';
    document.getElementById('qRes').style.display = 'none';
  }

  const at = stream.getAudioTracks()[0];
  if (at) {
    const s = at.getSettings?.() || {};
    const khz = s.sampleRate ? (s.sampleRate / 1000).toFixed(0) : 48;
    const ch = s.channelCount === 2 ? 'Estéreo' : 'Mono';
    document.getElementById('qAudio').textContent = `🎵 ${khz} kHz ${ch} 320 kbps`;
    document.getElementById('qAudio').className = 'q-chip active';
    document.getElementById('qAudio').style.display = '';
  }
}

function stopAudio() {
  clearInterval(state.statsInterval);
  state.statsInterval = null;

  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
    state.screenStream = null;
    state.sharingScreen = false;
    document.getElementById('adminScreenPreview').style.display = 'none';
    document.getElementById('adminPreviewVideo').srcObject = null;
    document.getElementById('btnShareScreen').classList.remove('active-source');
  }
  if (state.audioStream) {
    state.audioStream.getTracks().forEach(t => t.stop());
    state.audioStream = null;
  }
  Object.values(state.calls).forEach(c => { try { c.close(); } catch (e) {} });
  state.calls = {};

  document.getElementById('adminAudioTitle').textContent = 'Sin transmisión activa';
  document.getElementById('adminAudioSub').textContent = 'Elige una fuente para empezar';
  document.getElementById('adminAudioIcon').textContent = '🔇';
  document.getElementById('adminVisualizer').classList.add('paused');
  document.getElementById('btnStopAudio').disabled = true;
  document.getElementById('adminAudioStatus').classList.remove('active');
  document.getElementById('qualityRow').style.display = 'none';

  broadcastStreamType('stopped');
  toast('Transmisión detenida');
}

// ─── LISTENER: JOIN ───────────────────────────────────────────────────────────
async function joinRoom() {
  const name = document.getElementById('joinName').value.trim();
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const passInput = document.getElementById('joinPass').value.trim();

  if (!name || !code) {
    toast('Ingresa tu nombre y el código de sala', 'error');
    return;
  }

  hideModal('joinModal');
  setStatus('Buscando sala...', false);
  toast('Buscando sala...', 'info');

  const room = await getRoom(code);
  if (!room) {
    toast('Sala no encontrada. Verifica el código.', 'error');
    openJoinModal();
    setStatus('Listo', false);
    return;
  }

  // Password check — if room has no pass, skip
  const needsPass = !!room.pass;
  if (needsPass && passInput !== room.pass) {
    toast('Contraseña incorrecta', 'error');
    openJoinModal();
    setStatus('Listo', false);
    return;
  }

  state.role = 'listener';
  state.roomCode = code;
  state.roomName = room.name;
  state.roomPass = room.pass || '';
  state.myName = name;
  state.adminPeerId = room.adminPeerId;

  setStatus('Conectando...', false);

  state.peer = createPeer((myPeerId) => {
    const conn = state.peer.connect(state.adminPeerId, {
      reliable: true,
      serialization: 'json',
    });

    let connected = false;
    const timeout = setTimeout(() => {
      if (!connected) {
        toast('No se pudo conectar al admin. ¿Está en línea?', 'error');
        leaveRoom();
      }
    }, 15000);

    conn.on('open', () => {
      connected = true;
      clearTimeout(timeout);
      conn.send({ type: 'join', name, pass: passInput });
    });

    conn.on('data', (data) => {
      if (data.type === 'accepted') {
        setupListenerAudio(data.sharingScreen);
        renderListenerScreen();
        toast('¡Conectado! Esperando transmisión del admin...', 'success');
      } else if (data.type === 'rejected') {
        toast('Rechazado: ' + data.reason, 'error');
        leaveRoom();
      } else if (data.type === 'streamType') {
        handleStreamTypeChange(data.streamType);
      }
    });

    conn.on('close', () => {
      if (state.role === 'listener') {
        toast('El admin cerró la sala', 'error');
        leaveRoom();
      }
    });

    conn.on('error', (err) => { toast('Error de conexión: ' + err, 'error'); });
  });
}

function handleStreamTypeChange(streamType) {
  if (streamType === 'screen') {
    document.getElementById('listenerAudioTitle').textContent = '🖥️ Pantalla compartida';
    document.getElementById('listenerAudioSub').textContent = 'El admin está compartiendo su pantalla';
    document.getElementById('listenerIcon').textContent = '🖥️';
  } else if (streamType === 'audio') {
    document.getElementById('listenerAudioTitle').textContent = '🎶 Audio HiFi en vivo';
    document.getElementById('listenerAudioSub').textContent = 'Recibiendo audio de alta calidad en tiempo real';
    document.getElementById('listenerIcon').textContent = '🔊';
    const sc = document.getElementById('listenerScreenContainer');
    if (sc) sc.style.display = 'none';
  } else if (streamType === 'stopped') {
    document.getElementById('listenerAudioTitle').textContent = 'Transmisión pausada';
    document.getElementById('listenerAudioSub').textContent = 'El admin detuvo la transmisión';
    document.getElementById('listenerIcon').textContent = '⏸️';
    document.getElementById('listenerVisualizer').classList.add('paused');
    const sc = document.getElementById('listenerScreenContainer');
    if (sc) sc.style.display = 'none';
  }
}

function setupListenerAudio() {
  state.peer.on('call', (call) => {
    call.answer();

    call.on('stream', (remoteStream) => {
      state.remoteStream = remoteStream;
      const hasVideo = remoteStream.getVideoTracks().length > 0;

      if (hasVideo) {
        showRemoteScreen(remoteStream);
      } else {
        const audio = document.getElementById('remoteAudio');
        audio.srcObject = remoteStream;
        audio.volume = document.getElementById('volumeSlider').value / 100;
        audio.play().catch(() => {
          toast('👆 Toca para activar el audio', 'info');
          document.addEventListener('click', () => audio.play().catch(e => console.warn(e)), { once: true });
        });
        const sc = document.getElementById('listenerScreenContainer');
        if (sc) sc.style.display = 'none';
      }

      document.getElementById('listenerAudioTitle').textContent = hasVideo ? '🖥️ Pantalla compartida' : '🎶 Audio HiFi en vivo';
      document.getElementById('listenerAudioSub').textContent = hasVideo
        ? 'Recibiendo pantalla del admin en tiempo real'
        : 'Audio 48 kHz · 320 kbps en tiempo real';
      document.getElementById('listenerIcon').textContent = hasVideo ? '🖥️' : '🔊';
      document.getElementById('listenerVisualizer').classList.remove('paused');
      document.getElementById('listenerAudioStatus').classList.add('active');
    });

    call.on('close', () => {
      document.getElementById('listenerAudioTitle').textContent = 'Transmisión pausada';
      document.getElementById('listenerAudioSub').textContent = 'El admin detuvo la transmisión';
      document.getElementById('listenerIcon').textContent = '⏸️';
      document.getElementById('listenerVisualizer').classList.add('paused');
      document.getElementById('listenerAudioStatus').classList.remove('active');
      const sc = document.getElementById('listenerScreenContainer');
      if (sc) sc.style.display = 'none';
    });
  });
}

function showRemoteScreen(stream) {
  let sc = document.getElementById('listenerScreenContainer');

  if (!sc) {
    sc = document.createElement('div');
    sc.id = 'listenerScreenContainer';
    sc.className = 'screen-container';
    sc.innerHTML = `
      <div class="screen-header">
        <span class="screen-label">🖥️ Pantalla del admin</span>
        <div class="screen-actions">
          <button class="icon-btn" onclick="toggleFullscreen()" title="Pantalla completa">⛶</button>
        </div>
      </div>
      <video id="remoteScreenVideo" autoplay playsinline muted></video>
    `;
    const panel = document.querySelector('#listenerScreen .panel');
    panel.appendChild(sc);
  }

  sc.style.display = 'block';
  const vid = document.getElementById('remoteScreenVideo');
  vid.srcObject = stream;
  vid.play().catch(e => console.warn(e));

  // Route audio through audio element too
  const audio = document.getElementById('remoteAudio');
  audio.srcObject = stream;
  audio.volume = document.getElementById('volumeSlider').value / 100;
  audio.play().catch(() => {
    document.addEventListener('click', () => audio.play().catch(e => console.warn(e)), { once: true });
  });
}

function toggleFullscreen() {
  const vid = document.getElementById('remoteScreenVideo');
  if (!vid) return;
  if (!document.fullscreenElement) {
    vid.requestFullscreen().catch(() => toast('No se pudo activar pantalla completa', 'error'));
  } else {
    document.exitFullscreen();
  }
}

function renderListenerScreen() {
  document.getElementById('listenerRoomName').textContent = state.roomName;
  document.getElementById('listenerRoomCode').textContent = state.roomCode;
  showScreen('listenerScreen');
}

function setVolume(val) {
  document.getElementById('volumeVal').textContent = val + '%';
  const audio = document.getElementById('remoteAudio');
  if (audio) audio.volume = val / 100;
  const vid = document.getElementById('remoteScreenVideo');
  // video is muted, audio goes through <audio>
}

// ─── LEAVE / CLEANUP ──────────────────────────────────────────────────────────
function leaveRoom() {
  clearInterval(state.statsInterval);
  const wasAdmin = state.role === 'admin';
  const code = state.roomCode;

  if (state.audioStream) state.audioStream.getTracks().forEach(t => t.stop());
  if (state.screenStream) state.screenStream.getTracks().forEach(t => t.stop());
  Object.values(state.calls).forEach(c => { try { c.close(); } catch (e) {} });
  Object.values(state.connections).forEach(c => { try { c.close(); } catch (e) {} });
  if (state.peer) { try { state.peer.destroy(); } catch (e) {} }
  if (wasAdmin && code) removeRoom(code);

  Object.assign(state, {
    role: null, roomCode: null, roomPass: null, roomName: null,
    myName: null, peer: null, connections: {}, audioStream: null,
    screenStream: null, mediaSource: null, calls: {}, remoteStream: null,
    participants: [], myPeerId: null, adminPeerId: null, sharingScreen: false,
    statsInterval: null,
  });

  const audio = document.getElementById('remoteAudio');
  if (audio) audio.srcObject = null;

  const sc = document.getElementById('listenerScreenContainer');
  if (sc) sc.remove();

  setStatus('Listo', false);
  showScreen('homeScreen');
  toast(wasAdmin ? 'Sala cerrada' : 'Saliste de la sala');
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

window.addEventListener('beforeunload', () => {
  if (state.role === 'admin' && state.roomCode) removeRoom(state.roomCode);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
  }
  if (e.key === 'Enter') {
    if (document.getElementById('createModal').classList.contains('open')) createRoom();
    if (document.getElementById('joinModal').classList.contains('open')) joinRoom();
  }
});
