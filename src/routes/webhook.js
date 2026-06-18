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

            req.app.emit('system_log', { type: 'WHATSAPP_IN', color: '#25D366', title: 'Mensaje Recibido', details: `De: ${from}` });

            console.log('WhatsApp de', from, ':', text);
            await getDb().collection('client_messages').insertOne({ phone: from, message: text, direction: 'incoming', employeeId: null, employeeName: null, createdAt: new Date() });

            let userId;
            let user = await getDb().collection('users').findOne({ phone: from });
            if (!user) {
                const hashed = await bcrypt.hash(from.slice(-6), 12);
                const result = await getDb().collection('users').insertOne({ phone: from, password: hashed, name: '', grade: '', area: '', school: '', role: 'teacher', is_admin: false, plan: 'trial', plan_expires: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), plans_count: 0, created_at: new Date() });
                userId = result.insertedId.toString();
                user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
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

            // Eliminado el bloque hardcoded de recolección de nombre.
            // ProfileWatcher se encarga silenciosamente de la extracción de perfil, y Planixa_Principal de la interacción.

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
            let defaultPrompt = null;
            let selectedPrompt = null;
            
            try {
                // Fetch prompts
                const prompts = await getDb().collection('prompts').find({}).toArray();
                const formats = await getDb().collection('doc_formats').find({}).toArray();
                
                // Buscar explícitamente "Planixa Asistente" como el por defecto (soporta guiones bajos)
                defaultPrompt = prompts.find(p => p.name && p.name.replace(/_/g, ' ').trim().toLowerCase() === 'planixa asistente') || (prompts.length > 0 ? prompts[0] : null);
                selectedPrompt = defaultPrompt;

                // ══════════════════════════════════════════════════════════
                // NUEVA ARQUITECTURA: ORQUESTADOR MAESTRO (PLANIXA ASISTENTE)
                // ══════════════════════════════════════════════════════════
                
                profileWatcher(); // Ejecutar extracción de perfil de fondo

                const availableSpecialists = prompts.filter(p => p._id.toString() !== defaultPrompt._id.toString());
                const availableFormats = formats.map(f => f.type).join(', ');

                MINERD_SYSTEM_PROMPT = defaultPrompt.content + `
                
DATOS DEL PROFESOR:
Nombre: ${user.name || 'Profe'}
Grado: ${user.grade || 'No especificado'}
Área: ${user.area || 'No especificada'}
Centro Educativo: ${user.school || 'No especificado'}

REGLA DE PERFIL: Si el profesor expresa gusto/preferencia, usa la etiqueta [MEMORIA: pref]. Si el profesor dice su nombre/grado/área/escuela, usa la etiqueta [UPDATE_PROFILE: {"name":"...", "grade":"..."}].

PLANTILLAS DISPONIBLES: ${availableFormats}.
ESPECIALISTAS DISPONIBLES (BACK-OFFICE):
${availableSpecialists.map(p => `- ID: ${p._id.toString()} | ${p.name} | Cuándo usar: ${p.description}`).join('\n')}

TU ROL (EL ORQUESTADOR):
Eres el encargado de interactuar con el profesor y coordinar el trabajo. 
1. REGLA DE CLARIFICACIÓN: Si el profesor hace un comentario general, pide ayuda vaga o dice un tema (ej. "tengo que dar fracciones mañana" o "ayúdame con una clase"), NO adivines qué documento quiere ni uses herramientas. DEBES preguntarle primero de forma natural: "¿Qué te gustaría armar profe? ¿Una planificación diaria, una unidad, una rúbrica, o solo quieres ideas?".
2. DELEGAR AL BACK-OFFICE: SÓLO cuando tengas claro qué tipo de estructura o documento quiere el maestro, DEBES delegar el trabajo usando la herramienta "consultar_especialista" pasando el ID adecuado y todas las instrucciones necesarias. NO intentes redactar la estructura técnica tú mismo.
3. AUDITAR Y ENTREGAR: Una vez que el especialista te devuelva la estructura cruda, audítala. Si está correcta, preséntala al profesor de manera amigable (usa el separador ||| para dividir tu saludo del contenido técnico).
4. GENERACIÓN DE DOCUMENTO: Si el documento final requiere exportarse a Word, agrega al final de tu mensaje la etiqueta [GENERATE_DOCX] o [GENERATE_WORD] y el bloque \`\`\`json con los datos requeridos. NUNCA inventes enlaces de descarga web [Descargar](#).`;

                const systemWithRefs = MINERD_SYSTEM_PROMPT + refBlock;
                const messages = [
                    { role: 'system', content: systemWithRefs },
                    ...historyMessages,
                    { role: 'user', content: text }
                ];

                const tools = [
                    {
                        type: "function",
                        function: {
                            name: "consultar_especialista",
                            description: "Delega la creación de una planificación o estructura a un Especialista técnico en el back-office. Usa esto siempre que el profesor pida crear un material.",
                            parameters: {
                                type: "object",
                                properties: {
                                    especialista_id: { type: "string", description: "El ID del especialista seleccionado." },
                                    instrucciones_detalladas: { type: "string", description: "Instrucciones detalladas y explícitas con TODO lo que el especialista necesita redactar (tema, grado, área, etc)." }
                                },
                                required: ["especialista_id", "instrucciones_detalladas"]
                            }
                        }
                    }
                ];

                let reply = '⚠️ Ocurrió un error en el Orquestador.';

                const orquestadorRes = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({
                        model: 'gpt-4o',
                        messages: messages,
                        tools: tools,
                        tool_choice: "auto",
                        max_tokens: 1500,
                        temperature: 0.3
                    })
                });

                if (orquestadorRes.ok) {
                    const orqData = await orquestadorRes.json();
                    if (orqData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Orquestador', 'gpt-4o', orqData.usage);
                    
                    const responseMessage = orqData.choices[0].message;

                    if (responseMessage.tool_calls) {
                        messages.push(responseMessage);
                        
                        for (const toolCall of responseMessage.tool_calls) {
                            if (toolCall.function.name === 'consultar_especialista') {
                                const args = JSON.parse(toolCall.function.arguments);
                                const specId = args.especialista_id;
                                const specInst = args.instrucciones_detalladas;
                                
                                const specPromptDoc = prompts.find(p => p._id.toString() === specId);
                                if (specPromptDoc) {
                                    req.app.emit('system_log', { type: 'ESPECIALISTA', color: '#f59e0b', title: 'Delegando al Back-Office', details: specPromptDoc.name });
                                    
                                    const specRes = await fetch('https://api.openai.com/v1/chat/completions', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                                        body: JSON.stringify({
                                            model: 'gpt-4o', 
                                            messages: [
                                                { role: 'system', content: specPromptDoc.content + refBlock },
                                                { role: 'user', content: specInst }
                                            ],
                                            max_tokens: 3500,
                                            temperature: 0.2
                                        })
                                    });

                                    let specResultText = 'Error en especialista.';
                                    if (specRes.ok) {
                                        const sData = await specRes.json();
                                        if (sData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Especialista Back', 'gpt-4o', sData.usage);
                                        specResultText = sData.choices[0].message.content;
                                    }

                                    messages.push({
                                        tool_call_id: toolCall.id,
                                        role: "tool",
                                        name: "consultar_especialista",
                                        content: specResultText
                                    });
                                } else {
                                    messages.push({
                                        tool_call_id: toolCall.id,
                                        role: "tool",
                                        name: "consultar_especialista",
                                        content: "Error: Especialista no encontrado."
                                    });
                                }
                            }
                        }

                        req.app.emit('system_log', { type: 'ORQUESTADOR', color: '#3b82f6', title: 'Auditando Trabajo', details: 'El Orquestador está revisando lo entregado.' });
                        const finalRes = await fetch('https://api.openai.com/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                            body: JSON.stringify({
                                model: 'gpt-4o',
                                messages: messages,
                                max_tokens: 3500,
                                temperature: 0.4
                            })
                        });

                        if (finalRes.ok) {
                            const fData = await finalRes.json();
                            if (fData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Orquestador Final', 'gpt-4o', fData.usage);
                            reply = fData.choices[0].message.content.trim();
                        }
                    } else {
                        reply = responseMessage.content?.trim() || '';
                    }
                }
            } catch (err) {
                console.error('Error en el Orquestador/Router:', err.message);
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
            if (reply.includes('[GENERATE_WORD]') || reply.includes('[GENERATE_DOCX]')) {
                try {
                    let jsonData = {};
                    const jsonMatch = reply.match(/```json\s*(\{[\s\S]*?\})\s*```/) || reply.match(/(\{[\s\S]*?\})/);
                    if (jsonMatch) {
                        try {
                            jsonData = JSON.parse(jsonMatch[1]);
                        } catch(e) { console.error('[WORD GEN] JSON parse error:', e.message); }
                    }

                    let fmtId = (activeConv && activeConv.pendingFormatId) || req.pendingFormatId;

                    // --- FALLBACK DE EMERGENCIA ---
                    if (!fmtId) {
                        console.log('[WORD GEN] No hay pendingFormatId, intentando resolver...');
                        const allFormats = await getDb().collection('doc_formats').find({}).toArray();
                        const jStr = Object.keys(jsonData).length > 0 ? JSON.stringify(jsonData).toLowerCase() : '';
                        let bestFmt = null;
                        if (jStr) {
                            if (jStr.includes('inicial')) bestFmt = allFormats.find(f => f.type.toLowerCase().includes('inicial'));
                            else if (jStr.includes('primari')) bestFmt = allFormats.find(f => f.type.toLowerCase().includes('primari'));
                            else if (jStr.includes('modalidad') && jStr.includes('secundari')) bestFmt = allFormats.find(f => f.type.toLowerCase().includes('modalidad'));
                            else if (jStr.includes('secundari')) bestFmt = allFormats.find(f => f.type.toLowerCase().includes('secundari') && !f.type.toLowerCase().includes('modalidad'));
                        }
                        
                        if (bestFmt) fmtId = bestFmt._id.toString();
                        else if (allFormats.length > 0) fmtId = allFormats[0]._id.toString(); // último recurso
                    }

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

                            await sendWhatsAppMessage(from, '¡Aquí tienes tu documento Word, profe! 📄✨', req.app);
                            await sendWhatsAppDocument(from, outUrl, outFilename);

                            // Limpiar pendingFormatId
                            if (activeConv) {
                                await getDb().collection('conversations').updateOne(
                                    { _id: activeConv._id },
                                    { $unset: { pendingFormatId: '' } }
                                );
                            }
                        } else {
                            await sendWhatsAppMessage(from, 'Hubo un error localizando la plantilla original.', req.app);
                        }
                    } else {
                        await sendWhatsAppMessage(from, 'Hubo un problema encontrando el formato.', req.app);
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
                
                // Dividir el mensaje por el separador ||| o por doble salto de línea para enviarlo en burbujas separadas
                const messages = waReply.split(/(?:\|\|\||\n\n)/g).map(m => m.trim()).filter(m => m.length > 0);
                
                for (let i = 0; i < messages.length; i++) {
                    const msgText = messages[i];
                    // Asegurar que ninguna burbuja exceda los 4000 caracteres
                    const chunks = msgText.match(/[\s\S]{1,4000}/g) || [];
                    for (const chunk of chunks) {
                        await sendWhatsAppMessage(from, chunk, req.app);
                    }
                    if (i < messages.length - 1) {
                        // Pequeña pausa para asegurar orden de entrega en WhatsApp
                        await new Promise(resolve => setTimeout(resolve, 800));
                    }
                }
            }

        } catch (err) {
            console.error('WhatsApp webhook error:', err.message);
        }
    });
};

async function sendWhatsAppMessage(to, text, app) {
    if (app) app.emit('system_log', { type: 'WHATSAPP_OUT', color: '#25D366', title: 'Mensaje Enviado', details: `Para: ${to}` });
    
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
