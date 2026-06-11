const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const mongoose   = require('mongoose');
const bcrypt     = require('bcrypt');
const rateLimit  = require('express-rate-limit');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 10000;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const MONGODB_URI = process.env.MONGODB_URI;

/* ── MIDDLEWARE ─────────────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(PROJECT_ROOT));

/* ── RATE LIMITING ──────────────────────────────────────────────────── */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Demasiados intentos, intente más tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/register', authLimiter);
app.use('/api/login', authLimiter);

/* ── AUTH MIDDLEWARE ────────────────────────────────────────────────── */
const authenticateToken = (req, res, next) => {
    const authHeader = String(req.headers.authorization || '').trim();
    const token = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : authHeader || String(req.body?.token || '').trim();
    if (!token || !token.startsWith('plan_token_')) {
        return res.status(401).json({ success: false, message: 'Token inválido' });
    }
    req.userId = token.replace('plan_token_', '');
    next();
};

/* ── STATIC ─────────────────────────────────────────────────────────── */
app.get('/', (_req, res) => res.sendFile(path.join(PROJECT_ROOT, 'index.html')));
app.get('/healthz', (_req, res) => res.sendStatus(200));

/* ── MONGODB ────────────────────────────────────────────────────────── */
async function connectMongo() {
    if (!MONGODB_URI) { console.error('MONGODB_URI no configurada'); process.exit(1); }
    await mongoose.connect(MONGODB_URI, { dbName: 'planif_pro', serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 });
    console.log('MongoDB conectado (planif_pro)');
    const db = mongoose.connection;
    await db.collection('users').createIndex({ phone: 1 }, { unique: true });
    await db.collection('conversations').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('conversations').createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
    return db;
}
function getDb() { return mongoose.connection; }

/* ── AUTH ───────────────────────────────────────────────────────────── */
function normalizePhone(v) {
    let p = String(v || '').replace(/\D/g, '');
    if (p.startsWith('1')) p = p.slice(1);
    if (p.length === 10) return '1' + p;
    if (p.length === 11 && p.startsWith('1')) return p;
    return null;
}

app.post('/api/register', async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    if (!phone) return res.status(400).json({ success: false, message: 'Número de celular inválido (809/829/849)' });
    if (password.length < 4) return res.status(400).json({ success: false, message: 'Contraseña debe tener al menos 4 caracteres' });
    try {
        const existing = await getDb().collection('users').findOne({ phone });
        if (existing) return res.status(400).json({ success: false, message: 'Este número ya está registrado' });
        const hashed = await bcrypt.hash(password, 12);
        await getDb().collection('users').insertOne({ phone, password: hashed, name, role: 'teacher', created_at: new Date() });
        console.log('Nuevo usuario:', phone);
        res.json({ success: true, message: 'Registrado correctamente' });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

app.post('/api/login', async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || '');
    if (!phone) return res.status(400).json({ success: false, message: 'Número inválido' });
    try {
        const user = await getDb().collection('users').findOne({ phone });
        if (!user) return res.status(401).json({ success: false, message: 'Número no registrado' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
        res.json({
            success: true,
            token: `plan_token_${user._id.toString()}`,
            user: { id: user._id.toString(), phone: user.phone, name: user.name || '' }
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

/* ── CHAT ───────────────────────────────────────────────────────────── */
const MINERD_SYSTEM_PROMPT = `Eres "El Profe 2.0", el asistente oficial de planificación docente del Ministerio de Educación de República Dominicana (MINERD).

Tu función EXCLUSIVA es ayudar a maestros y maestras dominicanos a crear PLANIFICACIONES DOCENTES completas, alineadas al Diseño Curricular del MINERD y al enfoque por competencias.

CONOCIMIENTO CURRICULAR:
- Trabajas con todos los niveles: Inicial, Primaria (1ro a 6to), Secundaria (1ro a 6to)
- Conoces las áreas: Lengua Española, Matemática, Ciencias Sociales, Ciencias de la Naturaleza, Inglés, Educación Física, Formación Humana e Integral, Educación Artística
- Manejas los ejes transversales y las competencias fundamentales del MINERD
- Conoces los indicadores de logro por grado y área

ESTRUCTURA DE PLANIFICACIÓN QUE DEBES GENERAR:
1. ENCABEZADO: Centro educativo, Nivel, Grado, Área/Materia, Maestro/a, Tema, Tiempo (sesiones), Fecha
2. COMPETENCIAS FUNDAMENTALES: Las que aplican
3. COMPETENCIAS ESPECÍFICAS: Del grado y área
4. CONTENIDOS: Conceptuales, Procedimentales, Actitudinales
5. INDICADORES DE LOGRO: Por criterios de evaluación
6. SECUENCIA DIDÁCTICA (3 momentos):
   - Inicio (activación de conocimientos previos, problematización)
   - Desarrollo (actividades de construcción del aprendizaje)
   - Cierre (socialización, reflexión, evaluación)
7. ESTRATEGIAS DE ENSEÑANZA Y APRENDIZAJE
8. RECURSOS: Didácticos, tecnológicos, bibliográficos
9. EVALUACIÓN: Técnicas e instrumentos según el enfoque por competencias
10. ADECUACIÓN CURRICULAR: Para estudiantes con NEE

REGLAS:
- Responde SIEMPRE en español dominicano
- Sé claro, estructurado y profesional
- Si el usuario no especifica grado/área, pregúntale
- Usa el formato oficial del MINERD con tabulación clara
- No inventes referencias bibliográficas que no existan
- Al final de cada planificación, pregunta si desea ajustar algo o exportar a PDF`;

app.post('/chat', authenticateToken, async (req, res) => {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ response: 'Escribe un mensaje.' });

    const userId = req.userId;
    const conversationId = req.body.conversationId || null;

    let history = [];
    if (conversationId) {
        const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(conversationId), userId });
        if (conv) history = conv.messages || [];
    }

    const messages = [
        { role: 'system', content: MINERD_SYSTEM_PROMPT },
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message }
    ];

    const openaiKey = process.env.OPENAI_API_KEY;

    if (openaiKey && !openaiKey.includes('your_')) {
        try {
            const apiRes = await fetch('https://aiapiv2.pekpik.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                body: JSON.stringify({ model: 'openai/gpt-chat-latest', max_tokens: 2000, temperature: 0.3, messages })
            });
            if (apiRes.ok) {
                const data = await apiRes.json();
                const text = data?.choices?.[0]?.message?.content?.trim() || '';
                if (text) {
                    console.log('Respondido por OpenAI');
                    return res.json({ response: text });
                }
            }
        } catch (e) {
            console.error('OpenAI error:', e.message);
        }
    }

    const googleKey = process.env.GOOGLE_AI_KEY;
    if (googleKey) {
        try {
            const apiRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: MINERD_SYSTEM_PROMPT }] },
                        contents: [{ role: 'user', parts: [{ text: message }] }],
                        generationConfig: { maxOutputTokens: 2000, temperature: 0.3 }
                    })
                }
            );
            if (apiRes.ok) {
                const data = await apiRes.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
                if (text) {
                    console.log('Respondido por Gemini');
                    return res.json({ response: text });
                }
            }
        } catch (e) {
            console.error('Gemini error:', e.message);
        }
    }

    res.json({ response: '⚠️ No pude conectar con los servicios de IA en este momento. Intenta de nuevo más tarde.' });
});

/* ── CONVERSACIONES ─────────────────────────────────────────────────── */
app.get('/api/conversations', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        const conversations = await getDb().collection('conversations')
            .find({ userId }, { projection: { userId: 0 } })
            .sort({ createdAt: -1 })
            .toArray();
        res.json({ conversations: conversations.map(c => ({
            id: c._id.toString(),
            title: c.title || 'Planificación',
            messageCount: (c.messages || []).length,
            createdAt: c.createdAt,
            hasPdf: !!c.pdfGenerated
        })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/conversations', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        const title = String(req.body.title || 'Nueva planificación').trim().slice(0, 100);
        const msg = req.body.message || null;
        const reply = req.body.reply || null;

        const doc = {
            userId,
            title,
            messages: [],
            createdAt: new Date(),
            pdfGenerated: false
        };
        if (msg) doc.messages.push({ role: 'user', content: msg, timestamp: new Date() });
        if (reply) doc.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
        const result = await getDb().collection('conversations').insertOne(doc);
        res.json({ success: true, id: result.insertedId.toString() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        const convId = new mongoose.Types.ObjectId(req.params.id);
        const msg = String(req.body.message || '').trim();
        const reply = String(req.body.reply || '').trim();
        if (!msg && !reply) return res.status(400).json({ error: 'Sin datos' });

        const update = {};
        if (msg) update.$push = { messages: { role: 'user', content: msg, timestamp: new Date() } };
        if (reply) update.$push = { messages: { role: 'assistant', content: reply, timestamp: new Date() } };

        await getDb().collection('conversations').updateOne({ _id: convId, userId }, update);

        if (req.body.title) {
            await getDb().collection('conversations').updateOne({ _id: convId, userId }, { $set: { title: String(req.body.title).trim().slice(0, 100) } });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/conversations/:id', authenticateToken, async (req, res) => {
    try {
        const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
        if (!conv) return res.status(404).json({ error: 'No encontrada' });
        res.json({
            id: conv._id.toString(),
            title: conv.title,
            messages: conv.messages || [],
            createdAt: conv.createdAt,
            hasPdf: !!conv.pdfGenerated
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/conversations/:id', authenticateToken, async (req, res) => {
    try {
        await getDb().collection('conversations').deleteOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── PDF ────────────────────────────────────────────────────────────── */
app.get('/api/conversations/:id/pdf', authenticateToken, async (req, res) => {
    try {
        const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
        if (!conv) return res.status(404).json({ error: 'No encontrada' });

        const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });

        const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="planificacion-${conv._id.toString().slice(-6)}.pdf"`);
        doc.pipe(res);

        const leftMargin = 50;
        const pageWidth = 612;
        const centerX = pageWidth / 2;

        try {
            if (fs.existsSync(path.join(PROJECT_ROOT, 'assets', 'minerd-logo.png'))) {
                doc.image(path.join(PROJECT_ROOT, 'assets', 'minerd-logo.png'), centerX - 30, 20, { width: 60 });
            }
        } catch (e) {}

        doc.fontSize(16).font('Helvetica-Bold').text('Ministerio de Educación de República Dominicana', centerX, 90, { align: 'center' });
        doc.fontSize(12).font('Helvetica').text('Planificación Docente', centerX, 115, { align: 'center' });
        doc.moveDown();

        const dateStr = new Date().toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric' });
        doc.fontSize(9).fillColor('#666').text(`Generado el ${dateStr}`, { align: 'right' });
        doc.fillColor('#000');

        doc.moveDown();
        doc.moveTo(leftMargin, doc.y).lineTo(pageWidth - leftMargin, doc.y).stroke('#ccc');
        doc.moveDown();

        const titleText = conv.title || 'Planificación Docente';
        doc.fontSize(14).font('Helvetica-Bold').text(titleText, leftMargin, doc.y, { underline: true });
        doc.moveDown();

        if (user && user.name) {
            doc.fontSize(10).font('Helvetica').text(`Docente: ${user.name}     Celular: ${user.phone}`);
            doc.moveDown(0.5);
        }

        doc.moveTo(leftMargin, doc.y).lineTo(pageWidth - leftMargin, doc.y).stroke('#ccc');
        doc.moveDown();

        const messages = conv.messages || [];
        for (const msg of messages) {
            const label = msg.role === 'user' ? 'Docente' : 'PlanifIA';
            const color = msg.role === 'user' ? '#1a56db' : '#059669';

            if (doc.y > 700) doc.addPage();

            doc.fontSize(10).font('Helvetica-Bold').fillColor(color).text(`${label}:`);
            doc.fontSize(9).font('Helvetica').fillColor('#333');

            const content = String(msg.content || '');
            const lines = content.split('\n');
            for (const line of lines) {
                if (doc.y > 730) doc.addPage();
                doc.text(line.length > 0 ? line : ' ', leftMargin + 10, doc.y, { width: pageWidth - leftMargin - 60 });
            }
            doc.fillColor('#000');
            doc.moveDown(0.3);
            doc.moveTo(leftMargin, doc.y).lineTo(pageWidth - leftMargin, doc.y).stroke('#eee');
            doc.moveDown(0.3);
        }

        doc.moveDown(2);
        doc.fontSize(8).fillColor('#999').text('Documento generado por El Profe 2.0 - Sistema de Planificación Docente MINERD', { align: 'center' });
        doc.text('Los datos contenidos en este documento son responsabilidad del docente.', { align: 'center' });

        doc.end();

        await getDb().collection('conversations').updateOne(
            { _id: new mongoose.Types.ObjectId(req.params.id) },
            { $set: { pdfGenerated: true } }
        );
    } catch (err) {
        console.error('PDF error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Error generando PDF' });
    }
});

/* ── USER INFO ──────────────────────────────────────────────────────── */
app.get('/api/user', authenticateToken, async (req, res) => {
    try {
        const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });
        if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ id: user._id.toString(), phone: user.phone, name: user.name || '' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/user', authenticateToken, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        await getDb().collection('users').updateOne({ _id: new mongoose.Types.ObjectId(req.userId) }, { $set: { name } });
        res.json({ success: true, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ── START ──────────────────────────────────────────────────────────── */
async function start() {
    await connectMongo();
    app.listen(PORT, () => {
        console.log(`El Profe 2.0 corriendo en puerto ${PORT}`);
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
