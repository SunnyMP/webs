// BAS CLIENT - API Serverless para Vercel
// Base de datos: MongoDB Atlas | Archivos: Vercel Blob

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { put, del, list } = require('@vercel/blob');

// ── CONFIG (variables de entorno en Vercel) ───────────────────────────────────
const MONGO_URI  = process.env.MONGODB_URI;         // mongodb+srv://...
const ADMIN_PASS = process.env.ADMIN_PASS || 'bas2024';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN; // auto en Vercel Blob

// ── MONGODB CLIENT (reutilizado entre invocaciones) ───────────────────────────
let cachedClient = null;
async function getDB() {
  if (!cachedClient) {
    cachedClient = new MongoClient(MONGO_URI);
    await cachedClient.connect();
  }
  return cachedClient.db('basclient');
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url  = req.url.replace(/\?.*$/, ''); // sin query string
  const method = req.method;
  const isAdmin = req.headers['x-admin-token'] === ADMIN_PASS;

  try {
    const db = await getDB();

    // ── GET /api/modpacks ────────────────────────────────────────────────────
    if (url === '/api/modpacks' && method === 'GET') {
      const filter = isAdmin ? {} : { hidden: { $ne: true } };
      const modpacks = await db.collection('modpacks').find(filter).sort({ uploadedAt: -1 }).toArray();
      return res.status(200).json({
        success: true,
        modpacks: modpacks.map(m => ({ ...m, passwordHash: undefined }))
      });
    }

    // ── POST /api/modpacks/:id/unlock ────────────────────────────────────────
    const unlockMatch = url.match(/^\/api\/modpacks\/([^/]+)\/unlock$/);
    if (unlockMatch && method === 'POST') {
      const mp = await db.collection('modpacks').findOne({ id: unlockMatch[1] });
      if (!mp) return res.status(404).json({ error: 'No encontrado' });
      if (!mp.passwordHash) return res.json({ success: true });
      const ok = bcrypt.compareSync(req.body?.password || '', mp.passwordHash);
      return res.json({ success: ok });
    }

    // ── GET /api/modpacks/:id/download ───────────────────────────────────────
    const downloadMatch = url.match(/^\/api\/modpacks\/([^/]+)\/download$/);
    if (downloadMatch && method === 'GET') {
      const mp = await db.collection('modpacks').findOne({ id: downloadMatch[1] });
      if (!mp) return res.status(404).json({ error: 'No encontrado' });
      if (mp.passwordHash) {
        const pass = req.headers['x-pack-password'] || new URL(req.url, 'http://x').searchParams.get('password') || '';
        const ok = bcrypt.compareSync(pass, mp.passwordHash);
        if (!ok) return res.status(403).json({ error: 'Contraseña incorrecta' });
      }
      // Redirect to Vercel Blob URL
      res.setHeader('Location', mp.fileUrl);
      return res.status(302).end();
    }

    // ── POST /api/modpacks/upload ────────────────────────────────────────────
    if (url === '/api/modpacks/upload' && method === 'POST') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });

      const body = req.body;
      if (!body) return res.status(400).json({ error: 'Sin datos' });

      // body.file = base64 del mrpack
      // body.icon = base64 del icon (optional)
      // body.banner = base64 del banner (optional)
      const { name, password, hidden, mcVersion, loader, modsCount } = body;

      let fileUrl = null, iconUrl = null, bannerUrl = null;

      // Subir mrpack a Vercel Blob
      if (body.file) {
        const buf = Buffer.from(body.file.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const blob = await put(`modpacks/${uuid()}.mrpack`, buf, {
          access: 'public',
          token: BLOB_TOKEN
        });
        fileUrl = blob.url;
      }

      if (body.icon) {
        const buf = Buffer.from(body.icon.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const blob = await put(`icons/${uuid()}.png`, buf, { access: 'public', token: BLOB_TOKEN });
        iconUrl = blob.url;
      }

      if (body.banner) {
        const ext = body.banner.includes('gif') ? 'gif' : body.banner.includes('jpeg') ? 'jpg' : 'png';
        const buf = Buffer.from(body.banner.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const blob = await put(`banners/${uuid()}.${ext}`, buf, { access: 'public', token: BLOB_TOKEN });
        bannerUrl = blob.url;
      }

      const mp = {
        id: uuid(), name: name || 'Sin nombre',
        fileUrl, iconUrl: iconUrl || null, bannerUrl: bannerUrl || null,
        icon: iconUrl || null, banner: bannerUrl || null,
        mcVersion: mcVersion || '?', loader: loader || 'Fabric',
        modsCount: modsCount || 0,
        hidden: hidden === true || hidden === 'true',
        password: !!password,
        passwordHash: password ? bcrypt.hashSync(password, 10) : null,
        uploadedAt: new Date().toISOString()
      };

      await db.collection('modpacks').insertOne(mp);
      return res.status(200).json({ success: true, modpack: { ...mp, passwordHash: undefined } });
    }

    // ── PATCH /api/modpacks/:id ──────────────────────────────────────────────
    const patchMatch = url.match(/^\/api\/modpacks\/([^/]+)$/);
    if (patchMatch && method === 'PATCH') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      const update = {};
      const body = req.body || {};
      if (body.name) update.name = body.name;
      if (body.hidden !== undefined) update.hidden = body.hidden === true || body.hidden === 'true';
      if (body.password !== undefined) {
        update.password = !!body.password;
        update.passwordHash = body.password ? bcrypt.hashSync(body.password, 10) : null;
      }
      if (body.icon) {
        const buf = Buffer.from(body.icon.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const blob = await put(`icons/${uuid()}.png`, buf, { access: 'public', token: BLOB_TOKEN });
        update.icon = blob.url; update.iconUrl = blob.url;
      }
      if (body.banner) {
        const ext = body.banner.includes('gif') ? 'gif' : 'png';
        const buf = Buffer.from(body.banner.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const blob = await put(`banners/${uuid()}.${ext}`, buf, { access: 'public', token: BLOB_TOKEN });
        update.banner = blob.url; update.bannerUrl = blob.url;
      }
      await db.collection('modpacks').updateOne({ id: patchMatch[1] }, { $set: update });
      return res.json({ success: true });
    }

    // ── DELETE /api/modpacks/:id ─────────────────────────────────────────────
    if (patchMatch && method === 'DELETE') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      const mp = await db.collection('modpacks').findOne({ id: patchMatch[1] });
      if (mp?.fileUrl) {
        try { await del(mp.fileUrl, { token: BLOB_TOKEN }); } catch {}
      }
      await db.collection('modpacks').deleteOne({ id: patchMatch[1] });
      return res.json({ success: true });
    }

    // ── GET /api/news ────────────────────────────────────────────────────────
    if (url === '/api/news' && method === 'GET') {
      const news = await db.collection('news').find({}).sort({ date: -1 }).toArray();
      return res.json({ success: true, news });
    }

    // ── POST /api/news ───────────────────────────────────────────────────────
    if (url === '/api/news' && method === 'POST') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      const { title, body: bodyText, color, image } = req.body || {};
      if (!title) return res.status(400).json({ error: 'Falta título' });

      let imageUrl = null;
      if (image) {
        const ext = image.includes('gif') ? 'gif' : image.includes('jpeg') ? 'jpg' : 'png';
        const buf = Buffer.from(image.replace(/^data:[^;]+;base64,/, ''), 'base64');
        const blob = await put(`news/${uuid()}.${ext}`, buf, { access: 'public', token: BLOB_TOKEN });
        imageUrl = blob.url;
      }

      const item = { id: uuid(), title, body: bodyText || '', color: color || 'blue', image: imageUrl, date: new Date().toISOString() };
      await db.collection('news').insertOne(item);
      return res.json({ success: true, item });
    }

    // ── DELETE /api/news/:id ─────────────────────────────────────────────────
    const newsDelMatch = url.match(/^\/api\/news\/([^/]+)$/);
    if (newsDelMatch && method === 'DELETE') {
      if (!isAdmin) return res.status(401).json({ error: 'No autorizado' });
      await db.collection('news').deleteOne({ id: newsDelMatch[1] });
      return res.json({ success: true });
    }

    // ── POST /api/admin/login ────────────────────────────────────────────────
    if (url === '/api/admin/login' && method === 'POST') {
      const ok = req.body?.password === ADMIN_PASS;
      return res.status(ok ? 200 : 401).json({ success: ok });
    }

    return res.status(404).json({ error: 'Ruta no encontrada' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
