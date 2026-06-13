const { getDb } = require('../db');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const WA_VERIFY_TOKEN = 'elprofe2_verify_2026';

module.exports = function (app) {
    app.get('/webhook/whatsapp', (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
            console.log('WhatsApp webhook verificado');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    });

    app.post('/webhook/whatsapp', async (req, res) => {
        res.sendStatus(200);
        console.log('WEBHOOK RECIBIDO BRUTO:', JSON.stringify(req.body, null, 2));
        try {
            const entry = req.body?.entry?.[0];
            const change = entry?.changes?.[0];
            const msg = change?.value?.messages?.[0];
            if (!msg || msg.type !== 'text') return;

            const from = msg.from;
            const text = String(msg.text?.body || '').trim();
            if (!text) return;

            console.log('WhatsApp de', from, ':', text);
            await getDb().collection('client_messages').insertOne({ phone: from, message: text, direction: 'incoming', employeeId: null, employeeName: null, createdAt: new Date() });

            let userId;
            let user = await getDb().collection('users').findOne({ phone: from });
            if (!user) {
                const hashed = await bcrypt.hash(from.slice(-6), 12);
                const result = await getDb().collection('users').insertOne({ phone: from, password: hashed, name: '', grade: '', area: '', school: '', role: 'teacher', is_admin: false, plan: 'free', plan_expires: null, created_at: new Date() });
                userId = result.insertedId.toString();
                user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
                const welcomeReply = '¡Hola, profe! \n\nA partir de hoy voy a ser tu asistente de planificaciones.\n\nPuedo ayudarte a crear unidades, secuencias, planificaciones diarias, rúbricas, listas de cotejo, evaluaciones y actividades.\n\nAntes de empezar, cuéntame:\n📌 ¿Cuál es tu nombre?\n📌 ¿Qué grado y área trabajas normalmente?\n\nAsí puedo guardar tus planificaciones organizadas y adaptadas a ti.';
                const WA_TOKEN = process.env.WA_TOKEN;
                const WA_PHONE_ID = process.env.WA_PHONE_ID;
                if (WA_TOKEN && WA_PHONE_ID) {
                    await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
                        body: JSON.stringify({ messaging_product: 'whatsapp', to: from, type: 'text', text: { body: welcomeReply } })
                    });
                }
                return;
            }
            userId = user._id.toString();
            if (!user.name) {
                const askReply = '¡Hola de nuevo, profe! \n\nAntes de empezar, dime tu nombre y el grado que normalmente trabajas para guardar tus planificaciones organizadas.';
                const WA_TOKEN = process.env.WA_TOKEN;
                const WA_PHONE_ID = process.env.WA_PHONE_ID;
                if (WA_TOKEN && WA_PHONE_ID) {
                    await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
                        body: JSON.stringify({ messaging_product: 'whatsapp', to: from, type: 'text', text: { body: askReply } })
                    });
                }
                return;
            }

            const refDocs = await getDb().collection('references').find({ userId }).toArray();
            let refBlock = '';
            if (refDocs.length > 0) {
                refBlock = '\n\nDOCUMENTOS DE REFERENCIA:\n' + refDocs.map(r => `📄 ${r.name}: ${(r.text||'').slice(0,2000)}`).join('\n---\n');
            }

            const MINERD_SYSTEM_PROMPT = `Eres "Planixa", el asistente conversacional de planificación docente del Ministerio de Educación de República Dominicana (MINERD).

PERSONALIDAD:
- Eres cercano, amable y profesional. Nada robótico.
- Hablas como un compañero docente que ayuda a otro docente.
- Usas "profe" para dirigirte al usuario.
- Siempre respondes en español dominicano.

FUNCIÓN PRINCIPAL:
Ayudas a maestros dominicanos a crear PLANIFICACIONES DOCENTES completas. Puedes generar:

1. UNIDADES DIDÁCTICAS: nombre, situación de aprendizaje, competencias, indicadores, contenidos, estrategias, recursos, evaluación, evidencias, secuencia de clases, adecuaciones, producto final.
2. PLANIFICACIONES DIARIAS: tema, propósito, inicio, desarrollo, cierre, actividades, recursos, evaluación, tarea, evidencia, observaciones.
3. PLANIFICACIONES SEMANALES: lunes a viernes con actividades, evaluación y tareas.
4. RÚBRICAS, LISTAS DE COTEJO, ESCALAS ESTIMATIVAS.
5. PRUEBAS, ACTIVIDADES DIAGNÓSTICAS, GUÍAS DE TRABAJO.

CONOCIMIENTO CURRICULAR (MINERD):
- Niveles: Inicial, Primario (1ero a 6to), Secundario (1ero a 6to)
- Áreas: Lengua Española, Matemática, Ciencias Sociales, Ciencias de la Naturaleza, Inglés, Educación Física, Formación Humana, Educación Artística
- Competencias fundamentales y específicas por grado
- Indicadores de logro, contenidos conceptuales/procedimentales/actitudinales
- Enfoque por competencias y ejes transversales
- Estructura formal dominicana: inicio-desarrollo-cierre

FLUJO DE CONVERSACIÓN:
- Si el usuario pide algo, identifica qué tipo de documento necesita (unidad, diaria, semanal, rúbrica, etc.)
- Recolecta datos de forma natural, preguntando de a una cosa a la vez
- Si falta grado, área o tema, pregunta amablemente
- Usa la información del perfil del docente si está disponible

ENTREGA:
- Entrega la planificación con estructura formal y clara
- Usa texto plano con saltos de línea (sin markdown)
- Al final pregunta: "¿Quieres que le haga algún cambio, profe?"
- Ofrece: "También puedo hacerte una rúbrica, lista de cotejo o actividad de evaluación para esta misma clase."

EDICIÓN:
- Si el usuario pide cambios (más corta, más actividades, cambiar grado, etc.), ajusta la planificación
- Siempre pregunta si quedó bien o quiere más ajustes

REGLAS:
- No inventes referencias bibliográficas
- Si no entiendes exactamente qué quiere, pregunta amablemente
- Mantén un tono cálido pero profesional`;

            const systemWithRefs = MINERD_SYSTEM_PROMPT + refBlock;
            const messages = [{ role: 'system', content: systemWithRefs }, { role: 'user', content: text }];

            let reply = '⚠️ No pude procesar tu solicitud. Intenta de nuevo.';
            try {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 2000, temperature: 0.3, messages })
                });
                if (r.ok) {
                    const d = await r.json();
                    const t = d?.choices?.[0]?.message?.content?.trim();
                    if (t) reply = t;
                }
            } catch (e) {}

            const now = new Date();
            await getDb().collection('conversations').insertOne({
                userId, title: 'WhatsApp: ' + text.slice(0, 50), messages: [
                    { role: 'user', content: text, timestamp: now },
                    { role: 'assistant', content: reply, timestamp: new Date() }
                ], createdAt: now, pdfGenerated: false
            });

            await getDb().collection('client_messages').insertOne({ phone: from, message: reply, direction: 'outgoing', employeeId: null, employeeName: 'Bot WhatsApp', createdAt: new Date() });
            const WA_TOKEN = process.env.WA_TOKEN;
            const WA_PHONE_ID = process.env.WA_PHONE_ID;
            if (WA_TOKEN && WA_PHONE_ID) {
                await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
                    body: JSON.stringify({
                        messaging_product: 'whatsapp', to: from, type: 'text',
                        text: { body: reply.slice(0, 4096) }
                    })
                });
            } else {
                console.log('Respuesta (simulada):', reply.slice(0, 100) + '...');
            }
        } catch (err) {
            console.error('WhatsApp webhook error:', err.message);
        }
    });
};
