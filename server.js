const express = require('express');
const cors    = require('cors');
const Database = require('better-sqlite3');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── BASE DE DATOS ──────────────────────────────────────────────────
// better-sqlite3 escribe en disco → persiste entre reinicios de Render
const DB_PATH = process.env.DB_PATH || path.join('/tmp', 'hestia_osm.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id        TEXT PRIMARY KEY,
    data      TEXT NOT NULL,
    updated   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS evals (
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    data       TEXT NOT NULL,
    submitted  INTEGER NOT NULL DEFAULT 0,
    updated    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (session_id, role)
  );
`);

// ── HELPERS ────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);

// ── RUTAS ──────────────────────────────────────────────────────────

// Healthcheck — sirve para que Render sepa que el proceso arrancó
app.get('/health', (req, res) => res.json({ ok: true }));

// Guardar / actualizar sesión completa
// Body: { sessionId, session, evalData }
app.post('/session', (req, res) => {
  try {
    const { sessionId, session, evalData } = req.body;
    if (!sessionId || !session) return res.status(400).json({ error: 'Missing sessionId or session' });

    // Upsert sesión
    db.prepare(`
      INSERT INTO sessions (id, data, updated) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated
    `).run(sessionId, JSON.stringify(session), now());

    // Upsert evalData por rol
    if (evalData) {
      for (const role of ['rh', 'cont', 'admin']) {
        if (evalData[role]) {
          db.prepare(`
            INSERT INTO evals (session_id, role, data, submitted, updated) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id, role) DO UPDATE SET data=excluded.data, submitted=excluded.submitted, updated=excluded.updated
          `).run(sessionId, role, JSON.stringify(evalData[role]), evalData[role].submitted ? 1 : 0, now());
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /session', e);
    res.status(500).json({ error: e.message });
  }
});

// Leer sesión completa (session + evalData de los 3 roles)
app.get('/session/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT data FROM sessions WHERE id = ?').get(req.params.id);
    if (!row) return res.json({ session: null, evalData: null });

    const session = JSON.parse(row.data);
    const evalRows = db.prepare('SELECT role, data FROM evals WHERE session_id = ?').all(req.params.id);

    const evalData = { rh: null, cont: null, admin: null };
    for (const er of evalRows) evalData[er.role] = JSON.parse(er.data);

    res.json({ session, evalData });
  } catch (e) {
    console.error('GET /session/:id', e);
    res.status(500).json({ error: e.message });
  }
});

// Guardar evaluación de un rol específico
// POST /eval/:sessionId/:role — Body: { scores, comments, openAnswers, submitted }
app.post('/eval/:sessionId/:role', (req, res) => {
  try {
    const { sessionId, role } = req.params;
    const evalRole = req.body;

    db.prepare(`
      INSERT INTO evals (session_id, role, data, submitted, updated) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, role) DO UPDATE SET data=excluded.data, submitted=excluded.submitted, updated=excluded.updated
    `).run(sessionId, role, JSON.stringify(evalRole), evalRole.submitted ? 1 : 0, now());

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /eval', e);
    res.status(500).json({ error: e.message });
  }
});

// Notificación: sesión iniciada (para correos / Power Automate)
app.post('/notify/sesion', (req, res) => {
  console.log('Sesión iniciada:', JSON.stringify(req.body));
  // TODO: integrar nodemailer cuando tengas las credenciales SMTP
  res.json({ ok: true });
});

// Listar sesiones recientes (útil para debug / admin)
app.get('/sessions', (req, res) => {
  const rows = db.prepare(
    'SELECT id, json_extract(data,\'$.osm\') as osm, json_extract(data,\'$.mo\') as mo, updated FROM sessions ORDER BY updated DESC LIMIT 50'
  ).all();
  res.json(rows);
});

// ── ARRANQUE ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hestia OSM server on port ${PORT} — DB: ${DB_PATH}`));
