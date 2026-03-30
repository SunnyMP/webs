const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const AdmZip   = require('adm-zip');
const { v4: uuid } = require('uuid');
const bcrypt   = require('bcryptjs');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

const UPLOADS = path.join(__dirname, 'uploads');
const DATA    = path.join(__dirname, 'data.json');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

function load() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch { return { modpacks: [], news: [] }; }
}
function save(d) { fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }

app.use(cors({
  origin: ['https://luncher.jolty.us', 'http://localhost:3001', 'http://localhost:3000'],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-pack-password'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Panel admin — acceso directo, sin contraseña
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── MULTER ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, ['.mrpack','.zip','.png','.jpg','.jpeg','.gif','.webp','.mp4','.webm'].includes(ext));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
const packUpload = upload.fields([{name:'file',maxCount:1},{name:'banner',maxCount:1},{name:'icon',maxCount:1}]);
const newsUpload = upload.single('media');

// ── MODPACKS PUBLIC API (launcher) ───────────────────────────────────────────
app.get('/api/modpacks', (req, res) => {
  const { modpacks } = load();
  res.json({ success:true, modpacks: modpacks.filter(m=>!m.hidden).map(m=>({...m,passwordHash:undefined})) });
});

app.post('/api/modpacks/:id/unlock', (req, res) => {
  const { modpacks } = load();
  const mp = modpacks.find(m => m.id === req.params.id);
  if (!mp) return res.status(404).json({ error:'No encontrado' });
  if (!mp.passwordHash) return res.json({ success:true });
  res.json({ success: bcrypt.compareSync(req.body.password || '', mp.passwordHash) });
});

app.get('/api/modpacks/:id/download', (req, res) => {
  const { modpacks } = load();
  const mp = modpacks.find(m => m.id === req.params.id);
  if (!mp) return res.status(404).json({ error:'No encontrado' });
  if (mp.passwordHash) {
    const ok = bcrypt.compareSync(req.query.password || req.headers['x-pack-password'] || '', mp.passwordHash);
    if (!ok) return res.status(403).json({ error:'Contraseña incorrecta' });
  }
  const f = path.join(UPLOADS, mp.filename);
  if (!fs.existsSync(f)) return res.status(404).json({ error:'Archivo no encontrado' });
  res.download(f, mp.name + '.mrpack');
});

// ── MODPACKS ADMIN API (sin auth) ─────────────────────────────────────────────
app.post('/api/modpacks/upload', packUpload, async (req, res) => {
  try {
    const mrpackFile = req.files?.file?.[0];
    if (!mrpackFile) return res.status(400).json({ error:'Sin archivo .mrpack' });
    const name     = req.body.name || path.basename(mrpackFile.originalname, '.mrpack');
    const password = req.body.password?.trim() || null;
    const hidden   = req.body.hidden === 'true';
    const category = req.body.category?.trim() || null;

    let mcVersion='?', loader='Fabric', modsCount=0, iconB64=null;
    try {
      const zip = new AdmZip(mrpackFile.path);
      const idx = zip.getEntry('modrinth.index.json');
      if (idx) {
        const d = JSON.parse(idx.getData().toString('utf8'));
        mcVersion = d.dependencies?.minecraft || '?';
        if (d.dependencies?.['fabric-loader']) loader='Fabric';
        else if (d.dependencies?.forge) loader='Forge';
        else if (d.dependencies?.['quilt-loader']) loader='Quilt';
        else if (d.dependencies?.neoforge) loader='NeoForge';
        modsCount = d.files?.length || 0;
      }
      if (!req.files?.icon) {
        const iconE = zip.getEntry('icon.png') || zip.getEntry('pack.png');
        if (iconE) iconB64 = 'data:image/png;base64,' + iconE.getData().toString('base64');
      }
    } catch(e) { console.warn('Parse mrpack:', e.message); }

    const toB64 = (f) => {
      const buf = fs.readFileSync(f.path);
      const ext = path.extname(f.originalname).toLowerCase();
      const mime = ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.gif'?'image/gif':ext==='.webp'?'image/webp':'image/png';
      fs.unlinkSync(f.path);
      return `data:${mime};base64,`+buf.toString('base64');
    };

    const mp = {
      id:uuid(), name, filename:mrpackFile.filename,
      mcVersion, loader, modsCount, category,
      icon: req.files?.icon?.[0] ? toB64(req.files.icon[0]) : iconB64,
      banner: req.files?.banner?.[0] ? toB64(req.files.banner[0]) : null,
      hidden:!!hidden, password:!!password,
      passwordHash: password ? bcrypt.hashSync(password,10) : null,
      size:mrpackFile.size, uploadedAt:new Date().toISOString()
    };
    const data = load(); data.modpacks.push(mp); save(data);
    res.json({ success:true, modpack:{...mp,passwordHash:undefined} });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/modpacks/:id', upload.fields([{name:'banner',maxCount:1},{name:'icon',maxCount:1}]), async (req, res) => {
  const data = load();
  const mp = data.modpacks.find(m => m.id === req.params.id);
  if (!mp) return res.status(404).json({ error:'No encontrado' });
  if (req.body.name) mp.name = req.body.name;
  if (req.body.hidden !== undefined) mp.hidden = req.body.hidden === 'true';
  if (req.body.category !== undefined) mp.category = req.body.category || null;
  if (req.body.password !== undefined) {
    if (req.body.password) { mp.password=true; mp.passwordHash=bcrypt.hashSync(req.body.password,10); }
    else { mp.password=false; mp.passwordHash=null; }
  }
  const toB64=(f)=>{const buf=fs.readFileSync(f.path);const ext=path.extname(f.originalname).toLowerCase();const mime=ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.gif'?'image/gif':ext==='.webp'?'image/webp':'image/png';fs.unlinkSync(f.path);return `data:${mime};base64,`+buf.toString('base64');};
  if (req.files?.banner?.[0]) mp.banner = toB64(req.files.banner[0]);
  if (req.files?.icon?.[0]) mp.icon = toB64(req.files.icon[0]);
  save(data);
  res.json({ success:true, modpack:{...mp,passwordHash:undefined} });
});

app.delete('/api/modpacks/:id', (req, res) => {
  const data = load();
  const mp = data.modpacks.find(m => m.id === req.params.id);
  if (!mp) return res.status(404).json({ error:'No encontrado' });
  const f = path.join(UPLOADS, mp.filename);
  if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
  data.modpacks = data.modpacks.filter(m => m.id !== req.params.id);
  save(data); res.json({ success:true });
});

// ── NEWS ──────────────────────────────────────────────────────────────────────
app.get('/api/news', (req, res) => {
  const { news } = load();
  res.json({ success:true, news: news||[] });
});

// Acepta JSON (legacy) o multipart con media (imagen o mp4)
app.post('/api/news', newsUpload, (req, res) => {
  const { title, body, color } = req.body;
  if (!title) return res.status(400).json({ error:'Falta título' });

  let mediaUrl = null, mediaType = null;
  if (req.file) {
    const ext = path.extname(req.file.originalname).toLowerCase();
    mediaUrl = `/uploads/${req.file.filename}`;
    mediaType = (ext==='.mp4'||ext==='.webm') ? 'video' : 'image';
  } else if (req.body.image) {
    mediaUrl = req.body.image;
    mediaType = 'image';
  }

  const data = load(); if (!data.news) data.news = [];
  const item = {
    id:uuid(), title, body:body||'', color:color||'blue',
    mediaUrl, mediaType,
    image: mediaType==='image' ? mediaUrl : null, // compat launcher viejo
    date:new Date().toISOString()
  };
  data.news.unshift(item); save(data);
  res.json({ success:true, item });
});

app.delete('/api/news/:id', (req, res) => {
  const data = load();
  const item = (data.news||[]).find(n => n.id === req.params.id);
  if (item?.mediaUrl?.startsWith('/uploads/')) {
    const f = path.join(UPLOADS, path.basename(item.mediaUrl));
    if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
  }
  data.news = (data.news||[]).filter(n => n.id !== req.params.id);
  save(data); res.json({ success:true });
});

// Servir archivos de uploads (videos/imágenes de noticias)
app.use('/uploads', express.static(UPLOADS));

// ── STATS ─────────────────────────────────────────────────────────────────────
// El launcher manda una sesión al terminar de jugar
app.post('/api/stats', (req, res) => {
  const { uuid, name, packId, packName, minutes, mcVersion, loader } = req.body;
  if (!name || !packId) return res.status(400).json({ error:'Faltan datos' });
  const data = load();
  if (!data.stats) data.stats = { players:{}, sessions:[] };
  const stats = data.stats;

  // Actualizar jugador
  const pid = uuid || name; // usar uuid si existe, sino nombre
  if (!stats.players[pid]) stats.players[pid] = { name, uuid:uuid||null, totalMinutes:0, sessions:0, packs:{}, firstSeen:new Date().toISOString() };
  stats.players[pid].totalMinutes += (minutes||0);
  stats.players[pid].sessions += 1;
  stats.players[pid].lastSeen = new Date().toISOString();
  stats.players[pid].packs[packId] = (stats.players[pid].packs[packId]||0) + 1;

  // Sesión global
  stats.sessions.unshift({ name, uuid:uuid||null, packId, packName, minutes:minutes||0, mcVersion, loader, date:new Date().toISOString() });
  if (stats.sessions.length > 500) stats.sessions.pop();

  save(data);
  res.json({ success:true });
});

// Admin: ver todas las stats
app.get('/api/stats', (req, res) => {
  const data = load();
  const stats = data.stats || { players:{}, sessions:[] };
  const players = Object.values(stats.players||{});
  const sessions = stats.sessions||[];

  // Calcular modpacks más usados globalmente
  const packCount = {};
  sessions.forEach(s => { packCount[s.packName] = (packCount[s.packName]||0)+1; });
  const topPacks = Object.entries(packCount).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,count])=>({name,count}));

  const totalMinutes = players.reduce((acc,p)=>acc+(p.totalMinutes||0),0);

  res.json({
    success:true,
    totalPlayers: players.length,
    totalSessions: sessions.length,
    totalMinutes,
    topPacks,
    players: players.sort((a,b)=>(b.totalMinutes||0)-(a.totalMinutes||0)),
    recentSessions: sessions.slice(0,20)
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 BAS CLIENT Server → http://localhost:${PORT}`);
  console.log(`📊 Admin → http://localhost:${PORT}/admin\n`);
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.post('/api/stats', (req, res) => {
  const { uuid: playerUuid, name, packId, packName, minutes, loader, mcVersion } = req.body;
  if (!name || minutes === undefined) return res.status(400).json({ error:'Faltan datos' });
  const data = load();
  if (!data.players) data.players = {};
  const key = playerUuid || name;
  if (!data.players[key]) {
    data.players[key] = { uuid:playerUuid||null, name, type:playerUuid?'microsoft':'offline', totalMinutes:0, sessions:[], firstSeen:new Date().toISOString() };
  }
  const player = data.players[key];
  player.name = name;
  player.totalMinutes = (player.totalMinutes||0) + Math.max(0, minutes);
  player.lastSeen = new Date().toISOString();
  player.lastPack = packName||packId||'?';
  player.sessions = player.sessions||[];
  player.sessions.unshift({ packId, packName, minutes, mcVersion, loader, date:new Date().toISOString() });
  if (player.sessions.length > 100) player.sessions.pop();
  save(data);
  res.json({ success:true });
});

app.get('/api/stats', (req, res) => {
  const data = load();
  const players = Object.values(data.players||{});
  players.sort((a,b) => (b.totalMinutes||0) - (a.totalMinutes||0));
  res.json({ success:true, players });
});

app.delete('/api/stats/:key', (req, res) => {
  const data = load();
  const key = req.params.key;
  if (data.players?.[key]) delete data.players[key];
  save(data); res.json({ success:true });
});
