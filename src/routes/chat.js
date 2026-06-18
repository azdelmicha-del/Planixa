const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const { logApiUsage } = require('../finance');
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const mongoose = require('mongoose');
const { callSupervisor } = require('../utils/supervisor');

module.exports = function (app) {
    app.post('/chat', authenticateToken, async (req, res) => {
        const message = String(req.body.message || '').trim();
        if (!message) return res.status(400).json({ response: 'Escribe un mensaje.' });

        const userId = req.userId;
        const conversationId = req.body.conversationId || null;

        let history = [];
        if (conversationId) {
            const conv = await getDb().collection('conversations').findOne({ _id: new (require('mongoose').Types.ObjectId)(conversationId), userId });
            if (conv) {
                // Solo enviar los últimos 20 mensajes al contexto para no saturar tokens ni subir costos
                history = (conv.messages || []).slice(-20);
                if (conv.pendingFormatId) req.pendingFormatId = conv.pendingFormatId;
            }
        }

        const userDoc = await getDb().collection('users').findOne({ _id: new (require('mongoose').Types.ObjectId)(userId) });
        let profileBlock = '';
        if (userDoc) {
            const parts = [];
            if (userDoc.name) parts.push('Nombre del docente: ' + userDoc.name);
            if (userDoc.grade) parts.push('Grado que trabaja: ' + userDoc.grade);
            if (userDoc.area) parts.push('Área/Materia: ' + userDoc.area);
            if (userDoc.school) parts.push('Centro educativo: ' + userDoc.school);
            if (parts.length > 0) profileBlock = '\n\n📋 DATOS DEL DOCENTE:\n' + parts.join('\n') + '\n\nUSA ESTOS DATOS para personalizar las planificaciones.\n';
        }

        const refDocs = await getDb().collection('references').find({ userId }).toArray();
        let referencesBlock = '';
        if (refDocs && refDocs.length > 0) {
            referencesBlock = '\n\n═════════════════════════════════════════════════\nDOCUMENTOS DE REFERENCIA DEL DOCENTE:\n═════════════════════════════════════════════════\n';
            for (const ref of refDocs) {
                const excerpt = (ref.text || '').slice(0, 4000);
                referencesBlock += `\n📄 ${ref.name || ref.fileName} (${ref.pages} págs):\n${excerpt}\n---\n`;
            }
            referencesBlock += '\n═════════════════════════════════════════════════\nUSA ESTOS DOCUMENTOS COMO REFERENCIA para crear las planificaciones.\n';
        }

        let MINERD_SYSTEM_PROMPT = `Eres "Planixa", asistente de planificación docente del MINERD. Responde en español dominicano.`;
        
        try {
            // Fetch prompts
            const prompts = await getDb().collection('prompts').find({}).toArray();
            const formats = await getDb().collection('doc_formats').find({}).toArray();
            
        // Buscar explícitamente "Planixa Principal" como el por defecto (soporta guión bajo y espacios)
        let defaultPrompt = prompts.find(p => p.name && p.name.replace(/_/g, ' ').trim().toLowerCase() === 'planixa principal') || (prompts.length > 0 ? prompts[0] : null);
        let selectedPrompt = defaultPrompt;
        let hasFormat = false;

        let routerPromise = null;
        if (prompts.length > 1) {
            const routerPrompt = `Eres un enrutador inteligente. Tienes los siguientes Especialistas (Prompts) disponibles:\n${prompts.map(p => `- ID: ${p._id.toString()} | Nombre: ${p.name} | Cuándo usar: ${p.description}`).join('\n')}\n\nEl usuario ha dicho: "${message}"\n\nResponde ÚNICAMENTE con el ID del Especialista que mejor puede atender esta solicitud. Si ninguno aplica claramente, responde con el ID del Especialista más general o principal.`;
            
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
            const formatMatcherPrompt = `Eres un clasificador. Revisa si el mensaje del usuario está pidiendo generar un documento. Formatos disponibles: ${formats.map(f => f.type).join(', ')}. Si pide uno de esos, responde EXACTAMENTE con el tipo. Si no, responde "NINGUNO".\nMensaje: "${message}"`;
            
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

        // Ejecutar en paralelo
        const [routerRes, fRes] = await Promise.all([
            routerPromise ? routerPromise.catch(e => { console.error("Router error", e); return null; }) : Promise.resolve(null),
            formatPromise ? formatPromise.catch(e => { console.error("Format error", e); return null; }) : Promise.resolve(null)
        ]);

        if (routerRes && routerRes.ok) {
            const rData = await routerRes.json();
            if (rData.usage) await logApiUsage(userId, 'Web: Enrutador IA', 'gpt-4o-mini', rData.usage);
            const chosenId = rData.choices?.[0]?.message?.content?.trim();
            selectedPrompt = prompts.find(p => p._id.toString() === chosenId) || defaultPrompt;
        }

        if (selectedPrompt) {
            MINERD_SYSTEM_PROMPT = selectedPrompt.content;
        }

        // Inject Profile
        MINERD_SYSTEM_PROMPT += profileBlock;

        if (fRes && fRes.ok) {
            const fData = await fRes.json();
            if (fData.usage) await logApiUsage(userId, 'Web: Clasificador Formato', 'gpt-4o-mini', fData.usage);
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
                    req.pendingFormatId = matchedFormat._id.toString();
                    
                    if (conversationId) {
                        await getDb().collection('conversations').updateOne(
                            { _id: new mongoose.Types.ObjectId(conversationId) },
                            { $set: { pendingFormatId: req.pendingFormatId } }
                        );
                    }
                }
            }
        }
        
        // Se eliminó la regla estricta de disponibilidad para permitir que el Prompt Principal converse libremente.
        } catch (err) {
            console.error("Error en AI Router", err);
        }

        // --- GLOBAL KNOWLEDGE BASE ---
        let globalKnowledgeBlock = '';
        try {
            const knowledgeItems = await getDb().collection('knowledge').find({}).toArray();
            if (knowledgeItems && knowledgeItems.length > 0) {
                globalKnowledgeBlock = '\n\n📚 BASE DE CONOCIMIENTOS OFICIAL (REGLAS Y DATOS GLOBALES OBLIGATORIOS):\n';
                for (const item of knowledgeItems) {
                    globalKnowledgeBlock += `\n[${item.title}]:\n${item.content}\n---\n`;
                }
                globalKnowledgeBlock += 'USA ESTA BASE DE CONOCIMIENTOS COMO VERDAD ABSOLUTA para responder.\n';
            }
        } catch (err) {
            console.error("Error fetching knowledge base", err);
        }

        const systemWithRefs = MINERD_SYSTEM_PROMPT + referencesBlock + globalKnowledgeBlock;

        const messages = [
            { role: 'system', content: systemWithRefs },
            ...history.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: message }
        ];

        const openaiKey = process.env.OPENAI_API_KEY;
        const googleKey = process.env.GOOGLE_AI_KEY;

        async function tryOpenAI() {
            let reply = null;
            if (!openaiKey || openaiKey.includes('your_')) return null;

            // Determinar si es trabajo de especialista
            const isSpecialistWork = selectedPrompt && defaultPrompt && selectedPrompt._id.toString() !== defaultPrompt._id.toString();
            // Determinar si hay formato activo
            const pendingFmtId = req.session.pendingFormatId || req.body.pendingFormatId;
            const isDocConfirmation = /^(s[íi]|si|ok|dale|listo|genéralo|hazlo|adelante|perfecto|claro|mándamelo|envíamelo|si por favor|ya|bueno|sí quiero|quiero|generar)/i.test(message.trim());
            const shouldWork = isSpecialistWork && (hasFormat || pendingFmtId || isDocConfirmation || message.length > 50);

            try {
                if (shouldWork) {
                    // --- FLUJO MULTI-AGENTE (Web) ---
                    
                    // 1. Especialista
                    const specRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                    });
                    
                    let specReply = '';
                    if (specRes.ok) {
                        const d = await specRes.json();
                        if (d.usage) await logApiUsage(userId, 'Web: Especialista', 'gpt-4o-mini', d.usage);
                        specReply = d?.choices?.[0]?.message?.content?.trim() || '';
                    }

                    // Generación Forzada
                    const shouldForceGen = hasFormat && pendingFmtId && !specReply.includes('[GENERATE_WORD]');
                    if (shouldForceGen) {
                        const fmtDoc2 = await getDb().collection('doc_formats').findOne({ _id: new mongoose.Types.ObjectId(pendingFmtId) });
                        if (fmtDoc2) {
                            const convoContext = history.map(m => (m.role === 'user' ? 'Profesor' : 'Asistente') + ': ' + m.content).join('\n') + '\nProfesor: ' + message;
                            const forcedPrompt = `Eres un experto generador de planificaciones.\nTAREA: Genera un JSON completo para Word.\n${fmtDoc2.instructions || ''}\nCONVERSACIÓN:\n${convoContext}\nResponde ÚNICAMENTE con el bloque [GENERATE_WORD] seguido del JSON.`;
                            
                            const fr2 = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                                body: JSON.stringify({ model: 'gpt-4o', max_tokens: 4000, temperature: 0.3, messages: [{ role: 'user', content: forcedPrompt }] })
                            });
                            if (fr2.ok) {
                                const fd2 = await fr2.json();
                                if (fd2.usage) await logApiUsage(userId, 'Web: Gen Forzada', 'gpt-4o', fd2.usage);
                                const forcedReply = fd2?.choices?.[0]?.message?.content?.trim();
                                if (forcedReply && forcedReply.includes('[GENERATE_WORD]')) specReply = forcedReply;
                            }
                        }
                    }

                    // 2. Supervisor IA
                    let supervisedReply = await callSupervisor(userId, systemWithRefs, message, specReply);

                    // 3. Planixa Principal (Entrega Web)
                    const principalSystemPrompt = defaultPrompt.content + `\n\nERES LA SECRETARIA. Un Especialista generó este trabajo:\n---\n${supervisedReply}\n---\nEntrégaselo al profesor amable y profesionalmente en la interfaz web. \nREGLA DE ORO: DEBES incluir EXACTAMENTE el mismo bloque [GENERATE_WORD] o [GENERATE_PDF] con su estructura intacta al final de tu mensaje.`;

                    const prinRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 4000, temperature: 0.5, messages: [{ role: 'system', content: principalSystemPrompt }] })
                    });
                    
                    if (prinRes.ok) {
                        const d = await prinRes.json();
                        if (d.usage) await logApiUsage(userId, 'Web: Principal Delivery', 'gpt-4o-mini', d.usage);
                        reply = d?.choices?.[0]?.message?.content?.trim() || supervisedReply;
                    } else {
                        reply = supervisedReply;
                    }

                } else {
                    // --- FLUJO NORMAL (Planixa Principal) ---
                    const r = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                    });
                    if (r.ok) {
                        const d = await r.json();
                        if (d.usage) await logApiUsage(userId, 'Web: Mensaje Principal', 'gpt-4o-mini', d.usage);
                        reply = d?.choices?.[0]?.message?.content?.trim();
                    }
                    reply = await callSupervisor(userId, systemWithRefs, message, reply);
                }
            } catch (e) {
                console.error("OpenAI Error:", e);
            }
            
            return reply;
        }

        async function tryGemini() {
            if (!googleKey) return null;
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ systemInstruction: { parts: [{ text: systemWithRefs }] }, contents: [{ role: 'user', parts: [{ text: message }] }], generationConfig: { maxOutputTokens: 2000, temperature: 0.3 } })
            });
            if (!r.ok) return null;
            const d = await r.json();
            return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
        }

        const user = userDoc;
        
        // --- LIMIT CHECK ---
        const limits = { 'trial': 5, '1_week': 10, '1_month': 60, '3_months': 180, '6_months': 360, '1_year': 720, 'lifetime': 999999 };
        const maxPlans = limits[user.plan] || 5;
        const currentCount = user.plans_count || 0;
        
        if (user.plan !== 'lifetime' && !user.is_admin) {
            const now = new Date();
            const expires = user.plan_expires ? new Date(user.plan_expires) : null;
            if (!expires || expires < now) {
                return res.json({ response: `⚠️ Tu membresía ha expirado.\nPara seguir creando planificaciones, por favor renueva tu plan desde el soporte técnico.` });
            }
            if (currentCount >= maxPlans) {
                return res.json({ response: `⚠️ Has alcanzado el límite de ${maxPlans} planificaciones en tu plan actual.\nPor favor renueva tu plan para continuar trabajando.` });
            }
        }

        let text = await tryOpenAI();
        if (!text) text = await tryGemini();
        
        if (text) {
            text = text.replace(/\[?SOLICITAR_AL_PROMPT_PRINCIPAL\]?:?\s*/gi, '');

            const profileMatch = text.match(/\[UPDATE_PROFILE:\s*(\{.*?\})\s*\]/i);
            if (profileMatch) {
                try {
                    const profileUpdates = JSON.parse(profileMatch[1]);
                    const cleanUpdates = {};
                    if (profileUpdates.name) cleanUpdates.name = profileUpdates.name;
                    if (profileUpdates.grade) cleanUpdates.grade = profileUpdates.grade;
                    if (profileUpdates.area) cleanUpdates.area = profileUpdates.area;
                    if (profileUpdates.school) cleanUpdates.school = profileUpdates.school;
                    if (Object.keys(cleanUpdates).length > 0) {
                        await getDb().collection('users').updateOne({ _id: userDoc._id }, { $set: cleanUpdates });
                    }
                    text = text.replace(/\[UPDATE_PROFILE:\s*\{.*?\}\s*\]/i, '').trim();
                } catch(e) {
                    console.error("Error parsing UPDATE_PROFILE", e);
                }
            }

            const memMatch = text.match(/\[MEMORIA:\s*(.+?)\]/i);
            if (memMatch) {
                const newPref = memMatch[1].trim();
                text = text.replace(/\[MEMORIA:\s*.+?\]/i, '').trim();
                const currentPrefs = userDoc.preferences ? userDoc.preferences + '\n- ' + newPref : '- ' + newPref;
                await getDb().collection('users').updateOne({ _id: userDoc._id }, { $set: { preferences: currentPrefs } });
            }

            if (text.includes('[GENERATE_WORD]')) {
                try {
                    let jsonData = {};
                    const jsonMatch = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
                    if (jsonMatch) {
                        jsonData = JSON.parse(jsonMatch[1]);
                    }

                    if (req.pendingFormatId) {
                        const formatDoc = await getDb().collection('doc_formats').findOne({ _id: new mongoose.Types.ObjectId(req.pendingFormatId) });
                        if (formatDoc && formatDoc.filePath) {
                            const templatePath = path.join(__dirname, '../..', 'public', formatDoc.filePath);
                            const outDir = path.join(__dirname, '../..', 'public', 'downloads');
                            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
                            
                            const outFilename = `Documento-${user._id}-${Date.now()}.docx`;
                            const outPath = path.join(outDir, outFilename);
                            const outUrl = `/public/downloads/${outFilename}`;
                            
                            const content = fs.readFileSync(templatePath, 'binary');
                            const zip = new PizZip(content);
                            const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
                            
                            doc.render(jsonData);
                            
                            const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
                            fs.writeFileSync(outPath, buf);

                            text = `Aquí tienes tu documento estructurado en Word, profe 📄✨:\n\n<a href="${outUrl}" target="_blank" download="${outFilename}" style="color:var(--primary); font-weight:bold; text-decoration:underline;">📥 Descargar Documento Word</a>`;
                        } else {
                            text = "Hubo un error localizando la plantilla original.";
                        }
                    } else {
                        text = "Hubo un problema encontrando el formato de plantilla.";
                    }
                } catch(e) {
                    console.error("Error generating word on web: ", e);
                    text = "Ocurrió un error rellenando el documento Word.";
                }
            }

            // Increment plans_count if the response is substantial or contains generation tags
            if ((text.includes('[GENERATE_WORD]') || text.length > 500) && user.plan !== 'lifetime' && !user.is_admin) {
                await getDb().collection('users').updateOne({ _id: user._id }, { $inc: { plans_count: 1 } });
            }
            return res.json({ response: text });
        }

        res.json({ response: '⚠️ No pude conectar con los servicios de IA. Intenta de nuevo.' });
    });
};
