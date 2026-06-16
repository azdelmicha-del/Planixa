const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { connectMongo } = require('./db');

const app = express();
const PORT = process.env.PORT || 10000;
const PROJECT_ROOT = path.resolve(__dirname, '..');

/* ── MIDDLEWARE ── */
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(PROJECT_ROOT, {
  setHeaders: (res, path) => {
    if (path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

/* ── RATE LIMITING ── */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Demasiados intentos, intente más tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/register', authLimiter);
app.use('/api/login', authLimiter);

const chatLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    message: { success: false, message: 'Demasiadas solicitudes de chat, intente más tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/chat', chatLimiter);

/* ── STATIC ── */
app.get('/', (_req, res) => res.sendFile(path.join(PROJECT_ROOT, 'index.html')));
app.get('/portal', (_req, res) => res.sendFile(path.join(PROJECT_ROOT, 'public', 'portal.html')));

/* ── ROUTES ── */
require('./routes/auth')(app);
require('./routes/chat')(app);
require('./routes/conversations')(app);
require('./routes/export')(app);
require('./routes/generate')(app);
require('./routes/students')(app);
require('./routes/schedule')(app);
require('./routes/annual')(app);
require('./routes/admin')(app);
require('./routes/references')(app);
require('./routes/templates')(app);
require('./routes/reminders')(app);
require('./routes/journal')(app);
require('./routes/evaluation')(app);
require('./routes/language')(app);
require('./routes/stats')(app);
require('./routes/competencias')(app);
require('./routes/clients')(app);
require('./routes/notify')(app);
require('./routes/user')(app);
require('./routes/pwa')(app);
require('./routes/webhook')(app);
require('./routes/health')(app);
require('./routes/share')(app);
require('./routes/import')(app);
require('./routes/versions')(app);
require('./routes/calendar')(app);
require('./routes/portal')(app);

/* ── START ── */
async function start() {
    await connectMongo();
    app.listen(PORT, () => {
        console.log(`Planixa corriendo en puerto ${PORT}`);
        const oKey = process.env.OPENAI_API_KEY;
        const gKey = process.env.GOOGLE_AI_KEY;
        console.log('OPENAI_API_KEY :', oKey && !oKey.includes('your_') ? 'configurada' : 'no configurada');
        console.log('GOOGLE_AI_KEY  :', gKey ? 'configurada' : 'no configurada');
        if (!oKey || oKey.includes('your_')) {
            console.warn('Sin OpenAI key - el bot usará Gemini si está configurado');
        }
    });
}

start().catch(err => { console.error('Error fatal:', err); process.exit(1); });
