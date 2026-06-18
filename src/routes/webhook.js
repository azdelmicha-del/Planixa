const { getDb } = require('../db');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { logApiUsage } = require('../finance');
const { callSupervisor } = require('../utils/supervisor');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'elprofe2_verify_2026';
const PROJECT_ROOT = path.resolve(__dirname, '../..');

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
            const validTypes = ['text', 'audio', 'image', 'document'];
            if (!msg || !validTypes.includes(msg.type)) return;

            const from = msg.from;
            let text = '';
            
            if (msg.type === 'text') {
                text = String(msg.text?.body || '').trim();
            } else {
                try {
                    let mediaId, mimeType;
                    if (msg.type === 'audio') {
                        mediaId = msg.audio.id;
                        mimeType = msg.audio.mime_type;
                        const buffer = await downloadWhatsAppMedia(mediaId);
                        const transcription = await processAudioWhisper(buffer);
                        text = `[Nota de voz transcrita]: ${transcription}`;
                    } else if (msg.type === 'image') {
                        mediaId = msg.image.id;
                        mimeType = msg.image.mime_type;
                        const buffer = await downloadWhatsAppMedia(mediaId);
                        const visionText = await processImageGPT(buffer, mimeType);
                        text = `[Imagen analizada por IA. Contenido]: ${visionText}`;
                    } else if (msg.type === 'document') {
                        mediaId = msg.document.id;
                        mimeType = msg.document.mime_type;
                        const filename = msg.document.filename || '';
                        const buffer = await downloadWhatsAppMedia(mediaId);
                        
                        if (mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
                            const pdfText = await processPDF(buffer);
                            text = `[Documento PDF "${filename}" extraído]: ${pdfText}`;
                        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || filename.toLowerCase().endsWith('.docx')) {
                            const wordText = await processWord(buffer);
                            text = `[Documento Word "${filename}" extraído]: ${wordText}`;
                        } else {
                            await sendWhatsAppMessage(from, "Lo siento, profe. Solo puedo leer documentos PDF y Word (.docx).");
                            return;
                        }
                    }
                } catch (err) {
                    console.error("Error processing media:", err);
                    await sendWhatsAppMessage(from, "Ocurrió un error al intentar leer el archivo que enviaste. 😔");
                    return;
                }
            }

            if (!text) return;

            console.log('WhatsApp de', from, ':', text);
            await getDb().collection('client_messages').insertOne({ phone: from, message: text, direction: 'incoming', employeeId: null, employeeName: null, createdAt: new Date() });

            let userId;
            let user = await getDb().collection('users').findOne({ phone: from });
            if (!user) {
                const hashed = await bcrypt.hash(from.slice(-6), 12);
                const result = await getDb().collection('users').insertOne({ phone: from, password: hashed, name: '', grade: '', area: '', school: '', role: 'teacher', is_admin: false, plan: 'trial', plan_expires: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), plans_count: 0, created_at: new Date() });
                userId = result.insertedId.toString();
                user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
                const welcomeReply = '¡Hola, profe! 🤖 \n\nA partir de hoy voy a ser tu **Planixa Asistente**.\n\nPuedo ayudarte a crear unidades, secuencias, planificaciones diarias, rúbricas, evaluaciones y mucho más.\n\nAntes de empezar, cuéntame:\n📌 ¿Cuál es tu nombre?\n📌 ¿Qué grado y área trabajas normalmente?';
                // Guardar respuesta de bienvenida en el historial del admin
                await getDb().collection('client_messages').insertOne({ phone: from, message: welcomeReply, direction: 'outgoing', employeeId: null, employeeName: 'Bot WhatsApp', createdAt: new Date() });
                await sendWhatsAppButtons(from, welcomeReply, ['¡Hola! 👋', 'Ver mis planes 📂']);
                return;
            }
            userId = user._id.toString();

            // --- SUSCRIPTION CHECK ---
            const limits = { 'trial': 5, '1_week': 10, '1_month': 60, '3_months': 180, '6_months': 360, '1_year': 720, 'lifetime': 999999 };
            const maxPlans = limits[user.plan] || 5;
            const currentCount = user.plans_count || 0;

            if (user.plan !== 'lifetime' && !user.is_admin) {
                const now = new Date();
                const expires = user.plan_expires ? new Date(user.plan_expires) : null;
                const isTrial = user.plan === 'trial';
                
                let blockReason = null;
                if (!expires || expires < now) blockReason = isTrial ? 'Tu período de prueba de 3 días ha finalizado. 😔' : 'Tu plan ha expirado. 😔';
                else if (currentCount >= maxPlans) blockReason = 'Has alcanzado el límite de planificaciones de tu plan actual. 😔';

                if (blockReason) {
                    const payMsg = `Hola profe. ${blockReason}\n\nPara seguir ahorrando horas de trabajo con **Planixa Asistente**, renueva tu acceso:\n\n💳 **Azul / CardNet:** [Aquí tu link Azul]\n💳 **PayPal:** [Aquí tu link PayPal]\n\nSelecciona el método que prefieras en los enlaces arriba. Si pagas por transferencia bancaria (Banreservas/Popular), responde este mensaje para enviarte los datos.`;
                    await sendWhatsAppMessage(from, payMsg);
                    return;
                }
            }

            if (!user.name) {
                const parsePrompt = `Extrae el nombre del profesor, el grado, el área/materia y el centro educativo (si lo menciona) del siguiente texto. Responde ÚNICAMENTE con un JSON válido usando estas claves: "name", "grade", "area", "school". Si falta algo, déjalo vacío ("").\nTexto: "${text}"`;
                try {
                    const r = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: parsePrompt }], max_tokens: 150, temperature: 0 })
                    });
                    if (r.ok) {
                        const d = await r.json();
                        if (d.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Extraer Nombre', 'gpt-4o-mini', d.usage);
                        const parsedStr = d.choices[0].message.content.trim();
                        const jsonMatch = parsedStr.match(/\{[\s\S]*?\}/);
                        if (jsonMatch) {
                            const data = JSON.parse(jsonMatch[0]);
                            await getDb().collection('users').updateOne({ _id: user._id }, { $set: { 
                                name: data.name || text.slice(0, 50), 
                                grade: data.grade || '', 
                                area: data.area || '', 
                                school: data.school || '' 
                            } });
                        } else {
                            await getDb().collection('users').updateOne({ _id: user._id }, { $set: { name: text.slice(0, 50) } });
                        }
                    } else {
                        await getDb().collection('users').updateOne({ _id: user._id }, { $set: { name: text.slice(0, 50) } });
                    }
                } catch(e) {
                    await getDb().collection('users').updateOne({ _id: user._id }, { $set: { name: text.slice(0, 50) } });
                }

                const confirmReply = '¡Excelente profe! Ya he guardado tus datos.\n\n¿Quieres comenzar con una planificación diaria? ¿O prefieres una Unidad o Secuencia?';
                // Guardar el intercambio de recoleccion de nombre en historial y conversación
                await getDb().collection('client_messages').insertOne({ phone: from, message: confirmReply, direction: 'outgoing', employeeId: null, employeeName: 'Bot WhatsApp', createdAt: new Date() });
                const now = new Date();
                await getDb().collection('conversations').insertOne({
                    userId,
                    is_whatsapp: true,
                    title: 'WhatsApp: ' + now.toLocaleDateString('es-DO'),
                    messages: [
                        { role: 'user', content: text, timestamp: now },
                        { role: 'assistant', content: confirmReply, timestamp: new Date() }
                    ],
                    createdAt: now,
                    pdfGenerated: false
                });
                await sendWhatsAppMessage(from, confirmReply);
                return;
            }

            // --- 1. MEMORIA DE WHATSAPP (AMNESIA FIX) ---
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            let activeConv = await getDb().collection('conversations').findOne({
                userId,
                is_whatsapp: true,
                createdAt: { $gte: thirtyDaysAgo }
            }, { sort: { createdAt: -1 } });

            let historyMessages = [];
            if (activeConv && activeConv.messages) {
                // Solo enviar los últimos 20 mensajes al contexto para no saturar tokens ni subir costos
                const recentMessages = activeConv.messages.slice(-20);
                historyMessages = recentMessages.map(m => ({ role: m.role, content: m.content }));
            }

            const refDocs = await getDb().collection('references').find({ userId }).toArray();
            let refBlock = '';
            if (refDocs.length > 0) {
                refBlock = '\n\nDOCUMENTOS DE REFERENCIA:\n' + refDocs.map(r => `📄 ${r.name}: ${(r.text||'').slice(0,2000)}`).join('\n---\n');
            }

            let MINERD_SYSTEM_PROMPT = `Eres "Planixa", asistente de planificación docente del MINERD. Responde en español dominicano.`;
            let hasFormat = false; // declarado fuera del try para que sea accesible en la generación forzada
            
            try {
                // Fetch prompts
                const prompts = await getDb().collection('prompts').find({}).toArray();
                const formats = await getDb().collection('doc_formats').find({}).toArray();
                
                // Buscar explícitamente "Planixa Principal" como el por defecto (soporta guiones bajos)
                let defaultPrompt = prompts.find(p => p.name && p.name.replace(/_/g, ' ').trim().toLowerCase() === 'planixa principal') || (prompts.length > 0 ? prompts[0] : null);
                let selectedPrompt = defaultPrompt;

                let routerPromise = null;
                if (prompts.length > 1) {
                    const routerPrompt = `Eres un enrutador inteligente. Tienes los siguientes Especialistas (Prompts) disponibles:\n${prompts.map(p => `- ID: ${p._id.toString()} | Nombre: ${p.name} | Cuándo usar: ${p.description}`).join('\n')}\n\nEl usuario ha dicho: "${text}"\n\nResponde ÚNICAMENTE con el ID del Especialista que mejor puede atender esta solicitud. Si ninguno aplica claramente, responde con el ID del Especialista más general o principal.`;
                    
                    routerPromise = fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({
                            model: 'gpt-4o-mini',
                            messages: [{ role: 'system', content: routerPrompt }],
                            max_tokens: 50,
                            temperature: 0
                        })
                    });
                }

                let formatPromise = null;
                if (formats.length > 0) {
                    const formatMatcherPrompt = `Eres un clasificador. Revisa si el mensaje del usuario está pidiendo generar un documento. Formatos disponibles: ${formats.map(f => f.type).join(', ')}. Si pide uno de esos, responde EXACTAMENTE con el tipo. Si no, responde "NINGUNO".\nMensaje: "${text}"`;
                    
                    formatPromise = fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({
                            model: 'gpt-4o-mini',
                            messages: [{ role: 'system', content: formatMatcherPrompt }],
                            max_tokens: 20,
                            temperature: 0
                        })
                    });
                }

                // Ejecutar ambas llamadas en paralelo
                const [routerRes, fRes] = await Promise.all([
                    routerPromise ? routerPromise.catch(e => { console.error("Router error", e); return null; }) : Promise.resolve(null),
                    formatPromise ? formatPromise.catch(e => { console.error("Format error", e); return null; }) : Promise.resolve(null)
                ]);

                if (routerRes && routerRes.ok) {
                    const rData = await routerRes.json();
                    if (rData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Enrutador IA', 'gpt-4o-mini', rData.usage);
                    const chosenId = rData.choices?.[0]?.message?.content?.trim();
                    selectedPrompt = prompts.find(p => p._id.toString() === chosenId) || defaultPrompt;
                }

                if (selectedPrompt) {
                    MINERD_SYSTEM_PROMPT = selectedPrompt.content;
                }
                
                // Inject User Profile Info
                MINERD_SYSTEM_PROMPT += `\n\nDATOS DEL PROFESOR:\nNombre: ${user.name || 'Profe'}\nGrado: ${user.grade || 'No especificado'}\nÁrea/Materia: ${user.area || 'No especificada'}\nCentro Educativo: ${user.school || 'No especificado'}\nUsa estos datos siempre que necesites rellenar información personal del profesor o adaptar la planificación a su grado/materia, a menos que el profesor indique algo distinto para esta solicitud en particular.\n` +
                (user.preferences ? `\nPREFERENCIAS GUARDADAS DEL PROFESOR:\n${user.preferences}\n(RESPETA ESTAS PREFERENCIAS ABSOLUTAMENTE)\n` : '') +
                `\nREGLA DE APRENDIZAJE: Si el profesor expresa un gusto, preferencia, o cómo le gustan los formatos a futuro (ej. "no me des rubricas", "me gustan los juegos"), debes incluir AL FINAL de tu respuesta esta etiqueta exacta: [MEMORIA: la preferencia aquí]. Yo la guardaré en la base de datos.`;
                
                MINERD_SYSTEM_PROMPT += `\n\nREGLA DE PERFIL E IDENTIDAD (MUY IMPORTANTE):\nAntes de enviar o comenzar la creación de CUALQUIER planificación o documento, verifica el "Nombre" en los DATOS DEL PROFESOR. Si el nombre es genérico (ej. "hola", "Profe", "Maestro") o está vacío, DEBES preguntarle cortésmente cuál es su nombre completo antes de generar el documento.\n\nCuando el profesor te diga su nombre, grado, materia o escuela (ej. "soy Juan", "doy 2do", "de naturales"), DEBES incluir AL FINAL de tu respuesta esta etiqueta con los datos en formato JSON para guardarlos:\n[UPDATE_PROFILE: {"name": "Juan Perez", "grade": "2do", "area": "Naturales"}]\nIncluye solo los campos que te haya confirmado. Nunca omitas esta regla.`;

                MINERD_SYSTEM_PROMPT += `\n\nREGLA DE ENTREGA POR WHATSAPP:\nPara que el profesor pueda copiar y pegar la planificación fácilmente, NUNCA mezcles la charla conversacional con el documento de la planificación en el mismo bloque. Usa EXACTAMENTE el separador \`|||\` para dividir los mensajes.
Ejemplo de cómo DEBES responder:
¡Excelente profe! Aquí te presento la estructura de la unidad:
|||
*Unidad Didáctica: El Cuento*
Grado: 2do grado
...
|||
¿Te parece bien esta estructura, profe? ¿Quieres hacer algún ajuste?`;

                // --- FORMAT INJECTOR ---
                if (fRes && fRes.ok) {
                    const fData = await fRes.json();
                    if (fData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Clasificador Formato', 'gpt-4o-mini', fData.usage);
                    const chosenType = fData.choices?.[0]?.message?.content?.trim();
                    if (chosenType && chosenType !== 'NINGUNO') {
                        const matchedFormat = formats.find(f => f.type.toLowerCase() === chosenType.toLowerCase());
                        if (matchedFormat) {
                            hasFormat = true;
                            const newPendingFormatId = matchedFormat._id.toString();
                            if (activeConv) {
                                activeConv.pendingFormatId = newPendingFormatId;
                                await getDb().collection('conversations').updateOne(
                                    { _id: activeConv._id },
                                    { $set: { pendingFormatId: newPendingFormatId } }
                                );
                            } else {
                                req.pendingFormatId = newPendingFormatId;
                            }
                            // Las instrucciones de Word van AL INICIO del prompt para tener
                            // prioridad sobre las instrucciones del prompt del admin
                            let wordPriority = `INSTRUCCIÓN PRIORITARIA DEL SISTEMA (ANULA CUALQUIER OTRA REGLA DE ENTREGA):
Hay una plantilla Word configurada para este tipo de documento. DEBES seguir estas reglas SIN EXCEPCIÓN y por encima de cualquier otra instrucción:

1. NUNCA envíes la planificación como texto plano en el chat. NUNCA.
2. Si tienes todos los datos (grado, área, tema): responde SOLO con este bloque y NADA MÁS:
[GENERATE_WORD]
\`\`\`json
{ "clave": "valor_completo" }
\`\`\`
3. Si te falta el tema: haz UNA sola pregunta y en el siguiente mensaje genera el bloque [GENERATE_WORD].
4. NO preguntes si quieren el documento. Genéralo directamente.
5. Después del JSON puedes añadir UNA frase corta de confirmación.
`;
                            if (matchedFormat.instructions) wordPriority += `\nCLAVES EXACTAS DEL JSON (ÚSALAS TAL CUAL):\n${matchedFormat.instructions}\n`;
                            // INYECTAR AL INICIO, no al final
                            MINERD_SYSTEM_PROMPT = wordPriority + '\n\n---\n\n' + MINERD_SYSTEM_PROMPT;
                        }
                    }
                }

                // --- RECUPERACIÓN DE FORMATO PENDIENTE ---
                // Solo activa si el mensaje es relacionado con documentos o una confirmación.
                // Si el mensaje es un saludo o pregunta no relacionada, limpia el pendingFormatId.
                if (!hasFormat && activeConv && activeConv.pendingFormatId) {
                    const isDocRelated = /planif|plan|unidad|secuencia|documento|word|genera|hazlo|s[íi]|ok|dale|listo|adelante|envía|manda|quiero|necesito|tema|grado|área|area|materia|decimal|entero|fraccion|suma|resta|multiplica|divid/i.test(text);
                    const isJustGreeting = /^(hola|buenos|buenas|hi|hey|ok[,.]?$|gracias|ok ya|no lo|cancela|olv|no quiero)/i.test(text.trim());
                    if (isJustGreeting || (!isDocRelated && text.length < 15)) {
                        // Limpiar el pendingFormatId — el usuario cambió de tema
                        console.log('[RECOVER FORMAT] Mensaje no relacionado, limpiando pendingFormatId');
                        await getDb().collection('conversations').updateOne(
                            { _id: activeConv._id },
                            { $unset: { pendingFormatId: '' } }
                        );
                        activeConv.pendingFormatId = null;
                    } else {
                        try {
                            const pendingFmt = await getDb().collection('doc_formats').findOne(
                                { _id: new mongoose.Types.ObjectId(activeConv.pendingFormatId) }
                            );
                            if (pendingFmt) {
                                hasFormat = true;
                                let wordPriority2 = `INSTRUCCIÓN PRIORITARIA DEL SISTEMA (ANULA CUALQUIER OTRA REGLA DE ENTREGA):
Ya tienes info suficiente. Genera el documento Word AHORA. Responde SOLO con:
[GENERATE_WORD]
\`\`\`json
{ "clave": "valor_completo" }
\`\`\`
NUNCA escribas la planificación como texto plano.\n`;
                                if (pendingFmt.instructions) wordPriority2 += `\nCLAVES EXACTAS DEL JSON:\n${pendingFmt.instructions}\n`;
                                MINERD_SYSTEM_PROMPT = wordPriority2 + '\n\n---\n\n' + MINERD_SYSTEM_PROMPT;
                            }
                        } catch(e) {
                            console.error('[RECOVER FORMAT] Error:', e.message);
                        }
                    }
                }

            } catch (err) {
                console.error('Error en AI Router', err);
            }


// ==========================================
// MEDIA PROCESSING HELPERS
// ==========================================

async function downloadWhatsAppMedia(mediaId) {
    const WA_TOKEN = process.env.WA_TOKEN;
    if (!WA_TOKEN) throw new Error('No WA_TOKEN found');
    
    // 1. Get media URL
    const res = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    if (!res.ok) throw new Error('Failed to get media URL');
    const data = await res.json();
    
    // 2. Download binary data
    const mediaRes = await fetch(data.url, {
        headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    if (!mediaRes.ok) throw new Error('Failed to download media buffer');
    const buffer = await mediaRes.arrayBuffer();
    return Buffer.from(buffer);
}

async function processAudioWhisper(buffer) {
    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: 'audio/ogg' }), 'audio.ogg');
    formData.append('model', 'whisper-1');
    formData.append('language', 'es');
    
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: formData
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return data.text;
}

async function processImageGPT(buffer, mimeType) {
    const base64 = buffer.toString('base64');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Analiza esta imagen y extrae todo el texto o describe detalladamente qué contiene, enfocándote en el contenido educativo o planificación si lo hay. Sé directo, solo da la información.' },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                ]
            }],
            max_tokens: 1000
        })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return data.choices[0].message.content.trim();
}

async function processPDF(buffer) {
    const data = await pdfParse(buffer);
    return data.text.trim();
}

async function processWord(buffer) {
    const data = await mammoth.extractRawText({ buffer });
    return data.value.trim();
}

            const systemWithRefs = MINERD_SYSTEM_PROMPT + refBlock;
            const messages = [
                { role: 'system', content: systemWithRefs },
                ...historyMessages,
                { role: 'user', content: text }
            ];

            // ══════════════════════════════════════════════════════════
            // VIGILANTE DE PERFIL (corre en paralelo, no bloquea)
            // Extrae datos del profesor de cada mensaje y actualiza
            // los campos que aún estén vacíos en su perfil.
            // ══════════════════════════════════════════════════════════
            const profileWatcher = async () => {
                try {
                    // Solo actuar si hay campos vacíos que rellenar
                    const missingFields = [];
                    if (!user.name || user.name.trim() === '') missingFields.push('name');
                    if (!user.grade || user.grade.trim() === '') missingFields.push('grade');
                    if (!user.area || user.area.trim() === '') missingFields.push('area');
                    if (!user.school || user.school.trim() === '') missingFields.push('school');
                    if (missingFields.length === 0) return; // perfil completo, nada que hacer

                    const watcherPrompt = `Eres un extractor de datos silencioso. Analiza el texto de un profesor dominicano y extrae únicamente los datos solicitados si están presentes.

CAMPOS A BUSCAR: ${missingFields.join(', ')}
- name: Nombre completo del profesor (IGNORA palabras genéricas como: hola, ok, sí, no, bien, gracias, claro, listo, bueno, hey, buenas)
- grade: Grado que enseña (ej: "3ro Primaria", "1ro Secundaria", "Kinder")
- area: Materia o área (ej: "Matemáticas", "Lengua Española", "Ciencias")
- school: Nombre del centro educativo

Texto del profesor: "${text}"

Responde ÚNICAMENTE con un JSON. Incluye solo los campos que puedas confirmar claramente. Si no encuentras un dato, NO lo incluyas en el JSON. Ejemplo: {"name": "María López", "grade": "4to Primaria"}
Si no encuentras NADA, responde: {}`;

                    const wr = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: watcherPrompt }], max_tokens: 100, temperature: 0 })
                    });

                    if (!wr.ok) return;
                    const wd = await wr.json();
                    const raw = wd?.choices?.[0]?.message?.content?.trim();
                    if (!raw || raw === '{}') return;

                    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
                    if (!jsonMatch) return;

                    const extracted = JSON.parse(jsonMatch[0]);
                    const updates = {};

                    // Solo actualizar campos que estaban vacíos y ahora tienen valor
                    if (missingFields.includes('name') && extracted.name && extracted.name.length > 2) updates.name = extracted.name;
                    if (missingFields.includes('grade') && extracted.grade) updates.grade = extracted.grade;
                    if (missingFields.includes('area') && extracted.area) updates.area = extracted.area;
                    if (missingFields.includes('school') && extracted.school) updates.school = extracted.school;

                    if (Object.keys(updates).length > 0) {
                        await getDb().collection('users').updateOne({ _id: user._id }, { $set: updates });
                        console.log(`[VIGILANTE PERFIL] Actualizado perfil de ${from}:`, updates);
                    }
                } catch (e) {
                    console.error('[VIGILANTE PERFIL] Error silencioso:', e.message);
                }
            };

            let reply = '⚠️ No pude procesar tu solicitud. Intenta de nuevo.';
            
            // Determinar si es trabajo de especialista (el router eligió algo distinto a Planixa Principal)
            const isSpecialistWork = selectedPrompt && defaultPrompt && selectedPrompt._id.toString() !== defaultPrompt._id.toString();
            // Determinar si hay formato activo o confirmación
            const pendingFmtId = (activeConv && activeConv.pendingFormatId) || req.pendingFormatId;
            const isDocConfirmation = /^(s[íi]|si|ok|dale|listo|genéralo|hazlo|adelante|perfecto|claro|mándamelo|envíamelo|si por favor|ya|bueno|sí quiero|quiero|generar)/i.test(text.trim());
            const shouldWork = isSpecialistWork && (hasFormat || pendingFmtId || isDocConfirmation || text.length > 50);

            if (shouldWork) {
                // --- FLUJO MULTI-AGENTE (Especialista -> Supervisor -> Principal) ---
                
                // 1. Llamada al Especialista (usa systemWithRefs que tiene Base Conocimientos y Plantillas)
                // Se invoca el perfilWatcher en paralelo para no perder tiempo
                const [, specRes] = await Promise.all([
                    profileWatcher(),
                    fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                    }).catch(e => { console.error('Especialista error', e); return null; })
                ]);

                let specReply = '';
                if (specRes && specRes.ok) {
                    const d = await specRes.json();
                    if (d.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Especialista', 'gpt-4o-mini', d.usage);
                    specReply = d?.choices?.[0]?.message?.content?.trim() || '';
                }

                // Generación Forzada si el Especialista olvidó el [GENERATE_WORD]
                const shouldForceGen = hasFormat && pendingFmtId && !specReply.includes('[GENERATE_WORD]');
                if (shouldForceGen) {
                    try {
                        const fmtDoc2 = await getDb().collection('doc_formats').findOne({ _id: new mongoose.Types.ObjectId(pendingFmtId) });
                        if (fmtDoc2) {
                            const convoContext = historyMessages.map(m => (m.role === 'user' ? 'Profesor' : 'Asistente') + ': ' + m.content).join('\n') + '\nProfesor: ' + text;
                            const forcedPrompt = `Eres un experto generador de planificaciones docentes del MINERD.
TAREA: Genera un JSON completo para rellenar una plantilla Word.
${fmtDoc2.instructions || ''}
DATOS DEL PROFESOR:
- Nombre: ${user.name || 'No especificado'}
- Grado: ${user.grade || 'No especificado'}
- Área: ${user.area || 'No especificada'}
CONVERSACIÓN:
${convoContext}
Responde ÚNICAMENTE con el bloque [GENERATE_WORD] seguido del JSON.`;
                            const fr2 = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                                body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4000, temperature: 0.3, messages: [{ role: 'user', content: forcedPrompt }] })
                            });
                            if (fr2.ok) {
                                const fd2 = await fr2.json();
                                if (fd2.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Gen Forzada', 'gpt-4o', fd2.usage);
                                const forcedReply = fd2?.choices?.[0]?.message?.content?.trim();
                                if (forcedReply && forcedReply.includes('[GENERATE_WORD]')) specReply = forcedReply;
                            }
                        }
                    } catch(e) { console.error('Forced Gen Error', e); }
                }

                // 2. Supervisor IA (El supervisor tiene reglas para respetar JSON)
                let supervisedReply = await callSupervisor(user._id.toString(), systemWithRefs, text, specReply);

                // 3. Planixa Principal (Envuelve el mensaje amigablemente)
                const principalSystemPrompt = defaultPrompt.content + `\n\nDATOS DEL PROFESOR:\nNombre: ${user.name || 'Profe'}\nGrado: ${user.grade || 'No especificado'}\n\nERES LA SECRETARIA. Un Especialista ha generado el siguiente trabajo estructural para el profesor:\n---\n${supervisedReply}\n---\n\nTu tarea es entregarle esto al profesor de forma muy amable y profesional. \nREGLA DE ORO: DEBES incluir EXACTAMENTE el mismo bloque [GENERATE_WORD] con su JSON intacto al final de tu mensaje. NO MODIFIQUES EL JSON, SOLO AGREGA TU SALUDO AL PRINCIPIO. Usa el separador ||| entre tu charla y el documento.`;

                const prinRes = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 4000, temperature: 0.5, messages: [{ role: 'system', content: principalSystemPrompt }] })
                }).catch(e => { console.error('Principal final error', e); return null; });
                
                if (prinRes && prinRes.ok) {
                    const d = await prinRes.json();
                    if (d.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Principal Delivery', 'gpt-4o-mini', d.usage);
                    reply = d?.choices?.[0]?.message?.content?.trim() || supervisedReply;
                } else {
                    reply = supervisedReply;
                }

            } else {
                // --- FLUJO NORMAL CONVERSACIONAL (Planixa Principal) ---
                const [, prinRes] = await Promise.all([
                    profileWatcher(),
                    fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                    }).catch(e => { console.error('Principal chat error', e); return null; })
                ]);

                if (prinRes && prinRes.ok) {
                    const d = await prinRes.json();
                    if (d.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Principal Chat', 'gpt-4o-mini', d.usage);
                    reply = d?.choices?.[0]?.message?.content?.trim() || reply;
                }

                // Supervisor opcional
                reply = await callSupervisor(user._id.toString(), systemWithRefs, text, reply);
            }

            // SANITIZE LEAKED PROMPT DIRECTIVES
            if (reply) {
                reply = reply.replace(/\[?SOLICITAR_AL_PROMPT_PRINCIPAL\]?:?\s*/gi, '');
            }
            
            const profileMatch = reply?.match(/\[UPDATE_PROFILE:\s*(\{.*?\})\s*\]/i);
            if (profileMatch) {
                try {
                    const profileUpdates = JSON.parse(profileMatch[1]);
                    const cleanUpdates = {};
                    if (profileUpdates.name) cleanUpdates.name = profileUpdates.name;
                    if (profileUpdates.grade) cleanUpdates.grade = profileUpdates.grade;
                    if (profileUpdates.area) cleanUpdates.area = profileUpdates.area;
                    if (profileUpdates.school) cleanUpdates.school = profileUpdates.school;
                    if (Object.keys(cleanUpdates).length > 0) {
                        await getDb().collection('users').updateOne({ _id: user._id }, { $set: cleanUpdates });
                    }
                    reply = reply.replace(/\[UPDATE_PROFILE:\s*\{.*?\}\s*\]/i, '').trim();
                } catch(e) {
                    console.error("Error parsing UPDATE_PROFILE", e);
                }
            }

            const memMatch = reply.match(/\[MEMORIA:\s*(.+?)\]/i);
            if (memMatch) {
                const newPref = memMatch[1].trim();
                reply = reply.replace(/\[MEMORIA:\s*.+?\]/i, '').trim();
                const currentPrefs = user.preferences ? user.preferences + '\n- ' + newPref : '- ' + newPref;
                await getDb().collection('users').updateOne({ _id: user._id }, { $set: { preferences: currentPrefs } });
            }

            if ((reply.includes('[GENERATE_PDF]') || reply.includes('[GENERATE_WORD]')) && user.plan !== 'lifetime' && !user.is_admin) {
                await getDb().collection('users').updateOne({ _id: user._id }, { $inc: { plans_count: 1 } });
            }

            const now = new Date();
            const newMessages = [
                { role: 'user', content: text, timestamp: now },
                { role: 'assistant', content: reply, timestamp: new Date() }
            ];

            if (activeConv) {
                let updateData = { $push: { messages: { $each: newMessages } } };
                if (activeConv.pendingFormatId) updateData.$set = { pendingFormatId: activeConv.pendingFormatId };
                
                await getDb().collection('conversations').updateOne(
                    { _id: activeConv._id },
                    updateData
                );
                if (!activeConv.messages) activeConv.messages = [];
                activeConv.messages.push(...newMessages);
            } else {
                let insertData = {
                    userId,
                    is_whatsapp: true,
                    title: 'WhatsApp: ' + now.toLocaleDateString('es-DO'),
                    messages: newMessages,
                    createdAt: now,
                    pdfGenerated: false
                };
                if (req.pendingFormatId) insertData.pendingFormatId = req.pendingFormatId;
                
                const insertResult = await getDb().collection('conversations').insertOne(insertData);
                activeConv = await getDb().collection('conversations').findOne({ _id: insertResult.insertedId });
            }

            await getDb().collection('client_messages').insertOne({ phone: from, message: reply, direction: 'outgoing', employeeId: null, employeeName: 'Bot WhatsApp', createdAt: new Date() });

            // --- 2. ENTREGA DE WORDS POR WHATSAPP ---
            if (reply.includes('[GENERATE_WORD]')) {
                try {
                    let jsonData = {};
                    const jsonMatch = reply.match(/```json\s*(\{[\s\S]*?\})\s*```/);
                    if (jsonMatch) {
                        jsonData = JSON.parse(jsonMatch[1]);
                    }

                    const fmtId = (activeConv && activeConv.pendingFormatId) || req.pendingFormatId;
                    if (fmtId) {
                        const formatDoc = await getDb().collection('doc_formats').findOne({ _id: new mongoose.Types.ObjectId(fmtId) });
                        if (formatDoc && formatDoc.filePath) {
                            const templatePath = path.join(PROJECT_ROOT, 'public', formatDoc.filePath);
                            const outDir = path.join(PROJECT_ROOT, 'public', 'downloads');
                            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

                            const outFilename = `Documento-${from}-${Date.now()}.docx`;
                            const outPath = path.join(outDir, outFilename);
                            const outUrl = `https://planixa.onrender.com/public/downloads/${outFilename}`;

                            const content = fs.readFileSync(templatePath, 'binary');
                            const zip = new PizZip(content);

                            // Extraer etiquetas {{campo}} reales del XML del Word
                            let realKeys = [];
                            try {
                                const rawXml = zip.files['word/document.xml'] ? zip.files['word/document.xml'].asText() : '';
                                const tagMatches = rawXml.match(/\{\{([^}]+)\}\}/g) || [];
                                realKeys = [...new Set(tagMatches.map(t => t.replace(/[{}]/g, '').trim()))];
                                console.log('[WORD GEN] Etiquetas en plantilla:', realKeys);
                            } catch(xe) { console.error('[WORD GEN] Error extrayendo tags:', xe.message); }

                            // Mapeo inteligente: asignar claves faltantes desde el JSON o el perfil
                            if (realKeys.length > 0) {
                                const finalData = {};
                                for (const rk of realKeys) {
                                    const rkLow = rk.toLowerCase().replace(/[_\s]/g, '');
                                    // Buscar coincidencia en el JSON recibido
                                    let matched = null;
                                    for (const [jk, jv] of Object.entries(jsonData)) {
                                        const jkLow = jk.toLowerCase().replace(/[_\s]/g, '');
                                        if (rk === jk || rkLow === jkLow || rkLow.includes(jkLow) || jkLow.includes(rkLow)) {
                                            matched = jv; break;
                                        }
                                    }
                                    if (matched !== null) { finalData[rk] = matched; continue; }
                                    // Fallback desde perfil del profesor
                                    if (rkLow.includes('profesor') || rkLow.includes('docente') || (rkLow.includes('nombre') && !rkLow.includes('tema'))) finalData[rk] = user.name || '';
                                    else if (rkLow.includes('grado') || rkLow.includes('nivel')) finalData[rk] = user.grade || jsonData.grado || '';
                                    else if (rkLow.includes('area') || rkLow.includes('materia') || rkLow.includes('asignatura')) finalData[rk] = user.area || jsonData.area || '';
                                    else if (rkLow.includes('escuela') || rkLow.includes('centro') || rkLow.includes('colegio')) finalData[rk] = user.school || '';
                                    else if (rkLow.includes('fecha')) finalData[rk] = new Date().toLocaleDateString('es-DO');
                                    else finalData[rk] = ''; // dejar vacío en vez de crashear
                                }
                                jsonData = finalData;
                                console.log('[WORD GEN] JSON final para plantilla:', Object.keys(jsonData));
                            }

                            // nullGetter evita que claves faltantes tiren error
                            const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
                            doc.render(jsonData);

                            const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
                            fs.writeFileSync(outPath, buf);

                            await sendWhatsAppMessage(from, '¡Aquí tienes tu documento Word, profe! 📄✨');
                            await sendWhatsAppDocument(from, outUrl, outFilename);

                            // Limpiar pendingFormatId
                            if (activeConv) {
                                await getDb().collection('conversations').updateOne(
                                    { _id: activeConv._id },
                                    { $unset: { pendingFormatId: '' } }
                                );
                            }
                        } else {
                            await sendWhatsAppMessage(from, 'Hubo un error localizando la plantilla original.');
                        }
                    } else {
                        await sendWhatsAppMessage(from, 'Hubo un problema encontrando el formato.');
                    }
                } catch(e) {
                    // Docxtemplater tiene errores estructurados con e.properties.errors
                    if (e.properties && e.properties.errors) {
                        console.error('[WORD GEN] Errores de plantilla:',
                            JSON.stringify(e.properties.errors.map(er => ({
                                id: er.id,
                                message: er.message,
                                xtag: er.properties?.xtag
                            })), null, 2)
                        );
                    } else {
                        console.error('[WORD GEN] Error:', e.message, e.stack);
                    }
                    // SIEMPRE limpiar pendingFormatId al fallar para no quedar en bucle
                    if (activeConv) {
                        await getDb().collection('conversations').updateOne(
                            { _id: activeConv._id },
                            { $unset: { pendingFormatId: '' } }
                        ).catch(() => {});
                    }
                    await sendWhatsAppMessage(from, 'Ocurrió un error generando el documento. Por favor intenta de nuevo enviando tu solicitud.');
                }
            }

            else if (reply.includes('[GENERATE_PDF]')) {
                // Generar PDF legacy (Planificaciones regulares)
                const pdfDir = path.join(PROJECT_ROOT, 'public', 'downloads');
                if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
                const pdfFilename = `planificacion-${from}-${Date.now()}.pdf`;
                const pdfPath = path.join(pdfDir, pdfFilename);
                const pdfUrl = `https://planixa.onrender.com/public/downloads/${pdfFilename}`;
                
                await createPdfFromConv(activeConv, user, pdfPath);
                await sendWhatsAppMessage(from, "Aquí tienes tu planificación en formato PDF, profe 📄✨");
                await sendWhatsAppDocument(from, pdfUrl, pdfFilename);
            } else {
                let waReply = reply.replace(/\*\*/g, '*');
                waReply = waReply.replace(/^###\s+/gm, '*');
                waReply = waReply.replace(/^##\s+/gm, '*');
                waReply = waReply.replace(/^#\s+/gm, '*');
                waReply = waReply.replace(/\|\|\|/g, '\n\n'); // Reemplazar separador por saltos de línea normales
                
                // Enviar el mensaje completo en bloques de 4000 (Límite de WhatsApp) para que quede en un solo "bubble"
                const chunks = waReply.match(/[\s\S]{1,4000}/g) || [];
                for (const chunk of chunks) {
                    await sendWhatsAppMessage(from, chunk);
                }
            }

        } catch (err) {
            console.error('WhatsApp webhook error:', err.message);
        }
    });
};

async function sendWhatsAppMessage(to, text) {
    const WA_TOKEN = process.env.WA_TOKEN;
    const WA_PHONE_ID = process.env.WA_PHONE_ID;
    if (WA_TOKEN && WA_PHONE_ID) {
        await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'text', text: { body: text } })
        });
    } else {
        console.log('Respuesta simulada:', text.slice(0, 100) + '...');
    }
}

async function sendWhatsAppButtons(to, text, buttons) {
    const WA_TOKEN = process.env.WA_TOKEN;
    const WA_PHONE_ID = process.env.WA_PHONE_ID;
    if (WA_TOKEN && WA_PHONE_ID) {
        const payload = {
            messaging_product: 'whatsapp',
            to: to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: text },
                action: {
                    buttons: buttons.map((btn, index) => ({
                        type: 'reply',
                        reply: { id: `btn_${index}_${btn.substring(0,20).replace(/[^a-zA-Z0-9]/g, '')}`, title: btn.substring(0, 20) }
                    }))
                }
            }
        };
        await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
            body: JSON.stringify(payload)
        });
    } else {
        console.log('Botones simulados:', text, buttons);
    }
}

async function sendWhatsAppDocument(to, link, filename) {
    const WA_TOKEN = process.env.WA_TOKEN;
    const WA_PHONE_ID = process.env.WA_PHONE_ID;
    if (WA_TOKEN && WA_PHONE_ID) {
        await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WA_TOKEN}` },
            body: JSON.stringify({ 
                messaging_product: 'whatsapp', 
                to: to, 
                type: 'document', 
                document: { link: link, filename: filename } 
            })
        });
    }
}

function createPdfFromConv(conv, user, outputPath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);

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

        const titleText = 'Planificación Docente';
        doc.fontSize(14).font('Helvetica-Bold').text(titleText, leftMargin, doc.y, { underline: true });
        doc.moveDown();

        if (user && user.name) {
            doc.fontSize(10).font('Helvetica').text(`Docente: ${user.name}     Celular: ${user.phone}`);
            doc.moveDown(0.5);
        }

        doc.moveTo(leftMargin, doc.y).lineTo(pageWidth - leftMargin, doc.y).stroke('#ccc');
        doc.moveDown();

        const messages = conv.messages || [];
        const planMessages = messages.filter(m => m.role === 'assistant' && m.content.length > 150 && !m.content.includes('[GENERATE_PDF]') && !m.content.includes('[GENERATE_WORD]'));
        const lastPlanMsg = planMessages.length > 0 ? planMessages[planMessages.length - 1].content : 'No se encontró la planificación detallada en esta conversación.';

        let content = String(lastPlanMsg).replace(/\[GENERATE_PDF\]/g, '');
        content = content.replace(/\*\*/g, ''); // Remover negritas de markdown
        
        doc.fontSize(10).font('Helvetica').fillColor('#333');
        const lines = content.split('\n');
        for (const line of lines) {
            if (doc.y > 720) doc.addPage();
            if (line.trim().startsWith('-') || line.trim().startsWith('*')) {
                doc.text(`• ${line.replace(/^[-*]/, '').trim()}`, leftMargin + 10, doc.y);
            } else if (line.trim().startsWith('#')) {
                doc.moveDown(0.5);
                doc.font('Helvetica-Bold').fillColor('#111').text(line.replace(/^#+/, '').trim(), leftMargin, doc.y);
                doc.font('Helvetica').fillColor('#333');
            } else {
                doc.text(line, leftMargin, doc.y);
            }
        }
        doc.moveDown();

        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}
