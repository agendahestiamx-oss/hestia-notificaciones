// ─────────────────────────────────────────────────────────────────
// HESTIA OSM EVAL — Servidor de notificaciones automáticas
// Node.js + Express · Microsoft 365 SMTP · Render.com
// ─────────────────────────────────────────────────────────────────
const express = require('express');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const app = express();
app.use(express.json());

// ── CONFIGURACIÓN ──────────────────────────────────────────────────
const CONFIG = {
  smtp: {
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,      // yaiza@hestiamx.com
      pass: process.env.SMTP_PASS       // contraseña de aplicación
    },
    tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
  },
  from: process.env.SMTP_USER,
  baseUrl: process.env.BASE_URL,        // https://agendahestiamx-oss.github.io/EVALUACIONOSM

  // Destinatarios fijos
  rh: {
    nombre: 'Carmen',
    email: process.env.EMAIL_RH         // carmen@hestiamx.com
  },
  contabilidad: {
    nombre: 'Equipo de Contabilidad',
    email: process.env.EMAIL_CONT       // contabilidad@hestiamx.com
  },
  responsable: {
    nombre: process.env.NOMBRE_RESP || 'Responsable OSMs',
    email: process.env.EMAIL_RESP       // tu correo
  },

  // OSMs registrados (agregar/quitar según el equipo)
  osms: JSON.parse(process.env.OSMS_JSON || '[]')
  // Formato: [{"nombre":"Ana García","email":"ana@...","condominios":"Ávida, Indah"},...]
};

// ── TRANSPORTER ────────────────────────────────────────────────────
const transporter = nodemailer.createTransport(CONFIG.smtp);

async function sendMail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"Hestia Management Co." <${CONFIG.from}>`,
      to,
      subject,
      html
    });
    console.log(`✅ Correo enviado a ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`❌ Error enviando a ${to}:`, err.message);
    return false;
  }
}

// ── TEMPLATES ─────────────────────────────────────────────────────
function mesLabel() {
  return new Date().toLocaleDateString('es-MX', { month: 'long', year: 'numeric' });
}

function emailBase(contenido) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;background:#F5F4F0;margin:0;padding:20px}
  .container{max-width:580px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .header{background:#1C1A17;padding:24px 32px;display:flex;align-items:center}
  .header-brand{color:#C4BBA8;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
  .body{padding:32px}
  .body p{font-size:14px;color:#3A3830;line-height:1.7;margin-bottom:14px}
  .body p:last-child{margin-bottom:0}
  .btn{display:inline-block;background:#1C1A17;color:#fff!important;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:13px;font-weight:600;margin:16px 0}
  .footer{padding:16px 32px;background:#F5F4F0;border-top:1px solid #E0DDD5;font-size:11px;color:#A8A59E;text-align:center}
  table{width:100%;border-collapse:collapse;margin:16px 0}
  th{background:#F5F4F0;padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#6A6860;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #E0DDD5}
  td{padding:10px 12px;font-size:13px;color:#1C1A17;border-bottom:1px solid #E0DDD5}
  tr:last-child td{border-bottom:none}
  .code{font-family:'Courier New',monospace;font-size:15px;font-weight:700;background:#F5F4F0;padding:3px 8px;border-radius:4px;letter-spacing:.1em}
  .tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
  .tag-green{background:#E6F4EF;color:#1A7A5E}
  .tag-amber{background:#FEF3D6;color:#8A5700}
</style></head>
<body><div class="container">
  <div class="header"><div class="header-brand">Hestia Management Co.</div></div>
  <div class="body">${contenido}</div>
  <div class="footer">Hestia Management Co. · Sistema OSM Eval 360° · Este es un correo automático.</div>
</div></body></html>`;
}

// Template 1: Aviso al OSM (día 2 del mes)
function templateOSM(osm) {
  const mes = mesLabel();
  const url = CONFIG.baseUrl + '/OSM_Compromisos.html';
  return emailBase(`
    <p>Hola <strong>${osm.nombre}</strong>,</p>
    <p>La evaluación mensual de <strong>${mes}</strong> ya está disponible. Tu Responsable la está preparando con el equipo y en los próximos días recibirás el resumen de resultados.</p>
    <p>Cuando recibas el código de sesión, podrás ingresar aquí para ver tu evaluación y definir tus compromisos para el siguiente mes:</p>
    <a href="${url}" class="btn">Ver mi evaluación →</a>
    <p style="font-size:12px;color:#A8A59E">Condominios asignados: ${osm.condominios || '—'}</p>
  `);
}

// Template 2: Aviso a Carmen y Contabilidad (cuando se crea sesión)
function templateEvaluadoras(sesiones) {
  const mes = mesLabel();
  const evalUrl = CONFIG.baseUrl + '/OSM_Eval_360.html';
  const filas = sesiones.map(s => `
    <tr>
      <td>${s.osm}</td>
      <td>${s.condominios || '—'}</td>
      <td><span class="code">${s.codigo}</span></td>
      <td><a href="${evalUrl}" style="color:#1A7A5E;font-weight:600;text-decoration:none">Evaluar →</a></td>
    </tr>`).join('');

  return emailBase(`
    <p>Hola,</p>
    <p>Se han iniciado las evaluaciones de <strong>${mes}</strong>. A continuación están los OSMs que debes evaluar este mes.</p>
    <p>Entra al sistema, selecciona tu rol, ingresa el código correspondiente y completa tu sección en ~5 minutos.</p>
    <table>
      <thead><tr><th>On Site Manager</th><th>Condominios</th><th>Código</th><th>Acceso</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <a href="${evalUrl}" class="btn">Ir al sistema de evaluación →</a>
    <p style="font-size:12px;color:#A8A59E">El acceso es con el código de sesión de cada OSM. Si tienes dudas, contacta a ${CONFIG.responsable.nombre}.</p>
  `);
}

// Template 3: Aviso a Responsable cuando OSM envía compromisos
function templateCompromisosRecibidos(osmNombre, condominios) {
  const url = CONFIG.baseUrl + '/OSM_Eval_360.html';
  return emailBase(`
    <p>Hola <strong>${CONFIG.responsable.nombre}</strong>,</p>
    <p><strong>${osmNombre}</strong> acaba de enviar sus compromisos para el siguiente mes.</p>
    <p>Entra al dashboard de evaluación para revisar sus compromisos, aprobarlos o ajustarlos, y generar el reporte final.</p>
    <a href="${url}" class="btn">Ver compromisos y generar reporte →</a>
    <p style="font-size:12px;color:#A8A59E">Condominios: ${condominios || '—'}</p>
  `);
}

// Template 4: Recordatorio si no han evaluado (día 5 del mes)
function templateRecordatorio(nombre, role) {
  const url = CONFIG.baseUrl + '/OSM_Eval_360.html';
  const area = role === 'rh' ? 'Recursos Humanos' : 'Contabilidad';
  return emailBase(`
    <p>Hola <strong>${nombre}</strong>,</p>
    <p>Este es un recordatorio amable: aún tienes evaluaciones pendientes de ${area} para este mes.</p>
    <p>Tu input es importante para que la Responsable pueda generar el reporte completo. Solo toma ~5 minutos.</p>
    <a href="${url}" class="btn">Completar mi evaluación →</a>
  `);
}

// ── ENDPOINTS ─────────────────────────────────────────────────────

// POST /sesion-iniciada — llamado desde el sistema HTML cuando se crea una sesión
// Body: { sesiones: [{osm, condominios, codigo}], pendingRoles: ['rh','cont'] }
app.post('/sesion-iniciada', async (req, res) => {
  const { sesiones, pendingRoles = ['rh', 'cont'] } = req.body;
  if (!sesiones || !sesiones.length) return res.status(400).json({ error: 'sesiones requeridas' });

  const results = [];

  // Correo a Carmen y Contabilidad
  if (pendingRoles.includes('rh') && CONFIG.rh.email) {
    const sent = await sendMail(
      CONFIG.rh.email,
      `📋 Evaluaciones de ${mesLabel()} listas — Hestia OSM Eval`,
      templateEvaluadoras(sesiones)
    );
    results.push({ to: 'rh', sent });
  }
  if (pendingRoles.includes('cont') && CONFIG.contabilidad.email) {
    const sent = await sendMail(
      CONFIG.contabilidad.email,
      `📋 Evaluaciones de ${mesLabel()} listas — Hestia OSM Eval`,
      templateEvaluadoras(sesiones)
    );
    results.push({ to: 'cont', sent });
  }

  res.json({ ok: true, results });
});

// POST /compromisos-recibidos — llamado desde OSM_Compromisos.html al enviar
// Body: { osmNombre, condominios }
app.post('/compromisos-recibidos', async (req, res) => {
  const { osmNombre, condominios } = req.body;
  if (!osmNombre) return res.status(400).json({ error: 'osmNombre requerido' });

  const sent = await sendMail(
    CONFIG.responsable.email,
    `✅ ${osmNombre} envió sus compromisos — Hestia OSM Eval`,
    templateCompromisosRecibidos(osmNombre, condominios)
  );

  res.json({ ok: sent });
});

// POST /recordatorio — enviar recordatorio manual a quien no ha evaluado
// Body: { roles: ['rh'] } o { roles: ['cont'] } o { roles: ['rh','cont'] }
app.post('/recordatorio', async (req, res) => {
  const { roles = [] } = req.body;
  const results = [];
  if (roles.includes('rh') && CONFIG.rh.email) {
    const sent = await sendMail(CONFIG.rh.email, `⏰ Recordatorio: evaluación pendiente — ${mesLabel()}`, templateRecordatorio(CONFIG.rh.nombre, 'rh'));
    results.push({ to: 'rh', sent });
  }
  if (roles.includes('cont') && CONFIG.contabilidad.email) {
    const sent = await sendMail(CONFIG.contabilidad.email, `⏰ Recordatorio: evaluación pendiente — ${mesLabel()}`, templateRecordatorio(CONFIG.contabilidad.nombre, 'cont'));
    results.push({ to: 'cont', sent });
  }
  res.json({ ok: true, results });
});

// GET /ping — health check para Render.com
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ── CRON JOBS ─────────────────────────────────────────────────────

// Día 2 de cada mes a las 9am — aviso a todos los OSMs
cron.schedule('0 9 2 * *', async () => {
  console.log('🔔 Cron: enviando avisos del día 2 a OSMs...');
  for (const osm of CONFIG.osms) {
    if (osm.email) {
      await sendMail(
        osm.email,
        `📅 Evaluación de ${mesLabel()} — Hestia OSM Eval`,
        templateOSM(osm)
      );
    }
  }
}, { timezone: 'America/Mexico_City' });

// Día 5 de cada mes a las 10am — recordatorio si no han evaluado
cron.schedule('0 10 5 * *', async () => {
  console.log('🔔 Cron: enviando recordatorios del día 5...');
  // El recordatorio siempre se manda — el sistema HTML ya sabe quién completó
  await sendMail(CONFIG.rh.email, `⏰ Recordatorio evaluación ${mesLabel()}`, templateRecordatorio(CONFIG.rh.nombre, 'rh'));
  await sendMail(CONFIG.contabilidad.email, `⏰ Recordatorio evaluación ${mesLabel()}`, templateRecordatorio(CONFIG.contabilidad.nombre, 'cont'));
}, { timezone: 'America/Mexico_City' });

// ── START ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor de notificaciones Hestia corriendo en puerto ${PORT}`);
  console.log(`📧 SMTP: ${CONFIG.smtp.auth.user || 'NO CONFIGURADO'}`);
  console.log(`👥 OSMs configurados: ${CONFIG.osms.length}`);
});
