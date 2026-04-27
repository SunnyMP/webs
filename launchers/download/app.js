/*
  SyncSound — Audio + Screen sharing via WebRTC + Firebase signaling
  Ahora con compartir pantalla (video + audio) como Discord
*/

const FB_URL = 'https://syncsound-f06ec-default-rtdb.firebaseio.com';
let useFirebase = true;

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
};

// ─── UTILS ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
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
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── ROOM STORAGE ─────────────────────────────────────────────────────────────
async function saveRoom(code, data) {
  if (useFirebase) {
    try {
      const res = await fetch(`${FB_URL}/rooms/${code}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, ts: Date.now() })
      });
      if (res.ok) return;
    } catch(e) { useFirebase = false; }
  }
  localStorage.setItem('ss_room_' + code, JSON.stringify(data));
}

async function getRoom(code) {
  if (useFirebase) {
    try {
      const res = await fetch(`${FB_URL}/rooms/${code}.json`);
      if (res.ok) {
        const data = await res.json();
        return data && data.adminPeerId ? data : null;
      }
    } catch(e) { useFirebase = false; }
  }
  const raw = localStorage.getItem('ss_room_' + code);
  return raw ? JSON.parse(raw) : null;
}

async function removeRoom(code) {
  if (useFirebase) {
    try { await fetch(`${FB_URL}/rooms/${code}.json`, { method: 'DELETE' }); } catch(e) {}
  }
  localStorage.removeItem('ss_room_' + code);
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
        { urls: 'stun:global.stun.twilio.com:3478' },
      ]
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
    setTimeout(() => { try { peer.reconnect(); } catch(e) {} }, 2000);
  });

  return peer;
}

// ─── ADMIN: CREATE ROOM ────────────────────────────────────────────────────────
async function createRoom() {
  const roomName = document.getElementById('createRoomName').value.trim();
  const adminName = document.getElementById('createAdminName').value.trim();
  const roomPass = document.getElementById('createRoomPass').value.trim();

  if (!roomName || !adminName || !roomPass) {
    toast('Completa todos los campos', 'error');
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
    toast('¡Sala creada! Comparte el código con los participantes.', 'success');
  });
}

// ─── ADMIN: SETUP LISTENERS ───────────────────────────────────────────────────
function setupAdminListeners() {
  state.peer.on('connection', (conn) => {
    conn.on('open', () => {
      conn.on('data', (data) => {
        if (data.type === 'join') {
          if (data.pass !== state.roomPass) {
            conn.send({ type: 'rejected', reason: 'Contraseña incorrecta' });
            conn.close();
            return;
          }

          const listenerId = conn.peer;
          state.connections[listenerId] = conn;
          state.participants.push({ name: data.name, peerId: listenerId });
          renderParticipants();
          updateListenerCount();

          // Notify listener: accepted + whether screen sharing is active
          conn.send({
            type: 'accepted',
            roomName: state.roomName,
            sharingScreen: state.sharingScreen,
          });

          // If already streaming, call the new listener
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
          try { state.calls[conn.peer].close(); } catch(e) {}
          delete state.calls[conn.peer];
        }
        renderParticipants();
        updateListenerCount();
      });
    });
  });
}

function callListener(peerId, stream) {
  if (!stream) return;
  // Close existing call if any
  if (state.calls[peerId]) {
    try { state.calls[peerId].close(); } catch(e) {}
  }
  try {
    const call = state.peer.call(peerId, stream);
    state.calls[peerId] = call;
    call.on('error', (e) => console.warn('Call error:', e));
    call.on('close', () => delete state.calls[peerId]);
  } catch(e) { console.warn('Error calling listener:', e); }
}

function callAllListeners(stream) {
  Object.keys(state.connections).forEach(pid => callListener(pid, stream));
}

// Notify all listeners about stream type change via data channel
function broadcastStreamType(type) {
  Object.values(state.connections).forEach(conn => {
    try { conn.send({ type: 'streamType', streamType: type }); } catch(e) {}
  });
}

// ─── ADMIN: RENDER ────────────────────────────────────────────────────────────
function renderAdminScreen() {
  document.getElementById('adminRoomName').textContent = state.roomName;
  document.getElementById('adminRoomCode').textContent = state.roomCode;
  document.getElementById('shareCode').textContent = state.roomCode;
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
    list.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;text-align:center;padding:12px">Esperando participantes...</div>`;
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
  const text = `🔊 SyncSound\nSala: ${state.roomName}\nCódigo: ${state.roomCode}\nContraseña: ${state.roomPass}\n\nAbre la app → "Unirse" y usa estos datos.`;
  navigator.clipboard.writeText(text)
    .then(() => toast('¡Datos copiados al portapapeles!', 'success'))
    .catch(() => toast('No se pudo copiar. Copia el código manualmente.', 'error'));
}

// ─── ADMIN: AUDIO ─────────────────────────────────────────────────────────────
async function shareTabAudio() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
        channelCount: 2,
      }
    });

    stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });

    if (stream.getAudioTracks().length === 0) {
      toast('⚠️ No se capturó audio. En el diálogo activa "Compartir audio del sistema".', 'error');
      return;
    }

    setAudioStream(stream, 'tab', '🌐 Audio de pestaña/app');
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      toast('Error: ' + err.message, 'error');
    }
  }
}

async function shareMicAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100,
      }
    });
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
        frameRate: { ideal: 30, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
        channelCount: 2,
      }
    });

    state.sharingScreen = true;
    state.screenStream = stream;

    // Stop previous audio-only stream if any
    if (state.audioStream) {
      state.audioStream.getTracks().forEach(t => t.stop());
      state.audioStream = null;
    }

    // Stop existing calls and restart with new stream
    Object.values(state.calls).forEach(c => { try { c.close(); } catch(e){} });
    state.calls = {};

    // Show local preview
    const preview = document.getElementById('adminScreenPreview');
    const previewVid = document.getElementById('adminPreviewVideo');
    previewVid.srcObject = stream;
    previewVid.play().catch(e => console.warn(e));
    preview.style.display = 'block';

    // Update UI
    const hasAudio = stream.getAudioTracks().length > 0;
    document.getElementById('adminAudioTitle').textContent = '🖥️ Pantalla compartida' + (hasAudio ? ' (con audio)' : ' (sin audio)');
    document.getElementById('adminAudioSub').textContent = hasAudio
      ? 'Video + audio de pantalla en vivo'
      : 'Solo video. Activa "compartir audio de pestaña" para incluir audio.';
    document.querySelector('#adminAudioStatus .audio-icon').textContent = '🖥️';
    document.getElementById('adminVisualizer').classList.remove('paused');
    document.getElementById('btnStopAudio').disabled = false;
    document.getElementById('btnShareScreen').classList.add('active-source');

    // When user stops from browser UI
    stream.getVideoTracks()[0].onended = () => {
      if (state.screenStream === stream) stopAudio();
    };

    callAllListeners(stream);
    broadcastStreamType('screen');
    toast('🖥️ Pantalla compartida — todos los oyentes ven tu pantalla', 'success');
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      toast('Error al compartir pantalla: ' + err.message, 'error');
    }
  }
}

function setAudioStream(stream, source, label) {
  // Stop screen share if active
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
  Object.values(state.calls).forEach(c => { try { c.close(); } catch(e){} });
  state.calls = {};

  state.audioStream = stream;
  state.mediaSource = source;

  stream.getTracks().forEach(track => {
    track.onended = () => {
      if (state.audioStream === stream) stopAudio();
    };
  });

  document.getElementById('adminAudioTitle').textContent = label;
  document.getElementById('adminAudioSub').textContent = 'Transmitiendo en vivo a todos los oyentes';
  document.querySelector('#adminAudioStatus .audio-icon').textContent = source === 'mic' ? '🎤' : '🌐';
  document.getElementById('adminVisualizer').classList.remove('paused');
  document.getElementById('btnStopAudio').disabled = false;

  callAllListeners(stream);
  broadcastStreamType('audio');
  toast('🔴 Audio en vivo — todos los oyentes escuchan', 'success');
}

function stopAudio() {
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
  Object.values(state.calls).forEach(c => { try { c.close(); } catch(e){} });
  state.calls = {};

  document.getElementById('adminAudioTitle').textContent = 'Sin audio activo';
  document.getElementById('adminAudioSub').textContent = 'Elige una fuente para empezar';
  document.querySelector('#adminAudioStatus .audio-icon').textContent = '🔇';
  document.getElementById('adminVisualizer').classList.add('paused');
  document.getElementById('btnStopAudio').disabled = true;

  broadcastStreamType('stopped');
  toast('Transmisión detenida');
}

// ─── LISTENER: JOIN ───────────────────────────────────────────────────────────
async function joinRoom() {
  const name = document.getElementById('joinName').value.trim();
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  const pass = document.getElementById('joinPass').value.trim();

  if (!name || !code || !pass) {
    toast('Completa todos los campos', 'error');
    return;
  }

  hideModal('joinModal');
  setStatus('Buscando sala...', false);
  toast('Buscando sala...', 'info');

  const room = await getRoom(code);
  if (!room) {
    toast('Sala no encontrada. Verifica el código.', 'error');
    showModal('joinModal');
    setStatus('Listo', false);
    return;
  }

  if (room.pass !== pass) {
    toast('Contraseña incorrecta', 'error');
    showModal('joinModal');
    setStatus('Listo', false);
    return;
  }

  state.role = 'listener';
  state.roomCode = code;
  state.roomName = room.name;
  state.roomPass = pass;
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
      conn.send({ type: 'join', name, pass });
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

    conn.on('error', (err) => {
      toast('Error de conexión: ' + err, 'error');
    });
  });
}

function handleStreamTypeChange(streamType) {
  if (streamType === 'screen') {
    document.getElementById('listenerAudioTitle').textContent = '🖥️ Pantalla compartida';
    document.getElementById('listenerAudioSub').textContent = 'El admin está compartiendo su pantalla';
    document.getElementById('listenerIcon').textContent = '🖥️';
  } else if (streamType === 'audio') {
    document.getElementById('listenerAudioTitle').textContent = '🎶 Audio en vivo';
    document.getElementById('listenerAudioSub').textContent = 'Recibiendo audio del admin en tiempo real';
    document.getElementById('listenerIcon').textContent = '🔊';
    // Hide screen if was showing
    const screenContainer = document.getElementById('listenerScreenContainer');
    if (screenContainer) screenContainer.style.display = 'none';
  } else if (streamType === 'stopped') {
    document.getElementById('listenerAudioTitle').textContent = 'Audio pausado';
    document.getElementById('listenerAudioSub').textContent = 'El admin detuvo la transmisión';
    document.getElementById('listenerIcon').textContent = '⏸️';
    document.getElementById('listenerVisualizer').classList.add('paused');
    const screenContainer = document.getElementById('listenerScreenContainer');
    if (screenContainer) screenContainer.style.display = 'none';
  }
}

function setupListenerAudio(sharingScreen) {
  state.peer.on('call', (call) => {
    call.answer();

    call.on('stream', (remoteStream) => {
      state.remoteStream = remoteStream;
      const hasVideo = remoteStream.getVideoTracks().length > 0;

      if (hasVideo) {
        // Show video element
        showRemoteScreen(remoteStream);
      } else {
        // Audio only
        const audio = document.getElementById('remoteAudio');
        audio.srcObject = remoteStream;
        audio.volume = document.getElementById('volumeSlider').value / 100;
        audio.play().catch(() => {
          toast('👆 Toca la pantalla para activar el audio', 'info');
          document.addEventListener('click', () => audio.play().catch(e => console.warn(e)), { once: true });
        });
        const screenContainer = document.getElementById('listenerScreenContainer');
        if (screenContainer) screenContainer.style.display = 'none';
      }

      document.getElementById('listenerAudioTitle').textContent = hasVideo ? '🖥️ Pantalla compartida' : '🎶 Audio en vivo';
      document.getElementById('listenerAudioSub').textContent = hasVideo
        ? 'Recibiendo pantalla del admin en tiempo real'
        : 'Recibiendo audio del admin en tiempo real';
      document.getElementById('listenerIcon').textContent = hasVideo ? '🖥️' : '🔊';
      document.getElementById('listenerVisualizer').classList.remove('paused');
    });

    call.on('close', () => {
      document.getElementById('listenerAudioTitle').textContent = 'Audio pausado';
      document.getElementById('listenerAudioSub').textContent = 'El admin detuvo la transmisión';
      document.getElementById('listenerIcon').textContent = '⏸️';
      document.getElementById('listenerVisualizer').classList.add('paused');
      const screenContainer = document.getElementById('listenerScreenContainer');
      if (screenContainer) screenContainer.style.display = 'none';
    });
  });
}

function showRemoteScreen(stream) {
  let screenContainer = document.getElementById('listenerScreenContainer');

  if (!screenContainer) {
    // Create the screen container dynamically
    screenContainer = document.createElement('div');
    screenContainer.id = 'listenerScreenContainer';
    screenContainer.className = 'screen-container';
    screenContainer.innerHTML = `
      <div class="screen-header">
        <span class="screen-label">🖥️ Pantalla del admin</span>
        <button class="fullscreen-btn" onclick="toggleFullscreen()" title="Pantalla completa">⛶</button>
      </div>
      <video id="remoteScreenVideo" autoplay playsinline muted></video>
    `;

    // Insert after the audio-status div inside listener panel
    const audioPanel = document.querySelector('#listenerScreen .panel');
    audioPanel.appendChild(screenContainer);
  }

  screenContainer.style.display = 'block';
  const vid = document.getElementById('remoteScreenVideo');
  vid.srcObject = stream;
  vid.play().catch(e => console.warn(e));

  // Also play audio through the audio element (PeerJS merges tracks)
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
    vid.requestFullscreen().catch(e => toast('No se pudo activar pantalla completa', 'error'));
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
}

// ─── LEAVE / CLEANUP ──────────────────────────────────────────────────────────
function leaveRoom() {
  const wasAdmin = state.role === 'admin';
  const code = state.roomCode;

  if (state.audioStream) state.audioStream.getTracks().forEach(t => t.stop());
  if (state.screenStream) state.screenStream.getTracks().forEach(t => t.stop());
  Object.values(state.calls).forEach(c => { try { c.close(); } catch(e){} });
  Object.values(state.connections).forEach(c => { try { c.close(); } catch(e){} });
  if (state.peer) { try { state.peer.destroy(); } catch(e){} }
  if (wasAdmin && code) removeRoom(code);

  Object.assign(state, {
    role: null, roomCode: null, roomPass: null, roomName: null,
    myName: null, peer: null, connections: {}, audioStream: null,
    screenStream: null, mediaSource: null, calls: {}, remoteStream: null,
    participants: [], myPeerId: null, adminPeerId: null, sharingScreen: false,
  });

  const audio = document.getElementById('remoteAudio');
  if (audio) audio.srcObject = null;

  // Remove dynamic screen container if exists
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
