const express  = require('express');
const cors     = require('cors');
const https    = require('https');
const Database = require('better-sqlite3');
const path     = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ── DB ────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || '/tmp/hestia_osm.db';
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id      TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    updated INTEGER NOT NULL DEFAULT (strftime('%s','now'))
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
const now = () => Math.floor(Date.now() / 1000);

// ── HEALTH ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ── SESSION UPSERT ────────────────────────────────────────────────
app.post('/session', (req, res) => {
  try {
    const { sessionId, session, evalData } = req.body;
    if (!sessionId || !session) return res.status(400).json({ error: 'Missing fields' });

    db.prepare(`INSERT INTO sessions (id,data,updated) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated`)
      .run(sessionId, JSON.stringify(session), now());

    if (evalData) {
      for (const role of ['rh','cont','admin']) {
        if (!evalData[role]) continue;
        db.prepare(`INSERT INTO evals (session_id,role,data,submitted,updated) VALUES (?,?,?,?,?)
          ON CONFLICT(session_id,role) DO UPDATE SET data=excluded.data,submitted=excluded.submitted,updated=excluded.updated`)
          .run(sessionId, role, JSON.stringify(evalData[role]), evalData[role].submitted ? 1 : 0, now());
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSION GET ───────────────────────────────────────────────────
app.get('/session/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT data FROM sessions WHERE id=?').get(req.params.id);
    if (!row) return res.json({ session: null, evalData: null });
    const session  = JSON.parse(row.data);
    const evalRows = db.prepare('SELECT role,data FROM evals WHERE session_id=?').all(req.params.id);
    const evalData = { rh:null, cont:null, admin:null };
    for (const er of evalRows) evalData[er.role] = JSON.parse(er.data);
    res.json({ session, evalData });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EVAL ROLE UPSERT ──────────────────────────────────────────────
app.post('/eval/:sessionId/:role', (req, res) => {
  try {
    const { sessionId, role } = req.params;
    db.prepare(`INSERT INTO evals (session_id,role,data,submitted,updated) VALUES (?,?,?,?,?)
      ON CONFLICT(session_id,role) DO UPDATE SET data=excluded.data,submitted=excluded.submitted,updated=excluded.updated`)
      .run(sessionId, role, JSON.stringify(req.body), req.body.submitted ? 1 : 0, now());
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSIONS LIST ─────────────────────────────────────────────────
app.get('/sessions', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, json_extract(data,'$.osm') as osm, json_extract(data,'$.mo') as mo, updated
       FROM sessions ORDER BY updated DESC LIMIT 100`
    ).all();
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSION DELETE ────────────────────────────────────────────────
app.delete('/session/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM evals WHERE session_id=?').run(req.params.id);
    db.prepare('DELETE FROM sessions WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── NOTIFY (correos) ──────────────────────────────────────────────
// Usa nodemailer si tienes SMTP configurado, si no solo loguea
app.post('/notify/sesion', (req, res) => {
  const { osm, condos, codigo, mes, emails } = req.body;
  console.log(`[NOTIFY] Nueva sesión: ${osm} (${mes}) — Código: ${codigo}`);

  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const EMAIL_RH   = process.env.EMAIL_RH   || (emails && emails.rh);
  const EMAIL_CONT = process.env.EMAIL_CONT  || (emails && emails.cont);

  if (!SMTP_USER || !SMTP_PASS) {
    console.log('[NOTIFY] SMTP no configurado — correos no enviados');
    return res.json({ ok: true, sent: false, reason: 'smtp_not_configured' });
  }

  // Send emails via nodemailer
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  const subject = `Evaluación OSM — ${osm} · ${mes} · Código: ${codigo}`;
  const body = `
Hola,

Se ha iniciado la evaluación mensual 360° para el siguiente On Site Manager:

• Colaborador: ${osm}
• Condominios: ${condos}
• Período: ${mes}
• Código de sesión: ${codigo}

Para completar tu evaluación, ingresa al siguiente link y usa el código indicado:
https://agendahestiamx-oss.github.io/EVALUACIONOSM/OSM_Eval_360.html

El código que necesitas es: ${codigo}

Gracias por tu tiempo.
Hestia Management Co.
  `.trim();

  const targets = [EMAIL_RH, EMAIL_CONT].filter(Boolean);
  Promise.all(targets.map(to =>
    transporter.sendMail({ from: SMTP_USER, to, subject, text: body })
  )).then(() => {
    console.log(`[NOTIFY] Correos enviados a: ${targets.join(', ')}`);
    res.json({ ok: true, sent: true, to: targets });
  }).catch(e => {
    console.error('[NOTIFY] Error enviando correo:', e.message);
    res.json({ ok: true, sent: false, reason: e.message });
  });
});

// ── AI PROXY ──────────────────────────────────────────────────────
// Recibe el prompt desde el HTML y llama a Anthropic server-side
// Evita el error CORS de llamar a api.anthropic.com desde el browser
app.post('/ai/report', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'API key no configurada en el servidor' });
  }

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        res.json(parsed);
      } catch(e) {
        res.status(500).json({ error: 'Invalid response from AI' });
      }
    });
  });

  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(body);
  apiReq.end();
});

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hestia OSM server :${PORT} — DB: ${DB_PATH}`));
