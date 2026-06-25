const { getDb } = require('../db');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { logApiUsage } = require('../finance');
const { callSupervisor } = require('../utils/supervisor');
const { createDocxFromHtml } = require('../utils/google_docs');
const { buildProfessionalHtml } = require('../utils/docx_styles');
const { marked } = require('marked');

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
                                       `\n\n=== ESTADO DEL DOCENTE ===\nPerfil: ${user.name||'No especificado'}, Grado: ${user.grade||'No especificado'}, Área: ${user.area||'No especificada'}\n\n=== HERRAMIENTAS INTERNAS ===\nEspecialistas disponibles:\n${availableSpecialistsStr}\n\nPlantillas disponibles: ${availableFormats.join(', ')}\n\n=== REGLA DE DELEGACIÓN ===\n1. RECOLECTAR DATOS: Si no sabes grado, materia, tema o plantilla preferida, pregunta amablemente antes de avanzar.\n2. DELEGAR AL BACK-OFFICE (OBLIGATORIO): SÓLO cuando tengas claro qué tipo de estructura o documento quiere el maestro, DEBES delegar el trabajo usando la función/herramienta "consultar_especialista" pasando el ID adecuado y el NOMBRE EXACTO de la plantilla. \n3. ¡ESTRICTAMENTE PROHIBIDO! NUNCA intentes escribir los datos del especialista como texto en tu mensaje. TU ÚNICA ACCIÓN es ejecutar la LLAMADA A LA FUNCIÓN (tool call) consultar_especialista.\n4. VIGILANTE RECOLECTOR (PERFIL): Si el profesor menciona su nombre, grado, área escolar o centro educativo, DEBES llamar a la herramienta "actualizar_perfil_docente". Si menciona un gusto o preferencia, usa la etiqueta de texto [MEMORIA: ...].`;

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
                    },
                    {
                        type: "function",
                        function: {
                            name: "actualizar_perfil_docente",
                            description: "Actualiza silenciosamente los datos del maestro en la base de datos (nombre, grado, área, escuela). Usa esto SIEMPRE que el profesor confirme o mencione alguno de estos datos, INCLUSO si vas a llamar a consultar_especialista al mismo tiempo.",
                            parameters: {
                                type: "object",
                                properties: {
                                    name: { type: "string", description: "Nombre completo del docente" },
                                    grade: { type: "string", description: "Grado o curso que imparte (ej. Segundo Grado)" },
                                    area: { type: "string", description: "Materia o área curricular (ej. Matemáticas, Lengua Española)" },
                                    school: { type: "string", description: "Centro educativo o escuela" }
                                }
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
                                if (plantillaNombre && plantillaNombre.toLowerCase() !== 'ninguna' && plantillaNombre.toLowerCase() !== 'ninguno') {
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
                                
                                // Si no hay formato exacto y no dijo "Ninguna", abortar
                                if (!exactFormat && plantillaNombre && plantillaNombre.toLowerCase() !== 'ninguna' && plantillaNombre.toLowerCase() !== 'ninguno') {
                                    messages.push({
                                        tool_call_id: toolCall.id,
                                        role: "tool",
                                        name: "consultar_especialista",
                                        content: JSON.stringify({
                                            "ESTADO": "FALTA_DATO_ESENCIAL",
                                            "MENSAJE_PARA_PLANIXA_PRINCIPAL": "Error interno: El nombre de la plantilla proporcionado no coincide con ninguna plantilla disponible. Revisa la lista de plantillas y VUELVE A LLAMAR A LA HERRAMIENTA con el nombre EXACTO de la plantilla adecuada, o pasa 'Ninguna' si el profesor explícitamente no quiere plantilla."
                                        })
                                    });
                                    continue;
                                }
                                
                                // Buscar por nombre (como lo genera el LLM) o por ID (fallback)
                                const specPromptDoc = prompts.find(p => p.name === specId || p._id.toString() === specId);
                                if (specPromptDoc) {
                                    req.app.emit('system_log', { type: 'ESPECIALISTA', color: '#f59e0b', title: 'Delegando al Back-Office', details: specPromptDoc.name });
                                    let dynamicInstructions = '\n\n### FORMATO OBLIGATORIO: TABLAS\nTodo el contenido DEBE estructurarse en **tablas Markdown**. NO uses listas con viñetas para datos estructurados.\n';
                                    dynamicInstructions += '- Usa | Col1 | Col2 | con filas de separación |---|---|\n';
                                    dynamicInstructions += '- Datos clave-valor (Grado, Tema) van en tabla de 2 columnas\n';
                                    dynamicInstructions += '- Actividades con evidencia/recursos van en tabla de 3-4 columnas\n';
                                    if (exactFormat) {
                                        dynamicInstructions += `\n**ESTRUCTURA SUGERIDA (${exactFormat.type})**: Cubre estos campos: ${exactFormat.tags ? exactFormat.tags.join(', ') : 'los propios del MINERD'}\n`;
                                    }
                                    dynamicInstructions += '\nLa ÚLTIMA línea de tu respuesta DEBE ser exactamente: [GENERATE_DOCX]';

                                    const specModel = specPromptDoc.model || 'gpt-4o-mini';
                                    req.app.emit('system_log', { type: 'ESPECIALISTA', color: '#f59e0b', title: `Flujo del Especialista (${specPromptDoc.name})`, details: `(Datos Recibidos + Accediendo a "Plantillas" + Datos de Plantilla "${plantillaNombre || 'X'}" Extraídos + Accediendo a "Conocimientos Planixa" + Conocimientos de Planixa Extraídos + Generando contenido + Enviando Archivo a Planixa Principal)` });
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
                                        
                                        finalJsonFromSpecialist = specResultText;
                                        
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

                        if (finalJsonFromSpecialist) {
                            messages.push({
                                role: 'system',
                                content: 'El especialista ha terminado y te ha devuelto el contenido en Markdown. PRESENTA ESTE CONTENIDO al usuario de forma amigable. IMPORTANTE: Para que el servidor genere el archivo Word, DEBES incluir [GENERATE_DOCX] al final de tu mensaje.'
                            });
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
            
            const profileMatch = reply?.match(/\[UPDATE_PROFILE:\s*(\{[\s\S]*?\})\s*\]/i);
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
                    reply = reply.replace(/\[UPDATE_PROFILE:\s*\{[\s\S]*?\}\s*\]/i, '').trim();
                } catch(e) {
                    console.error("Error parsing UPDATE_PROFILE", e);
                }
            }

            const memMatch = reply.match(/\[MEMORIA:\s*([\s\S]+?)\]/i);
            if (memMatch) {
                const newPref = memMatch[1].trim();
                reply = reply.replace(/\[MEMORIA:\s*[\s\S]+?\]/i, '').trim();
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

                    // Si por alguna razón la IA alucinó [GENERATE_DOCX] pero no llamó al especialista, lo borramos y no generamos nada
                    if (!finalJsonFromSpecialist) {
                        reply = reply.replace(/\[GENERATE_DOCX\]/g, '').replace(/\[GENERATE_WORD\]/g, '');
                    }

            // --- 2. ENTREGA DE WORDS POR WHATSAPP (Google Docs API) ---
            const hasGenTag = reply.includes('[GENERATE_WORD]') || reply.includes('[GENERATE_DOCX]');
            if (hasGenTag && finalJsonFromSpecialist) {
                try {
                    let markdownData = finalJsonFromSpecialist
                        .replace(/\[GENERATE_DOCX\]/g, '')
                        .replace(/\[GENERATE_WORD\]/g, '')
                        .trim();

                    if (!markdownData) {
                        markdownData = reply.replace(/\[GENERATE_DOCX\]/g, '').replace(/\[GENERATE_WORD\]/g, '').trim();
                    }

                    req.app.emit('system_log', { type: 'SISTEMA NODE.JS', color: '#10b981', title: 'Generando Documento', details: 'Google Docs API: creando documento Word profesional' });

                    const htmlContent = marked.parse(markdownData);
                    const finalFormatId = req.pendingFormatId || (activeConv && activeConv.pendingFormatId);
                    let styledHtml;

                    if (finalFormatId) {
                        const formatDoc = await getDb().collection('doc_formats').findOne({ _id: new mongoose.Types.ObjectId(finalFormatId) });
                        if (formatDoc && formatDoc.htmlTemplate && formatDoc.htmlTemplate.length > 50) {
                            styledHtml = formatDoc.htmlTemplate.replace('{{content}}', htmlContent);
                            req.app.emit('system_log', { type: 'SISTEMA NODE.JS', color: '#10b981', title: 'Usando HTML Template', details: formatDoc.type });
                        } else {
                            styledHtml = buildProfessionalHtml(htmlContent);
                        }
                    } else {
                        styledHtml = buildProfessionalHtml(htmlContent);
                    }

                    const docBuffer = await createDocxFromHtml(styledHtml, `Planifica-${from}-${Date.now()}`);

                    const outDir = path.join(PROJECT_ROOT, 'public', 'downloads');
                    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
                    const outFilename = `Documento-${from}-${Date.now()}.docx`;
                    const outPath = path.join(outDir, outFilename);
                    fs.writeFileSync(outPath, docBuffer);

                    const outUrl = `https://planixa.onrender.com/public/downloads/${outFilename}`;
                    await sendWhatsAppMessage(from, `¡Aquí tienes tu documento en Word, profe! 📄✨\n\n🔗 *Descárgalo aquí:* ${outUrl}`, req.app);

                    if (activeConv) {
                        await getDb().collection('conversations').updateOne(
                            { _id: activeConv._id },
                            { $unset: { pendingFormatId: '' } }
                        ).catch(() => {});
                    }

                } catch(e) {
                    console.error('[DOCX GEN] Error con Google Docs API:', e.message, e.stack);
                    require('../utils/debug_logger')('Crash GoogleDocAPI', e, finalJsonFromSpecialist || '', 'Markdown');
                    await sendWhatsAppMessage(from, 'Ocurrió un error generando el documento. Por favor intenta de nuevo enviando tu solicitud.');
                }
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
