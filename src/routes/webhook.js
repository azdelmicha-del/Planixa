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
                await sendWhatsAppMessage(from, confirmReply);
                return;
            }

            // --- 1. MEMORIA DE WHATSAPP (AMNESIA FIX) ---
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
            let activeConv = await getDb().collection('conversations').findOne({
                userId,
                is_whatsapp: true,
                createdAt: { $gte: twelveHoursAgo }
            }, { sort: { createdAt: -1 } });

            const historyMessages = activeConv ? activeConv.messages.map(m => ({ role: m.role, content: m.content })) : [];

            const refDocs = await getDb().collection('references').find({ userId }).toArray();
            let refBlock = '';
            if (refDocs.length > 0) {
                refBlock = '\n\nDOCUMENTOS DE REFERENCIA:\n' + refDocs.map(r => `📄 ${r.name}: ${(r.text||'').slice(0,2000)}`).join('\n---\n');
            }

            let MINERD_SYSTEM_PROMPT = `Eres "Planixa", asistente de planificación docente del MINERD. Responde en español dominicano.`;
            
            try {
                // Fetch prompts
                const prompts = await getDb().collection('prompts').find({}).toArray();
                let selectedPrompt = null;

                if (prompts.length === 1) {
                    selectedPrompt = prompts[0];
                } else if (prompts.length > 1) {
                    // --- AI ROUTER ---
                    const routerPrompt = `Eres un enrutador inteligente. Tienes los siguientes Especialistas (Prompts) disponibles:
${prompts.map(p => `- ID: ${p._id.toString()} | Nombre: ${p.name} | Cuándo usar: ${p.description}`).join('\n')}

El usuario ha dicho: "${text}"

Responde ÚNICAMENTE con el ID del Especialista que mejor puede atender esta solicitud. Si ninguno aplica claramente, responde con el ID del Especialista más general o principal.`;
                    
                    const routerRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({
                            model: 'gpt-4o-mini',
                            messages: [{ role: 'system', content: routerPrompt }],
                            max_tokens: 50,
                            temperature: 0
                        })
                    });
                    
                    if (routerRes.ok) {
                        const rData = await routerRes.json();
                        if (rData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Enrutador IA', 'gpt-4o-mini', rData.usage);
                        const chosenId = rData.choices?.[0]?.message?.content?.trim();
                        selectedPrompt = prompts.find(p => p._id.toString() === chosenId) || prompts[0];
                    } else {
                        selectedPrompt = prompts[0];
                    }
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
                const formats = await getDb().collection('doc_formats').find({}).toArray();
                let hasFormat = false;
                if (formats.length > 0) {
                    const formatMatcherPrompt = `Eres un clasificador. Revisa si el mensaje del usuario está pidiendo generar un documento. Formatos disponibles: ${formats.map(f => f.type).join(', ')}. Si pide uno de esos, responde EXACTAMENTE con el tipo. Si no, responde "NINGUNO".
Mensaje: "${text}"`;
                    
                    const fRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                        body: JSON.stringify({
                            model: 'gpt-4o-mini',
                            messages: [{ role: 'system', content: formatMatcherPrompt }],
                            max_tokens: 20,
                            temperature: 0
                        })
                    });

                    if (fRes.ok) {
                        const fData = await fRes.json();
                        if (fData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Clasificador Formato', 'gpt-4o-mini', fData.usage);
                        const chosenType = fData.choices?.[0]?.message?.content?.trim();
                        if (chosenType && chosenType !== "NINGUNO") {
                            const matchedFormat = formats.find(f => f.type.toLowerCase() === chosenType.toLowerCase());
                            if (matchedFormat) {
                        hasFormat = true;
                                let tmplIns = `\n\nREGLA ESTRICTA DE FORMATO VISUAL (PLANTILLA WORD):\nEl administrador ha asignado una plantilla Word para este documento.`;
                                if (matchedFormat.instructions) tmplIns += `\nINSTRUCCIONES EXTRA DEL ADMIN: ${matchedFormat.instructions}`;
                                
                                tmplIns += `\n\nREGLA DE APROBACIÓN (MUY IMPORTANTE):
1. NO entregues una muestra de la planificación ni el texto completo en el chat. Mantén tus respuestas conversacionales y breves.
2. Si faltan datos para completar la plantilla, hazle al profesor las preguntas necesarias para obtenerlos.
3. Una vez tengas todos los datos y la planificación esté mentalmente lista, AL FINAL de tu mensaje pregúntale: "¿Tengo todos los datos listos, deseas que te genere tu documento en Word ahora?". 
4. NO USES la etiqueta [GENERATE_WORD] en este momento.
5. SÓLO usa [GENERATE_WORD] en tu SIGUIENTE mensaje si el profesor te responde que SÍ lo quiere en documento.

CUANDO EL PROFESOR DE LA APROBACIÓN:
Debes responder EXACTAMENTE con este formato, SIN agregar toda la planificación en texto plano:
[GENERATE_WORD]
\`\`\`json
{
  "etiqueta_del_word1": "Valor rellenado por ti",
  "etiqueta_del_word2": "Valor rellenado por ti"
}
\`\`\`
Nota: Asegúrate de adivinar/usar las claves correctas para el JSON según el contexto.`;
                                MINERD_SYSTEM_PROMPT += tmplIns;
                                // Inyectar el ID del formato en el system message temporalmente para saber cuál usar
                                if (activeConv) {
                                    activeConv.pendingFormatId = matchedFormat._id.toString();
                                } else {
                                    req.pendingFormatId = matchedFormat._id.toString();
                                }
                            }
                        }
                    }
                }
                
                if (!hasFormat) {
                    MINERD_SYSTEM_PROMPT += `\n\nREGLA ESTRICTA DE DISPONIBILIDAD:\nSi notas que el usuario te está pidiendo explícitamente que le generes o crees una planificación, examen, rúbrica o cualquier documento estructurado, DEBES OBLIGATORIAMENTE rechazar la creación del mismo con este texto exacto:\n"Aún no tengo el recurso o diseño activo para esa solicitud. Sin embargo, puedo pasarte con servicio al cliente para poder ayudarte desde el sistema."\n(Nota: Si solo está haciendo una pregunta conversacional, charlando, o pidiendo consejos/ideas sueltas, respóndele normalmente. Esta prohibición es SOLO para generar documentos formales o planificaciones estructuradas).`;
                }
            } catch (err) {
                console.error("Error en AI Router", err);
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

            let reply = '⚠️ No pude procesar tu solicitud. Intenta de nuevo.';
            try {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                });
                if (r.ok) {
                    const d = await r.json();
                    if (d.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Mensaje Principal', 'gpt-4o-mini', d.usage);
                    const t = d?.choices?.[0]?.message?.content?.trim();
                    if (t) reply = t;
                }
            } catch (e) {}

            // -- PASO SUPERVISOR IA --
            if (reply) reply = await callSupervisor(user._id.toString(), systemWithRefs, text, reply);

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

            // --- 2. ENTREGA DE PDFS / WORDS POR WHATSAPP ---
            if (reply.includes('[GENERATE_WORD]')) {
                try {
                    let jsonData = {};
                    const jsonMatch = reply.match(/```json\s*(\{[\s\S]*?\})\s*```/);
                    if (jsonMatch) {
                        jsonData = JSON.parse(jsonMatch[1]);
                    }

                    if (activeConv && activeConv.pendingFormatId) {
                        const formatDoc = await getDb().collection('doc_formats').findOne({ _id: new mongoose.Types.ObjectId(activeConv.pendingFormatId) });
                        if (formatDoc && formatDoc.filePath) {
                            const templatePath = path.join(PROJECT_ROOT, 'public', formatDoc.filePath);
                            const outDir = path.join(PROJECT_ROOT, 'public', 'downloads');
                            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
                            
                            const outFilename = `Documento-${from}-${Date.now()}.docx`;
                            const outPath = path.join(outDir, outFilename);
                            const outUrl = `https://planixa.onrender.com/public/downloads/${outFilename}`;
                            
                            const content = fs.readFileSync(templatePath, 'binary');
                            const zip = new PizZip(content);
                            const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
                            
                            doc.render(jsonData);
                            
                            const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
                            fs.writeFileSync(outPath, buf);

                            await sendWhatsAppMessage(from, "Aquí tienes tu documento estructurado en Word, profe 📄✨");
                            await sendWhatsAppDocument(from, outUrl, outFilename);
                        } else {
                            await sendWhatsAppMessage(from, "Hubo un error localizando la plantilla original.");
                        }
                    } else {
                        await sendWhatsAppMessage(from, "Hubo un problema encontrando el formato.");
                    }
                } catch(e) {
                    console.error("Error generating word: ", e);
                    await sendWhatsAppMessage(from, "Ocurrió un error rellenando el documento Word.");
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
