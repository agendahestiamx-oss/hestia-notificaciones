const express = require('express');
const cors    = require('cors');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ── PERSISTENT STORE ──────────────────────────────────────────────
// Saves to disk so data survives server sleep/wake cycles
const DATA_FILE = process.env.DATA_FILE || '/tmp/hestia_data.json';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) { console.error('Load error:', e.message); }
  return {};
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
  } catch(e) { console.error('Save error:', e.message); }
}

// Load on startup
let store = loadData();
console.log('📂 Loaded', Object.keys(store).length, 'sessions from disk');

const now = () => Math.floor(Date.now() / 1000);

// ── HELPERS ───────────────────────────────────────────────────────
function mergeEvalData(existing, incoming) {
  if (!incoming) return existing || {};
  const result = { ...existing };
  for (const role of ['rh', 'cont', 'admin']) {
    if (!incoming[role]) continue;
    const rem = incoming[role];
    const loc = existing && existing[role];
    const remHas = rem.scores && Object.keys(rem.scores).length > 0;
    const locHas = loc && loc.scores && Object.keys(loc.scores).length > 0;
    if (remHas) {
      result[role] = {
        ...rem,
        scores:    { ...(locHas ? loc.scores : {}), ...rem.scores },
        comments:  { ...(loc && loc.comments  || {}), ...(rem.comments  || {}) },
        oqAnswers: { ...(loc && loc.oqAnswers || {}), ...(rem.oqAnswers || {}) },
        submitted: rem.submitted || (loc && loc.submitted) || false
      };
    } else if (!locHas) {
      result[role] = rem;
    } else {
      result[role] = loc; // keep local if remote is empty
    }
  }
  return result;
}

// ── HEALTH ────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, sessions: Object.keys(store).length });
});

// ── SESSION UPSERT ────────────────────────────────────────────────
app.post('/session', (req, res) => {
  try {
    const { sessionId, session, evalData } = req.body;
    if (!sessionId || !session) return res.status(400).json({ error: 'Missing fields' });
    const existing = store[sessionId] || {};
    store[sessionId] = {
      session,
      evalData: mergeEvalData(existing.evalData, evalData),
      updated: now()
    };
    saveData(store);
    console.log('Session saved:', sessionId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSION GET ───────────────────────────────────────────────────
app.get('/session/:id', (req, res) => {
  const s = store[req.params.id];
  if (!s) return res.json({ session: null, evalData: null });
  res.json({ session: s.session, evalData: s.evalData || null });
});

// ── EVAL ROLE UPSERT ──────────────────────────────────────────────
// Called when RH or Contabilidad submits their section
app.post('/eval/:sessionId/:role', (req, res) => {
  try {
    const { sessionId, role } = req.params;
    if (!store[sessionId]) return res.status(404).json({ error: 'Session not found' });
    const existing = store[sessionId].evalData || {};
    const loc = existing[role] || {};
    const rem = req.body;
    const remHas = rem.scores && Object.keys(rem.scores).length > 0;
    const locHas = loc.scores && Object.keys(loc.scores).length > 0;
    store[sessionId].evalData = store[sessionId].evalData || {};
    store[sessionId].evalData[role] = remHas ? {
      ...rem,
      scores:    { ...(locHas ? loc.scores : {}), ...rem.scores },
      comments:  { ...loc.comments  || {}, ...rem.comments  || {} },
      oqAnswers: { ...loc.oqAnswers || {}, ...rem.oqAnswers || {} },
      submitted: rem.submitted || loc.submitted || false
    } : (locHas ? loc : rem);
    store[sessionId].updated = now();
    saveData(store);
    console.log('Eval saved:', sessionId, role);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSIONS LIST ─────────────────────────────────────────────────
app.get('/sessions', (req, res) => {
  const rows = Object.entries(store)
    .map(([id, s]) => ({
      id,
      osm:     s.session && s.session.osm,
      mo:      s.session && s.session.mo,
      updated: s.updated || now(),
      rh_done:   !!(s.evalData && s.evalData.rh   && s.evalData.rh.submitted),
      cont_done: !!(s.evalData && s.evalData.cont  && s.evalData.cont.submitted),
      admin_done:!!(s.evalData && s.evalData.admin && s.evalData.admin.submitted),
    }))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 100);
  res.json(rows);
});

// ── SESSION DELETE ────────────────────────────────────────────────
app.delete('/session/:id', (req, res) => {
  if (store[req.params.id]) {
    delete store[req.params.id];
    saveData(store);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ── NOTIFY ────────────────────────────────────────────────────────
app.post('/notify/sesion', (req, res) => {
  const { osm, condos, codigo, mes, emails } = req.body;
  const SMTP_USER  = process.env.SMTP_USER;
  const SMTP_PASS  = process.env.SMTP_PASS;
  const emailRH    = (emails && emails.rh)   || process.env.EMAIL_RH;
  const emailCont  = (emails && emails.cont)  || process.env.EMAIL_CONT;
  if (!SMTP_USER || !SMTP_PASS) {
    console.log('SMTP no configurado — correo omitido:', osm, codigo);
    return res.json({ ok: true, sent: false });
  }
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com', port: 587, secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  const subject = 'Evaluación OSM — ' + osm + ' · ' + mes + ' · Código: ' + codigo;
  const text = ['Hola,','','Se ha iniciado la evaluación mensual 360° para:',
    '  • Colaborador: '+osm,'  • Condominios: '+condos,'  • Período: '+mes,'  • Código: '+codigo,'',
    'Ingresa aquí y usa el código:',
    'https://agendahestiamx-oss.github.io/EVALUACIONOSM/OSM_Eval_360.html',
    '','Gracias,','Hestia Management Co.'].join('\n');
  const targets = [emailRH, emailCont].filter(Boolean);
  Promise.all(targets.map(to => transporter.sendMail({ from: SMTP_USER, to, subject, text })))
    .then(() => res.json({ ok: true, sent: true }))
    .catch(e => { console.error('Email error:', e.message); res.json({ ok: true, sent: false }); });
});

// ── AI PROXY ──────────────────────────────────────────────────────
app.post('/ai/report', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt' });
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY no configurada' });
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514', max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });
  const options = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY,
      'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) }
  };
  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => { try { res.json(JSON.parse(data)); } catch(e) { res.status(500).json({ error: 'Invalid AI response' }); } });
  });
  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(body); apiReq.end();
});

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Hestia OSM Server en puerto', PORT);
  console.log('💾 Datos en:', DATA_FILE);
  console.log(process.env.SMTP_USER ? '📧 SMTP: OK' : '📵 SMTP: no configurado');
  console.log(process.env.ANTHROPIC_API_KEY ? '🤖 AI: OK' : '🤖 AI: no configurado');
});
