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

            if (user.plan !== 'lifetime' && user.plan !== 'exempt' && !user.is_admin) {
                const now = new Date();
                const expires = user.plan_expires ? new Date(user.plan_expires) : null;
                const isTrial = user.plan === 'trial';
                
                let blockReason = null;
                if (!expires || expires < now) blockReason = isTrial ? 'Tu período de prueba de 3 días ha finalizado. 😔' : 'Tu plan ha expirado. 😔';
                else if (currentCount >= maxPlans) blockReason = 'Has alcanzado el límite de planificaciones de tu plan actual. 😔';

                if (blockReason) {
                    const payMsg = `Hola profe. ${blockReason}\n\nPara seguir ahorrando horas de trabajo con **Planixa Asistente**, renueva tu acceso:\n\n💳 **Azul / CardNet:** [Aquí tu link Azul]\n💳 **PayPal:** [Aquí tu link PayPal]\n\nSelecciona el método que prefieras en los enlaces arriba. Si pagas por transferencia bancaria (Banreservas/Popular), responde este mensaje para enviarte los datos.`;
                    await sendWhatsAppMessage(from, payMsg, req.app);
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
                // Solo enviar los últimos 20 mensajes al contexto
                const recentMessages = activeConv.messages.slice(-20);
                historyMessages = recentMessages.map(m => {
                    const msg = { role: m.role, content: m.content || '' };
                    if (m.tool_calls) msg.tool_calls = m.tool_calls;
                    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
                    if (m.name) msg.name = m.name;
                    return msg;
                });
                req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#14b8a6', title: 'Memoria Cargada', details: `Se cargaron los últimos ${historyMessages.length} mensajes del historial.` });
            }

            const refDocs = await getDb().collection('references').find({ userId }).toArray();
            let refBlock = '';
            if (refDocs.length > 0) {
                refBlock = '\n\nDOCUMENTOS DE REFERENCIA DEL DOCENTE:\n' + refDocs.map(r => `📄 ${r.name}: ${(r.text||'').slice(0,2000)}`).join('\n---\n');
            }

            const knowledgeItems = await getDb().collection('knowledge').find({}).toArray();
            let globalKnowledgeBlock = '';
            if (knowledgeItems && knowledgeItems.length > 0) {
                req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#8b5cf6', title: 'Consultando Conocimientos', details: 'Extrayendo base curricular del MINERD.' });
                globalKnowledgeBlock = '\n\n📚 BASE DE CONOCIMIENTOS OFICIAL (REGLAS Y DATOS GLOBALES OBLIGATORIOS):\n';
                for (const item of knowledgeItems) {
                    globalKnowledgeBlock += `\n[${item.title}]:\n${item.content}\n---\n`;
                }
                if (globalKnowledgeBlock.length > 50000) {
                    globalKnowledgeBlock = globalKnowledgeBlock.substring(0, 50000) + '\n...[CONTENIDO RECORTADO POR LÍMITE DE MEMORIA DEL SISTEMA]';
                }
                globalKnowledgeBlock += '\nUSA ESTA BASE DE CONOCIMIENTOS COMO FUENTE PRINCIPAL DE VERDAD. SI UN DATO ESTÁ AQUÍ, ES OFICIAL DEL MINERD.\n';
            }

            let MINERD_SYSTEM_PROMPT = `Eres "Planixa", asistente de planificación docente del MINERD. Responde en español dominicano.`;
            let hasFormat = false; // declarado fuera del try para que sea accesible en la generación forzada
            let defaultPrompt = null;
            let selectedPrompt = null;
            let reply = '';
            let finalJsonFromSpecialist = null;
            let finalSpecIdUsed = null;
            
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
                
                // Ejecutar extracción de perfil de fondo (implementado en el prompt de sistema)
                if (!defaultPrompt) {
                    console.error("No hay prompts configurados. Creando prompt de emergencia.");
                    defaultPrompt = { content: 'Eres Planixa Asistente, un IA experto dominicano.', _id: 'default_emergency_id' };
                }

                const availableSpecialists = prompts.filter(p => p._id.toString() !== defaultPrompt._id.toString());
                const availableFormats = formats.map(f => f.type);
                
                const formatsDict = {};
                formats.forEach(f => formatsDict[f._id.toString()] = f.type);
                
                const availableSpecialistsStr = availableSpecialists.map(s => {
                    let supportedStr = "Todas";
                    if (s.supported_formats && s.supported_formats.length > 0) {
                        supportedStr = s.supported_formats.map(id => formatsDict[id] || id).join(', ');
                    }
                    return `- ${s.name} (Anclado a plantillas: ${supportedStr})`;
                }).join('\n');

MINERD_SYSTEM_PROMPT = defaultPrompt.content + 
                                       `\n\n=== ESTADO DEL DOCENTE ===\nPerfil: ${user.name||'No especificado'}, Grado: ${user.grade||'No especificado'}, Área: ${user.area||'No especificada'}\n\n=== HERRAMIENTAS INTERNAS ===\nEspecialistas disponibles:\n${availableSpecialistsStr}\n\nPlantillas disponibles: ${availableFormats.join(', ')}\n\n=== REGLA DE GENERACIÓN ===\n1. RECOLECTAR DATOS: Si no sabes grado, materia, tema o plantilla preferida, pregunta amablemente antes de avanzar.\n2. DELEGAR AL BACK-OFFICE: SÓLO cuando tengas claro qué tipo de estructura o documento quiere el maestro, DEBES delegar el trabajo usando la herramienta "consultar_especialista" pasando el ID adecuado y el NOMBRE EXACTO de la plantilla.\n3. AUDITAR Y ENTREGAR: Si el especialista reporta "ESTADO: FALTA_DATO_ESENCIAL", PREGÚNTALE AL PROFESOR ese dato que falta de forma natural y NO uses la etiqueta de generar documento. Si el especialista devuelve el documento Markdown, preséntalo amigablemente.\n4. GENERACIÓN DE DOCUMENTO: SÓLO puedes usar la etiqueta [GENERATE_DOCX] SI Y SÓLO SI acabas de llamar a la herramienta "consultar_especialista" y recibiste la planificación completada. ¡ESTÁ ESTRICTAMENTE PROHIBIDO usar [GENERATE_DOCX] antes de consultar al especialista!\n5. VIGILANTE RECOLECTOR (PERFIL): Si el profesor menciona su nombre, grado, área escolar o centro educativo, DEBES incluir esta etiqueta en tu respuesta: [UPDATE_PROFILE: {"name":"...", "grade":"...", "area":"...", "school":"..."}]. Si menciona un gusto o preferencia, usa [MEMORIA: ...].`;

                // Removemos globalKnowledgeBlock del Orquestador para no distraerlo. Solo se lo enviamos al Especialista.
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
                                    plantilla_nombre: { type: "string", description: "Copia y pega EXACTAMENTE el nombre de la plantilla elegida desde la lista de Plantillas disponibles (Ej: Plantilla_Planificacion_Diaria_Primaria_Unidad_Aprendizaje). ¡NO inventes nombres, copia el texto tal cual!" },
                                    instrucciones_detalladas: { type: "string", description: "Instrucciones detalladas y explícitas con TODO lo que el especialista necesita redactar (tema, grado, área, etc)." }
                                },
                                required: ["especialista_id", "plantilla_nombre", "instrucciones_detalladas"]
                            }
                        }
                    }
                ];

                reply = '⚠️ Ocurrió un error en el Orquestador.';

                const orqModel = selectedPrompt.model || 'gpt-4o-mini';
                req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#8b5cf6', title: 'Flujo del Orquestador (Jefe)', details: 'Planixa Principal: Identidad (Prompt Principal) + Perfil del Profesor (Grado/Área) + Base de Conocimientos MINERD (Reglas) + Menú de Especialistas (con sus plantillas ancladas) + Catálogo General de Plantillas -> Interactúa con el usuario -> Recolecta datos -> Planixa Principal: ordena a Especialista (Pasa ID + Instrucciones)' });
                const orquestadorRes = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({
                        model: orqModel,
                        messages: messages,
                        tools: tools,
                        tool_choice: "auto",
                        max_tokens: 1500,
                        temperature: 0.3
                    })
                });

                if (orquestadorRes.ok) {
                    const orqData = await orquestadorRes.json();
                    if (orqData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Orquestador', orqModel, orqData.usage);
                    
                    const responseMessage = orqData.choices[0].message;

                    if (responseMessage.tool_calls) {
                        messages.push(responseMessage);
                        
                        for (const toolCall of responseMessage.tool_calls) {
                            if (toolCall.function.name === 'consultar_especialista') {
                                const args = JSON.parse(toolCall.function.arguments);
                                const specId = args.especialista_id;
                                const specInst = args.instrucciones_detalladas;
                                const plantillaNombre = args.plantilla_nombre;
                                finalSpecIdUsed = specId;

                                // Guardar el ID del formato de la plantilla explícitamente seleccionado
                                let exactFormat = null;
                                if (plantillaNombre) {
                                    // Búsqueda flexible (fuzzy match)
                                    exactFormat = formats.find(f => f.type === plantillaNombre) || 
                                                  formats.find(f => f.type.toLowerCase().includes(plantillaNombre.toLowerCase().replace(/_/g, ' '))) ||
                                                  formats.find(f => plantillaNombre.toLowerCase().includes(f.type.toLowerCase().replace(/_/g, ' ')));
                                    
                                    if (exactFormat) {
                                        if (activeConv) activeConv.pendingFormatId = exactFormat._id.toString();
                                        req.pendingFormatId = exactFormat._id.toString();
                                        req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#10b981', title: 'Plantilla Fijada', details: exactFormat.type });
                                    }
                                }
                                
                                // Buscar por nombre (como lo genera el LLM) o por ID (fallback)
                                const specPromptDoc = prompts.find(p => p.name === specId || p._id.toString() === specId);
                                if (specPromptDoc) {
                                    req.app.emit('system_log', { type: 'ESPECIALISTA', color: '#f59e0b', title: 'Delegando al Back-Office', details: specPromptDoc.name });
                                    
                                    let dynamicInstructions = '\n\n### REGLA CRÍTICA: ESTRUCTURA REQUERIDA\nEl Orquestador es un sistema automatizado que procesará tu respuesta. Es OBLIGATORIO que entregues todo el contenido de la planificación formateado en **Markdown**.\n';
                                    dynamicInstructions += 'Usa tablas (`|---|`), títulos (`#`), listas y negritas para estructurar el documento.\n';
                                    dynamicInstructions += 'NUNCA devuelvas JSON. Tu respuesta debe ser la planificación completa en Markdown, lista para ser convertida a Word.\n';
                                    
                                    dynamicInstructions += '\n\nIMPORTANTE: ¡Asegúrate de incluir toda la información detallada! NO DEVUELVAS TEXTO DE RELLENO, SOLO EL INFORME COMPLETO EN MARKDOWN.';

                                    const specModel = specPromptDoc.model || 'gpt-4o-mini';
                                    req.app.emit('system_log', { type: 'ESPECIALISTA', color: '#f59e0b', title: `Flujo del Especialista (${specPromptDoc.name})`, details: `(Datos Recibidos + Accediendo a "Plantillas" + Datos de Plantilla "${plantillaNombre || 'X'}" Extraídos + Accediendo a "Conocimientos Planixa" + Conocimientos de Planixa Extraídos + Inyectando Datos en Plantilla "${plantillaNombre || 'X'}" + Enviando Archivo a Planixa Principal)` });
                                    const specRes = await fetch('https://api.openai.com/v1/chat/completions', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                                        body: JSON.stringify({
                                            model: specModel, 
                                            messages: [
                                                { role: 'system', content: specPromptDoc.content },
                                                { role: 'user', content: specInst + '\n\n' + dynamicInstructions + '\n\n' + refBlock + '\n\n' + globalKnowledgeBlock }
                                            ],
                                            max_tokens: 3500,
                                            temperature: 0.2
                                        })
                                    });

                                    let specResultText = 'Error en especialista.';
                                    if (specRes.ok) {
                                        const sData = await specRes.json();
                                        if (sData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Especialista Back', specModel, sData.usage);
                                        specResultText = sData.choices[0].message.content;
                                        
                                        // Extraer MARKDOWN directamente del especialista para no perderlo
                                        const mdMatch = specResultText.match(/```markdown\s*([\s\S]*?)\s*```/) || specResultText.match(/([\s\S]+)/);
                                        if (mdMatch) finalJsonFromSpecialist = mdMatch[1]; // reutilizamos la variable para guardar el MD
                                        
                                        // DEBUG DUMP
                                        const fs = require('fs');
                                        const path = require('path');
                                        try {
                                            fs.writeFileSync(path.join(__dirname, '..', '..', 'public', 'downloads', 'debug_spec.txt'), specResultText);
                                        } catch(e) {}
                                        
                                    } else {
                                        const errText = await specRes.text();
                                        console.error("Error API Especialista:", errText);
                                        req.app.emit('system_log', { type: 'ERROR', color: '#ef4444', title: 'Error del Especialista', details: errText.slice(0, 150) });
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

                        req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#3b82f6', title: 'Auditando Trabajo', details: 'El Orquestador está revisando lo entregado.' });
                        const finalModel = selectedPrompt.model || 'gpt-4o-mini';
                        req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#3b82f6', title: 'Generando Respuesta', details: `Escribiendo mensaje final con ${finalModel}...` });
                        const finalRes = await fetch('https://api.openai.com/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                            body: JSON.stringify({
                                model: finalModel,
                                messages: messages,
                                max_tokens: 3500,
                                temperature: 0.4
                            })
                        });

                        if (finalRes.ok) {
                            const fData = await finalRes.json();
                            if (fData.usage) await logApiUsage(user._id.toString(), 'WhatsApp: Orquestador Final', finalModel, fData.usage);
                            reply = fData.choices[0].message.content.trim();
                        }
                    } else {
                        reply = responseMessage.content?.trim() || '';
                    }
                }
            } catch (err) {
                console.error('Error en el Orquestador/Router:', err.message, err.stack);
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

            if ((reply.includes('[GENERATE_PDF]') || reply.includes('[GENERATE_WORD]') || reply.includes('[GENERATE_DOCX]')) && user.plan !== 'lifetime' && !user.is_admin) {
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
            if (reply.includes('[GENERATE_WORD]') || reply.includes('[GENERATE_DOCX]') || finalJsonFromSpecialist) {
                try {
                    let markdownData = finalJsonFromSpecialist || "";
                    if (!markdownData) {
                        const mdMatch = reply.match(/```markdown\s*([\s\S]*?)\s*```/);
                        if (mdMatch) {
                            markdownData = mdMatch[1];
                        } else if (reply.length > 300) {
                            markdownData = reply;
                        }
                    }
                    
                    // Limpiar etiquetas de la IA
                    markdownData = markdownData.replace(/\[GENERATE_DOCX\]/g, '').replace(/\[GENERATE_WORD\]/g, '').trim();

                    const outDir = path.join(PROJECT_ROOT, 'public', 'downloads');
                    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

                    req.app.emit('system_log', { type: 'SISTEMA NODE.JS', color: '#10b981', title: 'Generando Documento Final', details: 'El servidor está convirtiendo el Markdown a un archivo Word desde cero.' });

                    const outFilename = `Documento-${from}-${Date.now()}.docx`;
                    const outPath = path.join(outDir, outFilename);
                    const outUrl = `https://planixa.onrender.com/public/downloads/${outFilename}`;

                    const HTMLtoDOCX = require('html-to-docx');
                    const { marked } = require('marked');

                    const htmlContent = marked.parse(markdownData);
                    const styledHtml = `
                    <!DOCTYPE html>
                    <html lang="es">
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: 'Arial', sans-serif; font-size: 11pt; color: #000000; }
                            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                            th, td { border: 1px solid #000000; padding: 8px; text-align: left; vertical-align: top; }
                            th { background-color: #f2f2f2; font-weight: bold; }
                            h1 { color: #1a365d; font-size: 20pt; text-align: center; border-bottom: 2px solid #1a365d; padding-bottom: 10px; }
                            h2 { color: #2b6cb0; font-size: 16pt; margin-top: 20px; }
                            h3 { color: #2d3748; font-size: 14pt; }
                            p { margin-bottom: 10px; line-height: 1.5; }
                            ul, ol { margin-bottom: 10px; padding-left: 20px; }
                        </style>
                    </head>
                    <body>
                        ${htmlContent}
                    </body>
                    </html>
                    `;

                    const fileBuffer = await HTMLtoDOCX(styledHtml, null, {
                        table: { row: { cantSplit: true } },
                        footer: true,
                        pageNumber: true
                    });

                    const fs2 = require('fs');
                    fs2.writeFileSync(outPath, fileBuffer);

                    await sendWhatsAppMessage(from, '¡Aquí tienes tu documento Word, profe! 📄✨', req.app);
                    await sendWhatsAppDocument(from, outUrl, outFilename);

                    if (activeConv) {
                        await getDb().collection('conversations').updateOne(
                            { _id: activeConv._id },
                            { $unset: { pendingFormatId: '' } }
                        ).catch(() => {});
                    }

                } catch(e) {
                    console.error('[WORD GEN] Error HTMLtoDOCX:', e.message, e.stack);
                    require('../utils/debug_logger')('Crash HTMLtoDOCX', e, finalJsonFromSpecialist || '', 'HTML');
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
            console.error('WhatsApp webhook error:', err.message, err.stack);
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

// ==========================================
// UTILIDADES DE PROCESAMIENTO DE MULTIMEDIA
// ==========================================

async function downloadWhatsAppMedia(mediaId) {
    const waToken = process.env.WA_ACCESS_TOKEN;
    if (!waToken) throw new Error("WA_ACCESS_TOKEN no está configurado en las variables de entorno.");

    const resUrl = await fetch(`https://graph.facebook.com/v17.0/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${waToken}` }
    });
    if (!resUrl.ok) throw new Error(`Error obteniendo URL del medio: ${await resUrl.text()}`);
    
    const data = await resUrl.json();
    const mediaUrl = data.url;

    const resMedia = await fetch(mediaUrl, {
        headers: { 'Authorization': `Bearer ${waToken}` }
    });
    
    if (!resMedia.ok) throw new Error(`Error descargando medio desde Meta: ${await resMedia.text()}`);
    
    const arrayBuffer = await resMedia.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

async function processAudioWhisper(buffer) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY no configurado.");

    // Usamos Blob y FormData nativos de Node.js 18+
    const blob = new Blob([buffer], { type: 'audio/ogg' });
    const formData = new FormData();
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'whisper-1');
    formData.append('language', 'es'); // Forzamos español por ser MINERD

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`
        },
        body: formData
    });

    if (!res.ok) {
        throw new Error(`Error en transcripción Whisper: ${await res.text()}`);
    }

    const json = await res.json();
    return json.text;
}
