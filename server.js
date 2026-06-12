const express = require('express');
const cors    = require('cors');
const https   = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ── IN-MEMORY STORE ───────────────────────────────────────────────
// Persiste mientras el servidor esté vivo.
// Para persistencia entre reinicios, agregar SQLite después.
const sessions = {}; // { id: { session, evalData } }

const now = () => Math.floor(Date.now() / 1000);

// ── HEALTH ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, sessions: Object.keys(sessions).length }));

// ── SESSION UPSERT ────────────────────────────────────────────────
app.post('/session', (req, res) => {
  try {
    const { sessionId, session, evalData } = req.body;
    if (!sessionId || !session) return res.status(400).json({ error: 'Missing fields' });
    if (!sessions[sessionId]) sessions[sessionId] = { session, evalData: evalData||{}, updated: now() };
    else {
      sessions[sessionId].session = session;
      sessions[sessionId].updated = now();
      if (evalData) {
        for (const role of ['rh','cont','admin']) {
          if (!evalData[role]) continue;
          const rem = evalData[role];
          const loc = sessions[sessionId].evalData[role];
          const remHas = rem.scores && Object.keys(rem.scores).length > 0;
          const locHas = loc && loc.scores && Object.keys(loc.scores).length > 0;
          if (remHas || !locHas) {
            sessions[sessionId].evalData[role] = {
              ...rem,
              scores: { ...(locHas ? loc.scores : {}), ...rem.scores },
              comments: { ...(loc&&loc.comments||{}), ...(rem.comments||{}) },
              oqAnswers: { ...(loc&&loc.oqAnswers||{}), ...(rem.oqAnswers||{}) },
              submitted: rem.submitted || (loc&&loc.submitted) || false
            };
          }
        }
      }
    }
    console.log('Session saved:', sessionId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSION GET ───────────────────────────────────────────────────
app.get('/session/:id', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.json({ session: null, evalData: null });
  res.json({ session: s.session, evalData: s.evalData });
});

// ── EVAL ROLE UPSERT ──────────────────────────────────────────────
app.post('/eval/:sessionId/:role', (req, res) => {
  try {
    const { sessionId, role } = req.params;
    if (!sessions[sessionId]) return res.status(404).json({ error: 'Session not found' });
    if (!sessions[sessionId].evalData) sessions[sessionId].evalData = {};
    const existing = sessions[sessionId].evalData[role] || {};
    sessions[sessionId].evalData[role] = {
      ...existing,
      ...req.body,
      scores: { ...(existing.scores||{}), ...(req.body.scores||{}) },
      comments: { ...(existing.comments||{}), ...(req.body.comments||{}) },
      oqAnswers: { ...(existing.oqAnswers||{}), ...(req.body.oqAnswers||{}) },
    };
    sessions[sessionId].updated = now();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SESSIONS LIST ─────────────────────────────────────────────────
app.get('/sessions', (req, res) => {
  const rows = Object.entries(sessions)
    .map(([id, s]) => ({
      id,
      osm: s.session && s.session.osm,
      mo:  s.session && s.session.mo,
      updated: s.updated || now()
    }))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 100);
  res.json(rows);
});

// ── SESSION DELETE ────────────────────────────────────────────────
app.delete('/session/:id', (req, res) => {
  if (sessions[req.params.id]) {
    delete sessions[req.params.id];
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ── NOTIFY ────────────────────────────────────────────────────────
app.post('/notify/sesion', (req, res) => {
  const { osm, condos, codigo, mes, emails } = req.body;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const emailRH   = (emails && emails.rh)   || process.env.EMAIL_RH;
  const emailCont = (emails && emails.cont)  || process.env.EMAIL_CONT;

  if (!SMTP_USER || !SMTP_PASS) {
    console.log('SMTP no configurado — correo omitido: 📋 Evaluación de', osm, '— Hestia OSM Eval');
    return res.json({ ok: true, sent: false });
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com', port: 587, secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  const subject = 'Evaluación OSM — ' + osm + ' · ' + mes + ' · Código: ' + codigo;
  const text = [
    'Hola,',
    '',
    'Se ha iniciado la evaluación mensual 360° para:',
    '  • Colaborador: ' + osm,
    '  • Condominios: ' + condos,
    '  • Período: ' + mes,
    '  • Código de sesión: ' + codigo,
    '',
    'Ingresa al link y usa el código:',
    'https://agendahestiamx-oss.github.io/EVALUACIONOSM/OSM_Eval_360.html',
    '',
    'Gracias,',
    'Hestia Management Co.'
  ].join('\n');

  const targets = [emailRH, emailCont].filter(Boolean);
  Promise.all(targets.map(to => transporter.sendMail({ from: SMTP_USER, to, subject, text })))
    .then(() => res.json({ ok: true, sent: true, to: targets }))
    .catch(e => { console.error('Email error:', e.message); res.json({ ok: true, sent: false }); });
});

// ── AI PROXY ──────────────────────────────────────────────────────
app.post('/ai/report', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY no configurada en el servidor' });

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
      try { res.json(JSON.parse(data)); }
      catch(e) { res.status(500).json({ error: 'Invalid AI response' }); }
    });
  });
  apiReq.on('error', e => res.status(500).json({ error: e.message }));
  apiReq.write(body);
  apiReq.end();
});

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Hestia OSM Server corriendo en puerto', PORT);
  console.log(process.env.SMTP_USER ? '📧 SMTP: CONFIGURADO' : '📵 SMTP: NO CONFIGURADO');
  console.log(process.env.ANTHROPIC_API_KEY ? '🤖 AI: CONFIGURADO' : '🤖 AI: NO CONFIGURADO (agrega ANTHROPIC_API_KEY)');
});
