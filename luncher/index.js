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
const PASS = process.env.ADMIN_PASS || 'bas2024';

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
  allowedHeaders: ['Content-Type','x-admin-token','x-pack-password'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rutas limpias sin .html
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function auth(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t === PASS) return next();
  res.status(401).json({ error: 'No autorizado' });
}

const storage = multer.diskStorage({
  destination: UPLOADS,
  filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
const packUpload = upload.fields([{ name:'file', maxCount:1 }, { name:'banner', maxCount:1 }, { name:'icon', maxCount:1 }]);

// ── MODPACKS PUBLIC API ────────────────────────────────────────────────────────
// Launcher: only non-hidden packs
app.get('/api/modpacks', (req, res) => {
  const { modpacks } = load();
  const isAdmin = req.headers['x-admin-token'] === PASS;
  const visible = isAdmin ? modpacks : modpacks.filter(m => !m.hidden);
  res.json({ success:true, modpacks: visible.map(m => ({ ...m, passwordHash:undefined })) });
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

// ── MODPACKS ADMIN API ────────────────────────────────────────────────────────
app.post('/api/modpacks/upload', auth, packUpload, async (req, res) => {
  try {
    const mrpackFile = req.files?.file?.[0];
    if (!mrpackFile) return res.status(400).json({ error:'Sin archivo .mrpack' });
    const name     = req.body.name || path.basename(mrpackFile.originalname, '.mrpack');
    const password = req.body.password?.trim() || null;
    const hidden   = req.body.hidden === 'true';

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
    } catch(e) { console.warn('Parse:', e.message); }

    const toB64 = (f) => {
      const buf = fs.readFileSync(f.path);
      const ext = path.extname(f.originalname).toLowerCase();
      const mime = ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.gif'?'image/gif':'image/png';
      fs.unlinkSync(f.path);
      return `data:${mime};base64,` + buf.toString('base64');
    };

    const mp = {
      id: uuid(), name, filename: mrpackFile.filename,
      mcVersion, loader, modsCount,
      icon: req.files?.icon?.[0] ? toB64(req.files.icon[0]) : iconB64,
      banner: req.files?.banner?.[0] ? toB64(req.files.banner[0]) : null,
      hidden: !!hidden, password: !!password,
      passwordHash: password ? bcrypt.hashSync(password, 10) : null,
      size: mrpackFile.size, uploadedAt: new Date().toISOString()
    };
    const data = load(); data.modpacks.push(mp); save(data);
    res.json({ success:true, modpack:{ ...mp, passwordHash:undefined } });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.patch('/api/modpacks/:id', auth, upload.fields([{ name:'banner',maxCount:1 },{ name:'icon',maxCount:1 }]), async (req, res) => {
  const data = load();
  const mp = data.modpacks.find(m => m.id === req.params.id);
  if (!mp) return res.status(404).json({ error:'No encontrado' });
  if (req.body.name) mp.name = req.body.name;
  if (req.body.hidden !== undefined) mp.hidden = req.body.hidden === 'true';
  if (req.body.password !== undefined) {
    if (req.body.password) { mp.password=true; mp.passwordHash=bcrypt.hashSync(req.body.password,10); }
    else { mp.password=false; mp.passwordHash=null; }
  }
  const toB64=(f)=>{const buf=fs.readFileSync(f.path);const ext=path.extname(f.originalname).toLowerCase();const mime=ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.gif'?'image/gif':'image/png';fs.unlinkSync(f.path);return `data:${mime};base64,`+buf.toString('base64')};
  if (req.files?.banner?.[0]) mp.banner = toB64(req.files.banner[0]);
  if (req.files?.icon?.[0]) mp.icon = toB64(req.files.icon[0]);
  save(data);
  res.json({ success:true, modpack:{ ...mp, passwordHash:undefined } });
});

app.delete('/api/modpacks/:id', auth, (req, res) => {
  const data = load();
  const mp = data.modpacks.find(m => m.id === req.params.id);
  if (!mp) return res.status(404).json({ error:'No encontrado' });
  const f = path.join(UPLOADS, mp.filename);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  data.modpacks = data.modpacks.filter(m => m.id !== req.params.id);
  save(data); res.json({ success:true });
});

// ── NEWS ──────────────────────────────────────────────────────────────────────
app.get('/api/news', (req, res) => {
  const { news } = load();
  res.json({ success:true, news: news||[] });
});

app.post('/api/news', auth, (req, res) => {
  const { title, body, color, image } = req.body;
  if (!title) return res.status(400).json({ error:'Falta título' });
  const data = load(); if (!data.news) data.news = [];
  const item = { id:uuid(), title, body:body||'', color:color||'blue', image:image||null, date:new Date().toISOString() };
  data.news.unshift(item); save(data);
  res.json({ success:true, item });
});

app.delete('/api/news/:id', auth, (req, res) => {
  const data = load();
  data.news = (data.news||[]).filter(n => n.id !== req.params.id);
  save(data); res.json({ success:true });
});

// ── ADMIN AUTH ────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === PASS) res.json({ success:true });
  else res.status(401).json({ success:false });
});

app.listen(PORT, () => {
  console.log(`\n🚀 BAS CLIENT Server → http://localhost:${PORT}`);
  console.log(`🔑 Admin → http://localhost:${PORT}/admin.html`);
  console.log(`🔐 Contraseña → ${PASS}`);
  console.log(`   Cambiar: ADMIN_PASS=tupass node server/index.js\n`);
});
