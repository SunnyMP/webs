/*
  SyncSound — Audio sharing via WebRTC + Firebase signaling
  
  Señalización: Firebase Realtime Database (gratis, sin cuenta requerida
  para el usuario — usa el proyecto público de la app)
  
  Transporte de audio: WebRTC via PeerJS (peer-to-peer)
  
  Funciona entre DISTINTOS dispositivos y redes.
*/

// ─── FIREBASE CONFIG (base de datos pública para señalización) ────────────────
https://syncsound-f06ec-default-rtdb.firebaseio.com/let useFirebase = true;

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
  mediaSource: null,
  calls: {},
  remoteStream: null,
  participants: [],
  myPeerId: null,
  adminPeerId: null,
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

          conn.send({ type: 'accepted', roomName: state.roomName });

          if (state.audioStream) callListener(listenerId);

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

function callListener(peerId) {
  if (!state.audioStream) return;
  try {
    const call = state.peer.call(peerId, state.audioStream);
    state.calls[peerId] = call;
    call.on('error', (e) => console.warn('Call error:', e));
    call.on('close', () => delete state.calls[peerId]);
  } catch(e) { console.warn('Error calling listener:', e); }
}

function callAllListeners() {
  Object.keys(state.connections).forEach(pid => callListener(pid));
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
      toast('⚠️ No se capturó audio. En el diálogo del navegador, activa "Compartir audio del sistema" o "Compartir audio de la pestaña".', 'error');
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

function setAudioStream(stream, source, label) {
  if (state.audioStream) {
    state.audioStream.getTracks().forEach(t => t.stop());
    Object.values(state.calls).forEach(c => { try { c.close(); } catch(e){} });
    state.calls = {};
  }

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

  callAllListeners();
  toast('🔴 Audio en vivo — todos los oyentes escuchan', 'success');
}

function stopAudio() {
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

  toast('Audio detenido');
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
        setupListenerAudio();
        renderListenerScreen();
        toast('¡Conectado! Esperando audio del admin...', 'success');
      } else if (data.type === 'rejected') {
        toast('Rechazado: ' + data.reason, 'error');
        leaveRoom();
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

function setupListenerAudio() {
  state.peer.on('call', (call) => {
    call.answer();

    call.on('stream', (remoteStream) => {
      state.remoteStream = remoteStream;
      const audio = document.getElementById('remoteAudio');
      audio.srcObject = remoteStream;
      audio.volume = document.getElementById('volumeSlider').value / 100;

      audio.play().catch(() => {
        toast('👆 Toca la pantalla para activar el audio', 'info');
        document.addEventListener('click', () => audio.play().catch(e => console.warn(e)), { once: true });
      });

      document.getElementById('listenerAudioTitle').textContent = '🎶 Audio en vivo';
      document.getElementById('listenerAudioSub').textContent = 'Recibiendo audio del admin en tiempo real';
      document.getElementById('listenerIcon').textContent = '🔊';
      document.getElementById('listenerVisualizer').classList.remove('paused');
    });

    call.on('close', () => {
      document.getElementById('listenerAudioTitle').textContent = 'Audio pausado';
      document.getElementById('listenerAudioSub').textContent = 'El admin detuvo el audio';
      document.getElementById('listenerIcon').textContent = '⏸️';
      document.getElementById('listenerVisualizer').classList.add('paused');
    });
  });
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
  Object.values(state.calls).forEach(c => { try { c.close(); } catch(e){} });
  Object.values(state.connections).forEach(c => { try { c.close(); } catch(e){} });
  if (state.peer) { try { state.peer.destroy(); } catch(e){} }
  if (wasAdmin && code) removeRoom(code);

  Object.assign(state, {
    role: null, roomCode: null, roomPass: null, roomName: null,
    myName: null, peer: null, connections: {}, audioStream: null,
    mediaSource: null, calls: {}, remoteStream: null,
    participants: [], myPeerId: null, adminPeerId: null,
  });

  const audio = document.getElementById('remoteAudio');
  if (audio) audio.srcObject = null;

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
