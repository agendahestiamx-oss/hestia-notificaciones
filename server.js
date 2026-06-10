// ─────────────────────────────────────────────────────────────────
// HESTIA OSM EVAL — Servidor central
// Datos compartidos + Notificaciones por correo
// Node.js + Express · Render.com (free tier)
// ─────────────────────────────────────────────────────────────────
const express = require('express');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── ALMACENAMIENTO EN MEMORIA ──────────────────────────────────────
// Guarda sesiones y evaluaciones mientras el servidor está activo
// (Render free tier duerme después de 15 min de inactividad,
//  los datos se pierden al despertar — suficiente para uso mensual)
const store = {
  sessions: {},    // sessionId -> {osm, mo, admin, condos, notas, created}
  evalData: {},    // sessionId -> {rh:{}, cont:{}, admin:{}}
  compromisos: {}  // sessionId -> {osmName, comps, reflexion, mensaje}
};

// ── SMTP ────────────────────────────────────────────────────────────
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const emailRH   = process.env.EMAIL_RH;
const emailCont = process.env.EMAIL_CONT;
const emailResp = process.env.EMAIL_RESP;
const nombreResp= process.env.NOMBRE_RESP || 'Responsable OSMs';
const baseUrl   = process.env.BASE_URL || 'https://agendahestiamx-oss.github.io/EVALUACIONOSM';

let transporter = null;
if (smtpUser && smtpPass) {
  transporter = nodemailer.createTransport({
    host: 'smtp.office365.com', port: 587, secure: false,
    auth: { user: smtpUser, pass: smtpPass },
    tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
  });
}

async function sendMail(to, subject, html) {
  if (!transporter) { console.log('SMTP no configurado — correo omitido:', subject); return; }
  try {
    await transporter.sendMail({
      from: `"Hestia Management Co." <${smtpUser}>`, to, subject, html
    });
    console.log('✅ Correo enviado a', to);
  } catch(e) { console.error('❌ Error SMTP:', e.message); }
}

function emailHtml(body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body{font-family:'Segoe UI',Arial,sans-serif;background:#F5F4F0;margin:0;padding:20px}
.c{max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden}
.h{background:#1C1A17;padding:20px 28px}
.hb{color:#C4BBA8;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.b{padding:28px}
.b p{font-size:14px;color:#3A3830;line-height:1.7;margin-bottom:12px}
.btn{display:inline-block;background:#1C1A17;color:#fff!important;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:13px;font-weight:600;margin:14px 0}
table{width:100%;border-collapse:collapse;margin:14px 0}
th{background:#F5F4F0;padding:9px 11px;text-align:left;font-size:11px;font-weight:700;color:#6A6860;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #E0DDD5}
td{padding:9px 11px;font-size:13px;border-bottom:1px solid #E0DDD5}
.code{font-family:monospace;font-size:15px;font-weight:700;background:#F5F4F0;padding:2px 8px;border-radius:4px;letter-spacing:.1em}
.f{padding:14px 28px;background:#F5F4F0;font-size:11px;color:#A8A59E;text-align:center}
</style></head><body><div class="c">
<div class="h"><div class="hb">Hestia Management Co.</div></div>
<div class="b">${body}</div>
<div class="f">Hestia Management Co. · Sistema OSM Eval 360° · Correo automático</div>
</div></body></html>`;
}

function mesLabel() {
  return new Date().toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
}

// ── ENDPOINTS DE DATOS ─────────────────────────────────────────────

// Crear o actualizar sesión
app.post('/session', (req, res) => {
  const { sessionId, session, evalData } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
  if (session) store.sessions[sessionId] = session;
  if (evalData) store.evalData[sessionId] = evalData;
  console.log('Session saved:', sessionId);
  res.json({ ok: true });
});

// Leer sesión y datos
app.get('/session/:id', (req, res) => {
  const id = req.params.id;
  const session = store.sessions[id];
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
  res.json({
    session,
    evalData: store.evalData[id] || null,
    compromisos: store.compromisos[id] || null
  });
});

// Guardar datos de una evaluadora
app.post('/eval/:sessionId/:role', (req, res) => {
  const { sessionId, role } = req.params;
  if (!['rh','cont','admin'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  if (!store.evalData[sessionId]) store.evalData[sessionId] = { rh:{scores:{},comments:{},openAnswers:{},submitted:false}, cont:{scores:{},comments:{},openAnswers:{},submitted:false}, admin:{scores:{},comments:{},submitted:false} };
  store.evalData[sessionId][role] = { ...store.evalData[sessionId][role], ...req.body };
  console.log(`Eval saved: ${sessionId}/${role}`);
  res.json({ ok: true });
});

// Leer datos de evaluación
app.get('/eval/:sessionId', (req, res) => {
  const data = store.evalData[req.params.sessionId];
  if (!data) return res.status(404).json({ error: 'No encontrado' });
  res.json(data);
});

// Guardar compromisos del OSM
app.post('/compromisos/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  store.compromisos[sessionId] = req.body;
  console.log('Compromisos saved:', sessionId);
  // Notificar a la responsable
  const osm = req.body.osmName || 'el OSM';
  const condos = req.body.condominios || '';
  sendMail(
    emailResp,
    `✅ ${osm} envió sus compromisos — Hestia OSM Eval`,
    emailHtml(`<p>Hola <strong>${nombreResp}</strong>,</p>
    <p><strong>${osm}</strong> acaba de enviar sus compromisos para el siguiente mes.</p>
    <p>Entra al sistema para revisarlos y generar el reporte final:</p>
    <a href="${baseUrl}/OSM_Eval_360.html" class="btn">Ver compromisos →</a>
    <p style="font-size:12px;color:#A8A59E">Condominios: ${condos}</p>`)
  );
  res.json({ ok: true });
});

// Leer compromisos
app.get('/compromisos/:sessionId', (req, res) => {
  const data = store.compromisos[req.params.sessionId];
  if (!data) return res.status(404).json({ error: 'No encontrado' });
  res.json(data);
});

// Listar todas las sesiones activas (para admin)
app.get('/sessions', (req, res) => {
  const list = Object.entries(store.sessions).map(([id, s]) => ({
    id, osm: s.osm, mo: s.mo, condos: s.condos,
    hasRH: !!(store.evalData[id]?.rh?.submitted),
    hasCont: !!(store.evalData[id]?.cont?.submitted),
    hasAdmin: !!(store.evalData[id]?.admin?.submitted),
    hasCompromisos: !!store.compromisos[id]
  }));
  res.json(list);
});

// ── ENDPOINTS DE NOTIFICACIONES ────────────────────────────────────

// Notificar a evaluadoras cuando se crea sesión
app.post('/notify/sesion', async (req, res) => {
  const { osm, condos, codigo, mes } = req.body;
  const evalUrl = baseUrl + '/OSM_Eval_360.html';
  const body = emailHtml(`
    <p>Hola,</p>
    <p>Se ha iniciado la evaluación de <strong>${osm}</strong> para el mes de <strong>${mes || mesLabel()}</strong>.</p>
    <table>
      <thead><tr><th>OSM</th><th>Condominios</th><th>Código de sesión</th></tr></thead>
      <tbody><tr>
        <td>${osm}</td>
        <td>${condos || '—'}</td>
        <td><span class="code">${codigo}</span></td>
      </tr></tbody>
    </table>
    <p>Entra al sistema, selecciona tu rol e ingresa el código:</p>
    <a href="${evalUrl}" class="btn">Ir a mi evaluación →</a>
    <p style="font-size:12px;color:#A8A59E">Toma aproximadamente 5 minutos. Gracias por tu apoyo.</p>`);

  if (emailRH)   await sendMail(emailRH,   `📋 Evaluación de ${osm} lista — Hestia OSM Eval`, body);
  if (emailCont) await sendMail(emailCont, `📋 Evaluación de ${osm} lista — Hestia OSM Eval`, body);
  res.json({ ok: true });
});

// Health check
app.get('/ping', (req, res) => res.json({ ok: true, sessions: Object.keys(store.sessions).length, time: new Date().toISOString() }));

// ── CRON: Recordatorio día 2 de cada mes ──────────────────────────
cron.schedule('0 9 2 * *', async () => {
  console.log('Cron: recordatorio mensual');
  await sendMail(
    emailResp,
    `📅 Recordatorio: abrir evaluaciones OSM — ${mesLabel()}`,
    emailHtml(`<p>Hola <strong>${nombreResp}</strong>,</p>
    <p>Es día 2 del mes — momento de abrir las evaluaciones 360° de los On Site Managers.</p>
    <a href="${baseUrl}/OSM_Eval_360.html" class="btn">Abrir sistema de evaluación →</a>
    <p style="font-size:12px;color:#A8A59E">Al crear cada sesión, Carmen y Contabilidad recibirán automáticamente su correo con el código.</p>`)
  );
}, { timezone: 'America/Mexico_City' });

// ── START ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Hestia OSM Server corriendo en puerto ${PORT}`);
  console.log(`📧 SMTP: ${smtpUser || 'NO CONFIGURADO'}`);
});
