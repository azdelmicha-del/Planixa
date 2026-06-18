const mongoose = require('mongoose');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { getDb } = require('../db');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { logApiUsage } = require('../finance');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const os = require('os');

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dest = path.join(__dirname, '../../public/uploads/formats');
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        cb(null, dest);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

module.exports = function (app) {
    // --- SUPERVISOR IA ---
    app.get('/api/admin/supervisor_logs', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const logs = await getDb().collection('supervisor_logs').find({}).sort({ date: -1 }).limit(100).toArray();
            
            // Get settings status
            const settings = await getDb().collection('settings').findOne({ _id: 'general' });
            const enabled = settings?.supervisor_enabled === true;
            const rules = settings?.supervisor_rules || '';
            
            res.json({ logs, enabled, rules });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/admin/db-stats', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const db = getDb();
            const stats = await db.db.command({ dbStats: 1 });
            res.json(stats);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/settings/supervisor', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const updateFields = {};
            if (req.body.enabled !== undefined) updateFields.supervisor_enabled = req.body.enabled === true;
            if (req.body.rules !== undefined) updateFields.supervisor_rules = req.body.rules;
            
            await getDb().collection('settings').updateOne({ _id: 'general' }, { $set: updateFields }, { upsert: true });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.get('/api/admin/users', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            console.log("Admin requested /api/admin/users. User ID:", req.userId);
            const users = await getDb().collection('users').find({}, { projection: { password: 0 } }).sort({ created_at: -1 }).toArray();
            console.log("Found users for admin:", users.length);
            res.json({ users: users.map(u => ({ id: u._id.toString(), phone: u.phone, name: u.name || '', grade: u.grade || '', area: u.area || '', school: u.school || '', role: u.role, is_admin: !!u.is_admin, plan: u.plan || 'free', plan_expires: u.plan_expires, plans_count: u.plans_count || 0, created_at: u.created_at })) });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/users/:id/role', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const is_admin = req.body.is_admin === true;
            await getDb().collection('users').updateOne({ _id }, { $set: { is_admin, role: is_admin ? 'admin' : 'teacher' } });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/users/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const update = {};
            if (req.body.name !== undefined) update.name = String(req.body.name || '').trim();
            if (req.body.grade !== undefined) update.grade = String(req.body.grade || '').trim();
            if (req.body.area !== undefined) update.area = String(req.body.area || '').trim();
            if (req.body.school !== undefined) update.school = String(req.body.school || '').trim();
            if (req.body.phone !== undefined) update.phone = String(req.body.phone || '').trim();
            if (req.body.plan !== undefined) update.plan = String(req.body.plan);
            if (req.body.plan_expires !== undefined) update.plan_expires = req.body.plan_expires ? new Date(req.body.plan_expires) : null;
            if (req.body.resetCount === true) update.plans_count = 0;
            await getDb().collection('users').updateOne({ _id }, { $set: update });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });


    app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const user = await getDb().collection('users').findOne({ _id });
            if (!user) return res.status(404).json({ error: 'No encontrado' });
            if (user.is_admin) return res.status(400).json({ error: 'No puedes eliminar un admin' });
            await getDb().collection('users').deleteOne({ _id });
            await getDb().collection('conversations').deleteMany({ userId: req.params.id });
            await getDb().collection('references').deleteMany({ userId: req.params.id });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/admin/users/:id/chat', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const userId = req.params.id;
            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
            if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
            
            // Get messages directly from client_messages if available, or extract from conversations
            const messages = await getDb().collection('client_messages').find({ phone: user.phone }).sort({ createdAt: 1 }).toArray();
            
            // Also get conversation history from 'conversations' collection if we want the AI context
            const convs = await getDb().collection('conversations').find({ userId }).sort({ createdAt: -1 }).limit(10).toArray();
            
            res.json({ messages, conversations: convs });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/admin/users/:id/chat', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const userId = req.params.id;
            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
            if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
            
            await getDb().collection('client_messages').deleteMany({ phone: user.phone });
            await getDb().collection('conversations').deleteMany({ userId });
            
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/users/:id/message', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const userId = req.params.id;
            const message = req.body.message;
            if (!message) return res.status(400).json({ error: 'Mensaje vacío' });
            
            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
            if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
            
            // Si el usuario usa WhatsApp, lo enviamos por esa vía
            if (user.phone) {
                // Registrar en la colección para que aparezca en el chat
                await getDb().collection('client_messages').insertOne({
                    phone: user.phone,
                    message: message,
                    direction: 'outgoing', // Identificar como enviado desde el sistema
                    createdAt: new Date()
                });
                
                // Enviar usando la API de Facebook Graph si está configurada
                const WA_TOKEN = process.env.WA_TOKEN;
                const WA_PHONE_ID = process.env.WA_PHONE_ID;
                if (WA_TOKEN && WA_PHONE_ID) {
                    await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
                        body: JSON.stringify({ messaging_product: 'whatsapp', to: user.phone, type: 'text', text: { body: message } })
                    }).catch(console.error);
                } else {
                    console.log('Modo simulador WA. Mensaje enviado a', user.phone, ':', message);
                }
            } 
            
            // Siempre agregarlo a su conversación principal para que quede registro
            let query = { userId };
            if (user.phone) query.is_whatsapp = true; // Si es usuario de WA, buscar su conv de WA
            const activeConv = await getDb().collection('conversations').find(query).sort({ createdAt: -1 }).limit(1).toArray();
            
            if (activeConv && activeConv.length > 0) {
                await getDb().collection('conversations').updateOne(
                    { _id: activeConv[0]._id },
                    { 
                        $push: { messages: { role: 'assistant', content: `[Admin]: ${message}`, timestamp: new Date() } },
                        $set: { lastMsg: `[Admin]: ${message}` } 
                    }
                );
            } else {
                let insertDoc = {
                    userId: userId,
                    createdAt: new Date(),
                    title: user.phone ? 'WhatsApp (Admin)' : 'Soporte Web',
                    lastMsg: `[Admin]: ${message}`,
                    messages: [{ role: 'assistant', content: `[Admin]: ${message}`, timestamp: new Date() }]
                };
                if (user.phone) insertDoc.is_whatsapp = true;
                await getDb().collection('conversations').insertOne(insertDoc);
            }
            
            res.json({ success: true });
        } catch (err) {
            console.error('Error enviando mensaje al cliente:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/admin/ai', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const { message, context } = req.body;
            const db = getDb();
            const totalUsers = await db.collection('users').countDocuments();
            const totalConversations = await db.collection('conversations').countDocuments();
            const totalMessages = await db.collection('client_messages').countDocuments();
            
            const recentMessages = await db.collection('client_messages').find({ direction: 'incoming' }).sort({ createdAt: -1 }).limit(30).toArray();
            const recentMessagesText = recentMessages.map(m => `[${new Date(m.createdAt).toLocaleDateString()}] ${m.phone}: ${m.message}`).join('\n');
            
            const topUsers = await db.collection('users').find({}).sort({ plans_count: -1 }).limit(20).toArray();
            const usersSummary = topUsers.map(u => `- ${u.name || u.phone} (Plan: ${u.plan || 'free'}): ${u.plans_count || 0} planificaciones`).join('\n');

            const systemPrompt = `Eres el asistente experto del CEO de 'Planixa', un SaaS B2B/B2C de planificación docente en República Dominicana.
Tu objetivo es analizar datos de clientes, detectar quejas o fricciones, sugerir mejoras en ventas, y ayudar a tomar decisiones de negocio.
Responde de forma clara, directa, profesional y muy analítica. Nunca des respuestas genéricas. Ve al grano.

=== DATOS EN VIVO DE LA PLATAFORMA ===
- Usuarios Registrados: ${totalUsers}
- Planificaciones Creadas: ${totalConversations}
- Mensajes de WhatsApp procesados: ${totalMessages}

=== TOP USUARIOS ===
${usersSummary || 'No hay datos suficientes.'}

=== ÚLTIMOS MENSAJES DE CLIENTES ===
(Usa esto para detectar quejas, bugs reportados o dudas frecuentes)
${recentMessagesText || 'No hay mensajes recientes.'}
`;
            
            const messages = [
                { role: 'system', content: systemPrompt },
            ];
            
            if (context) {
                messages.push({ role: 'user', content: `El administrador está viendo actualmente el perfil de este cliente: ${JSON.stringify(context)}` });
            }
            messages.push({ role: 'user', content: message });
            
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: messages,
                    max_tokens: 1500,
                    temperature: 0.5
                })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error?.message || 'Error en OpenAI');
            
            if (data.usage) await logApiUsage(req.userId, 'Admin: Asistente SaaS', 'gpt-4o', data.usage);
            
            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                console.error("OpenAI no devolvió texto válido:", JSON.stringify(data));
                return res.json({ response: "Lo siento, la IA no devolvió una respuesta válida." });
            }
            res.json({ response: data.choices[0].message.content });
        } catch (err) { 
            console.error('Error en /api/admin/ai:', err);
            res.status(500).json({ error: err.message }); 
        }
    });

    app.get('/api/admin/dashboard', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const db = getDb();
            const totalUsers = await db.collection('users').countDocuments();
            const now = new Date();
            const totalConversations = await db.collection('conversations').countDocuments();
            
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const recentUsers = await db.collection('users').countDocuments({ created_at: { $gte: sevenDaysAgo } });

            const planPrices = {
                'trial': 0,
                '1_week': 60,
                '1_month': 190,
                '3_months': 500,
                '6_months': 900,
                '1_year': 1500,
                'lifetime': 0
            };

            const allUsers = await db.collection('users').find({}).toArray();
            let proUsersCount = 0;
            let freeUsersCount = 0;
            let exemptUsersCount = 0;
            let adminUsersCount = 0;
            let mrr = 0;

            allUsers.forEach(u => {
                if (u.is_admin) {
                    adminUsersCount++;
                } else if (u.plan === 'exempt') {
                    exemptUsersCount++;
                } else if (u.plan === 'free' || !u.plan) {
                    freeUsersCount++;
                } else {
                    let isActivePro = false;
                    if (u.plan === 'lifetime') isActivePro = true;
                    else if (u.plan_expires && new Date(u.plan_expires) > now) isActivePro = true;
                    
                    if (isActivePro) {
                        proUsersCount++;
                        if (u.plan !== 'lifetime' && u.plan !== 'trial') {
                            mrr += (planPrices[u.plan] || 190);
                        }
                    } else {
                        freeUsersCount++; // Expirados cuentan como gratis
                    }
                }
            });

            res.json({
                totalUsers: allUsers.length,
                activeUsers: proUsersCount,
                freeUsersCount,
                exemptUsersCount,
                adminUsersCount,
                totalConversations,
                recentUsers,
                mrr: mrr
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // --- FINANZAS ---
    app.get('/api/admin/finance', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const db = getDb();
            const settings = await db.collection('settings').findOne({ _id: 'general' });
            const balance = settings?.api_balance || 0;
            const logs = await db.collection('api_usage').find({}).sort({ date: -1 }).limit(100).toArray();
            res.json({ balance, logs });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/admin/finance/deposit', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const amount = parseFloat(req.body.amount);
            if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Monto inválido' });
            
            const db = getDb();
            await db.collection('settings').updateOne(
                { _id: 'general' },
                { $inc: { api_balance: amount } },
                { upsert: true }
            );

            // Log de recarga
            await db.collection('api_usage').insertOne({
                date: new Date(),
                identifier: 'Admin',
                action: 'Recarga de Saldo (Depósito)',
                model: 'N/A',
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                cost: 0, // 0 porque no es un gasto, el deposito suma al balance.
                deposit: amount
            });

            res.json({ success: true, added: amount });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/admin/finance/deposit/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const newAmount = parseFloat(req.body.amount);
            if (isNaN(newAmount) || newAmount <= 0) return res.status(400).json({ error: 'Monto inválido' });
            
            const db = getDb();
            const logId = new mongoose.Types.ObjectId(req.params.id);
            const existingLog = await db.collection('api_usage').findOne({ _id: logId, deposit: { $exists: true } });
            
            if (!existingLog) return res.status(404).json({ error: 'Recarga no encontrada' });
            
            const diff = newAmount - existingLog.deposit;
            
            // Actualizar log
            await db.collection('api_usage').updateOne(
                { _id: logId },
                { $set: { deposit: newAmount } }
            );

            // Actualizar balance global con la diferencia
            await db.collection('settings').updateOne(
                { _id: 'general' },
                { $inc: { api_balance: diff } },
                { upsert: true }
            );

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/admin/broadcast', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const { message, filter } = req.body;
            if (!message) return res.status(400).json({ error: 'Mensaje requerido' });
            
            // This is a placeholder for actual WhatsApp/Email integration
            // e.g. await sendWhatsAppMessage(to, message)
            
            console.log(`[BROADCAST] Enviar a ${filter || 'todos'}: ${message}`);
            
            res.json({ success: true, message: 'Difusión enviada correctamente en modo simulación' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    const DEFAULT_PROMPT = `Eres "Planixa Asistente", el asistente conversacional de planificación docente del Ministerio de Educación de República Dominicana (MINERD).

PERSONALIDAD:
- Eres cercano, amable y profesional. Nada robótico.
- Hablas como un compañero docente que ayuda a otro docente.
- Usas "profe" más el nombre del profesor para dirigirte al usuario.
- Siempre respondes en español dominicano.

FUNCIÓN PRINCIPAL:
Ayudas a maestros dominicanos a crear PLANIFICACIONES DOCENTES completas. Puedes generar:
1. UNIDADES DIDÁCTICAS
2. PLANIFICACIONES DIARIAS
3. PLANIFICACIONES SEMANALES
4. RÚBRICAS, LISTAS DE COTEJO, ESCALAS ESTIMATIVAS.
5. PRUEBAS, ACTIVIDADES DIAGNÓSTICAS, GUÍAS DE TRABAJO.

CONOCIMIENTO CURRICULAR (MINERD):
- Niveles: Inicial, Primario, Secundario
NIVEL INICIAL
-	Primer Ciclo: Comprende desde los 45 días de nacidos hasta los 2 años y 11 meses (abarca los grados Maternal e Infante). Se centra en la estimulación temprana, el desarrollo sensorio-motor, el apego seguro y la exploración del entorno.
-	Segundo Ciclo: Comprende desde los 3 años hasta los 5 años y 11 meses (abarca los grados Pre-kinder, Kindergarten y Preprimario). Se enfoca en el desarrollo del lenguaje, la socialización, la autonomía, la expresión creativa y la preparación formal para la educación primaria (siendo el último año obligatorio).
NIVEL PRIMARIO
-	Primer Ciclo: Comprende desde 1er hasta 3er grado de Primaria (niños de 6 a 8 años aproximadamente). Se enfoca en la alfabetización inicial, la adquisición de la lectura y escritura, el desarrollo del pensamiento lógico-matemático y la socialización básica.
-	Segundo Ciclo: Comprende desde 4to hasta 6to grado de Primaria (niños de 9 a 11 años aproximadamente). Se centra en el afianzamiento de las habilidades de lectura y escritura, el desarrollo del pensamiento crítico, la investigación científica elemental y el fortalecimiento de los valores ciudadanos.
NIVEL SECUNDARIO
-	Primer Ciclo: Comprende desde 1er hasta 3er grado de Secundaria (anteriormente 7mo, 8vo y 1er año de bachillerato, para estudiantes de 12 a 14 años aproximadamente). Se enfoca en la transición formativa, el desarrollo de competencias científicas y tecnológicas, y el pensamiento abstracto.
-	Segundo Ciclo: Comprende desde 4to hasta 6to grado de Secundaria (anteriormente 2do, 3ro y 4to de bachillerato, para estudiantes de 15 a 17 años aproximadamente). Se organiza en tres modalidades (Académica, Técnico-Profesional y Artes) y se centra en la preparación especializada para la educación superior y el mundo laboral.
- Enfoque por competencias y ejes transversales
- Estructura formal dominicana: inicio-desarrollo-cierre

FLUJO DE CONVERSACIÓN Y PREGUNTAS (REGLA ESTRICTA):
- Identifica qué tipo de documento necesita.
- Recolecta datos de forma natural si faltan (nombre completo, grado, área, tema).
- Para las planificaciones diarias, pregunta para qué tiempo desea planificar (generalmente 45 minutos o 90 minutos).
- PROHIBICIÓN ABSOLUTA: ESTÁ ESTRICTAMENTE PROHIBIDO HACER MÁS DE 2 PREGUNTAS EN UN SOLO MENSAJE. Si necesitas 4 datos, primero haz 1 o 2 preguntas. Espera la respuesta del usuario. Luego haz las siguientes. NUNCA envíes una lista de 3 o más preguntas.
- Entrega la planificación con estructura formal y clara, sin markdown excesivo.
- Al enviar el ejemplo de la planificación debe ser en un solo mensaje estilo "path"

EDICIÓN:
- Si el usuario pide cambios (más corta, más actividades, cambiar grado, etc.), ajusta la planificación.
- Siempre pregunta si quedó bien o quiere más ajustes.

REGLAS DE GENERACIÓN DE PDF:
Antes de generar el PDF debe recolectar o confirmar los datos del profesor como (nombre completo, grado, materia y demás)
Si el usuario te pide explícitamente "Envíame un PDF", "Hazme un PDF", "Quiero eso en PDF", o "Descargar" sobre la planificación actual, DEBES responder EXACTAMENTE incluyendo esta palabra mágica en tu respuesta: [GENERATE_PDF] y luego añades un mensaje amable indicando que el PDF se está enviando.
Si no pide un PDF explícitamente, responde normalmente.`;

    // --- GESTOR DE PROMPTS (AGENTES) ---
    app.get('/api/admin/prompts', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            let prompts = await getDb().collection('prompts').find({}).toArray();
            if (prompts.length === 0) {
                // Seed default
                const defaultPrompt = { 
                    name: "Planixa Principal", 
                    description: "Usa este agente por defecto para cualquier solicitud general de planificación, tareas o asistencia estándar.", 
                    content: DEFAULT_PROMPT,
                    created_at: new Date()
                };
                const result = await getDb().collection('prompts').insertOne(defaultPrompt);
                defaultPrompt._id = result.insertedId;
                prompts = [defaultPrompt];
            }
            res.json(prompts.map(p => ({ id: p._id.toString(), name: p.name, description: p.description, content: p.content })));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/prompts', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const { name, description, content } = req.body;
            if (!name || !content) return res.status(400).json({ error: 'Nombre y contenido son requeridos' });
            
            const newPrompt = { name, description, content, created_at: new Date() };
            const result = await getDb().collection('prompts').insertOne(newPrompt);
            res.json({ success: true, id: result.insertedId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/prompts/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const { name, description, content } = req.body;
            await getDb().collection('prompts').updateOne({ _id }, { $set: { name, description, content, updated_at: new Date() } });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/admin/prompts/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            await getDb().collection('prompts').deleteOne({ _id });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // --- GESTOR DE FORMATOS DOCUMENTALES (PDF/WORD) ---
    app.get('/api/admin/formats', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const formats = await getDb().collection('doc_formats').find({}).toArray();
            res.json(formats.map(f => ({ 
                id: f._id.toString(), 
                type: f.type, 
                fileName: f.fileName,
                filePath: f.filePath,
                instructions: f.instructions || ''
            })));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/formats', authenticateToken, upload.single('templateFile'), async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const { type, instructions } = req.body;
            if (!type) return res.status(400).json({ error: 'El tipo de documento es requerido' });
            
            const newFormat = { type, instructions: instructions || '', created_at: new Date() };
            
            if (req.file) {
                newFormat.fileName = req.file.originalname;
                newFormat.filePath = '/uploads/formats/' + req.file.filename;
            } else {
                return res.status(400).json({ error: 'Debes subir un archivo de plantilla (.docx)' });
            }

            const result = await getDb().collection('doc_formats').insertOne(newFormat);
            res.json({ success: true, id: result.insertedId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/formats/:id', authenticateToken, upload.single('templateFile'), async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const { type, instructions } = req.body;
            
            const updateData = { type, instructions: instructions || '', updated_at: new Date() };
            
            if (req.file) {
                updateData.fileName = req.file.originalname;
                updateData.filePath = '/uploads/formats/' + req.file.filename;
            }
            
            await getDb().collection('doc_formats').updateOne({ _id }, { $set: updateData });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/admin/formats/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            await getDb().collection('doc_formats').deleteOne({ _id });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // --- BASE DE CONOCIMIENTOS ---
    app.post('/api/admin/knowledge/extract', authenticateToken, upload.single('knowledgeFile'), async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
            
            const filePath = req.file.path;
            const ext = path.extname(req.file.originalname).toLowerCase();
            let extractedText = '';

            if (ext === '.pdf') {
                const { PDFParse } = require('pdf-parse');
                const dataBuffer = fs.readFileSync(filePath);
                const parser = new PDFParse({ data: dataBuffer });
                const data = await parser.getText();
                extractedText = data.text;
                await parser.destroy();
            } else if (ext === '.docx' || ext === '.doc') {
                // mammoth funciona mejor con docx. Para doc antiguo podría fallar, pero la UI pide docx principalmente.
                const result = await mammoth.extractRawText({ path: filePath });
                extractedText = result.value;
            } else if (ext === '.txt') {
                extractedText = fs.readFileSync(filePath, 'utf8');
            } else {
                fs.unlinkSync(filePath); 
                return res.status(400).json({ error: 'Formato no soportado. Usa PDF, DOCX o TXT.' });
            }

            fs.unlinkSync(filePath);
            res.json({ success: true, text: extractedText });
        } catch (err) { 
            if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.status(500).json({ error: err.message }); 
        }
    });

    app.get('/api/admin/knowledge', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const items = await getDb().collection('knowledge').find({}).sort({ created_at: -1 }).toArray();
            res.json({ items: items.map(i => ({ id: i._id.toString(), title: i.title, content: i.content, created_at: i.created_at })) });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/knowledge', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const { title, content } = req.body;
            if (!title || !content) return res.status(400).json({ error: 'Título y Contenido son requeridos' });
            const result = await getDb().collection('knowledge').insertOne({ title, content, created_at: new Date() });
            res.json({ success: true, id: result.insertedId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/knowledge/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const { title, content } = req.body;
            if (!title || !content) return res.status(400).json({ error: 'Título y Contenido son requeridos' });
            await getDb().collection('knowledge').updateOne({ _id }, { $set: { title, content, updated_at: new Date() } });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/admin/knowledge/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            await getDb().collection('knowledge').deleteOne({ _id });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // --- SSE MONITOR DE SISTEMA ---
    app.get('/api/admin/monitor/stream', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Enviar un log inicial
        res.write(`data: ${JSON.stringify({ type: 'INIT', msg: 'Conexión establecida con el Monitor del Sistema', date: new Date().toISOString() })}\n\n`);

        const sendMetrics = () => {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const memPercent = Math.round((usedMem / totalMem) * 100);
            
            // Aproximación simple de carga de CPU usando loadavg
            const cpus = os.cpus().length;
            const load = os.loadavg()[0];
            const cpuPercent = Math.min(Math.round((load / cpus) * 100), 100);

            res.write(`data: ${JSON.stringify({ type: 'METRICS', ram: memPercent, cpu: cpuPercent, uptime: os.uptime(), date: new Date().toISOString() })}\n\n`);
        };

        const metricsInterval = setInterval(sendMetrics, 2000);

        const logListener = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        app.on('system_log', logListener);

        req.on('close', () => {
            clearInterval(metricsInterval);
            app.removeListener('system_log', logListener);
        });
    });
};
