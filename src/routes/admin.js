const mongoose = require('mongoose');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { getDb } = require('../db');

module.exports = function (app) {
    app.get('/api/admin/users', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            console.log("Admin requested /api/admin/users. User ID:", req.userId);
            const users = await getDb().collection('users').find({}, { projection: { password: 0 } }).sort({ created_at: -1 }).toArray();
            console.log("Found users for admin:", users.length);
            res.json({ users: users.map(u => ({ id: u._id.toString(), phone: u.phone, name: u.name || '', role: u.role, is_admin: !!u.is_admin, plan: u.plan || 'free', plan_expires: u.plan_expires, plans_count: u.plans_count || 0, created_at: u.created_at })) });
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
            const activeUsers = await db.collection('users').countDocuments({ plan: { $ne: 'free' } });
            const totalConversations = await db.collection('conversations').countDocuments();
            
            // Simple logic for new users in last 7 days
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const recentUsers = await db.collection('users').countDocuments({ created_at: { $gte: sevenDaysAgo } });

            res.json({
                totalUsers,
                activeUsers,
                totalConversations,
                recentUsers,
                mrr: activeUsers * 15 // Assuming $15 avg per paid user
            });
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

    const DEFAULT_PROMPT = `Eres "Planixa", el asistente conversacional de planificación docente del Ministerio de Educación de República Dominicana (MINERD).

PERSONALIDAD:
- Eres cercano, amable y profesional. Nada robótico.
- Hablas como un compañero docente que ayuda a otro docente.
- Usas "profe" para dirigirte al usuario.
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
- Enfoque por competencias y ejes transversales
- Estructura formal dominicana: inicio-desarrollo-cierre

FLUJO DE CONVERSACIÓN Y PREGUNTAS (REGLA ESTRICTA):
- Identifica qué tipo de documento necesita.
- Recolecta datos de forma natural si faltan (grado, área, tema).
- Para las planificaciones diarias, pregunta para qué tiempo desea planificar (generalmente 45 minutos o 90 minutos).
- PROHIBICIÓN ABSOLUTA: ESTÁ ESTRICTAMENTE PROHIBIDO HACER MÁS DE 2 PREGUNTAS EN UN SOLO MENSAJE. Si necesitas 4 datos, primero haz 1 o 2 preguntas. Espera la respuesta del usuario. Luego haz las siguientes. NUNCA envíes una lista de 3 o más preguntas.
- Entrega la planificación con estructura formal y clara, sin markdown excesivo.

EDICIÓN:
- Si el usuario pide cambios (más corta, más actividades, cambiar grado, etc.), ajusta la planificación.
- Siempre pregunta si quedó bien o quiere más ajustes.

REGLAS DE GENERACIÓN DE PDF:
Si el usuario te pide explícitamente "Envíame un PDF", "Hazme un PDF", "Quiero eso en PDF", o "Descargar" sobre la planificación actual, DEBES responder EXACTAMENTE incluyendo esta palabra mágica en tu respuesta: [GENERATE_PDF] y luego añades un mensaje amable indicando que el PDF se está enviando.
Si no pide un PDF explícitamente, responde normalmente.`;

    app.get('/api/admin/settings', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            let config = await getDb().collection('settings').findOne({ _id: 'global' });
            if (!config) {
                config = { _id: 'global', system_prompt: DEFAULT_PROMPT };
                await getDb().collection('settings').insertOne(config);
            }
            res.json(config);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/settings', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const { system_prompt } = req.body;
            await getDb().collection('settings').updateOne(
                { _id: 'global' },
                { $set: { system_prompt: system_prompt || DEFAULT_PROMPT } },
                { upsert: true }
            );
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
};
