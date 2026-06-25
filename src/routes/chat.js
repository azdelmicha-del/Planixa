const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const { logApiUsage } = require('../finance');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { callSupervisor } = require('../utils/supervisor');
const { createDocxFromHtml } = require('../utils/google_docs');
const { buildProfessionalHtml } = require('../utils/docx_styles');

async function generateDocx(markdown, userId) {
    const { marked } = require('marked');
    const outDir = path.join(__dirname, '../..', 'public', 'downloads');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outFilename = `Documento-${userId}-${Date.now()}.docx`;
    const outPath = path.join(outDir, outFilename);
    const outUrl = `/public/downloads/${outFilename}`;

    const htmlContent = marked.parse(markdown);
    const professionalHtml = buildProfessionalHtml(htmlContent);

    const buffer = await createDocxFromHtml(professionalHtml, outFilename.replace('.docx', ''));
    fs.writeFileSync(outPath, buffer);
    return { url: outUrl, path: outPath };
}

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
            if (userDoc.preferences) parts.push('\n💡 RECORDATORIOS/GUSTOS DEL DOCENTE:\n' + userDoc.preferences);
            
            if (parts.length > 0) profileBlock = '\n\n📋 DATOS DEL DOCENTE:\n' + parts.join('\n') + '\n\nUSA ESTOS DATOS para personalizar tus respuestas y planificaciones. No preguntes de nuevo por datos que ya tienes aquí.\n';
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
        
        let defaultPrompt = null;
        let selectedPrompt = null;
        let hasFormat = false;

        try {
            // Fetch prompts
            const prompts = await getDb().collection('prompts').find({}).toArray();
            const formats = await getDb().collection('doc_formats').find({}).toArray();
            
        // Buscar explícitamente "Planixa Principal" como el por defecto (soporta guión bajo y espacios)
        defaultPrompt = prompts.find(p => p.name && p.name.replace(/_/g, ' ').trim().toLowerCase() === 'planixa principal') || (prompts.length > 0 ? prompts[0] : null);
        selectedPrompt = defaultPrompt;

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
            let content = selectedPrompt.content;

            // Limpiar instrucciones obsoletas de plantillas .docx y validación de plantillas
            content = content
                // Eliminar secciones enteras de "PLANTILLAS QUE PUEDES USAR" hasta el final o hasta otro encabezado
                .replace(/PLANTILLAS QUE PUEDES USAR[\s\S]*?(?=\n---|\n[A-Z][A-Z]|\n$|$)/gi, '')
                // Eliminar referencias a ESTADO/PLANTILLA_INCORRECTA y lógica de validación
                .replace(/"ESTADO"\s*:.*?PLANTILLA_INCORRECTA.*?(?=\n|\})/gi, '')
                // Eliminar frases de selección/validación de plantillas
                .replace(/seleccionar la plantilla correcta[^.]*\./gi, '')
                .replace(/seleccionar la plantilla correspondiente[^.]*\./gi, '')
                .replace(/validar.*?plantilla[^.]*\./gi, '')
                .replace(/verificar.*?plantilla[^.]*\./gi, '')
                // Eliminar listas de nombres de plantillas .docx
                .replace(/Plantilla_\w+\.docx/g, '')
                .replace(/Plantilla_\w+/g, '')
                // Eliminar referencias a rellenar plantillas
                .replace(/rellenar la plantilla correspondiente[^.]*\./gi, 'generar el contenido estructurado.')
                .replace(/rellenar la plantilla[^.]*\./gi, 'generar el contenido.')
                // Reemplazar "documento Word .docx" con "contenido Markdown"
                .replace(/documento Word \.docx/g, 'contenido en formato Markdown')
                .replace(/documento Word/g, 'contenido Markdown')
                // Reemplazar instrucciones de devolver .docx
                .replace(/devolver a PLANIXA_principal un documento[^.]*\./gi, 'generar el contenido y devolverlo a PLANIXA_principal.')
                // Eliminar la instrucción de plantilla incorrecta
                .replace(/\{[\s]*"ESTADO"[\s]*:[\s]*"PLANTILLA_INCORRECTA"[\s]*\}/gi, '')
                .replace(/ESTADO.*?PLANTILLA_INCORRECTA.*?\n/gi, '')
                // Eliminar cualquier JSON de error de plantilla
                .replace(/\{[^}]*"ESTADO"[^}]*"PLANTILLA_INCORRECTA"[^}]*\}/gi, '');

            MINERD_SYSTEM_PROMPT = content;
        }

        // Inject Profile
        MINERD_SYSTEM_PROMPT += profileBlock;
        MINERD_SYSTEM_PROMPT += `\n\n=== REGLA: VIGILANTE RECOLECTOR (PERFIL) ===\nSi el profesor menciona su nombre, grado, área escolar o centro educativo en la conversación, DEBES incluir esta etiqueta oculta al final de tu respuesta: [UPDATE_PROFILE: {"name":"...", "grade":"...", "area":"...", "school":"..."}]. Si menciona un gusto o preferencia de cómo le gustan las cosas, usa [MEMORIA: ...].`;

        let activeFormatId = null;

        if (fRes && fRes.ok) {
            const fData = await fRes.json();
            if (fData.usage) await logApiUsage(userId, 'Web: Clasificador Formato', 'gpt-4o-mini', fData.usage);
            const chosenType = fData.choices?.[0]?.message?.content?.trim();
            if (chosenType && chosenType !== "NINGUNO") {
                const matchedFormat = formats.find(f => f.type.toLowerCase() === chosenType.toLowerCase());
                if (matchedFormat) {
                    activeFormatId = matchedFormat._id.toString();
                    req.pendingFormatId = activeFormatId;
                    if (conversationId) {
                        await getDb().collection('conversations').updateOne(
                            { _id: new mongoose.Types.ObjectId(conversationId) },
                            { $set: { pendingFormatId: activeFormatId } }
                        );
                    }
                }
            }
        }

        if (!activeFormatId && req.pendingFormatId) {
            activeFormatId = req.pendingFormatId;
        }

        if (activeFormatId) {
            const matchedFormat = formats.find(f => f._id.toString() === activeFormatId.toString());
            if (matchedFormat) {
                hasFormat = true;
                let tmplIns = `\n\nINSTRUCCIONES DE GENERACIÓN DE DOCUMENTO:\nEl profesor ha solicitado un documento.`;
                
                tmplIns += `\n\nREGLAS DE GENERACIÓN (MUY IMPORTANTE):
1. NO entregues la planificación completa en texto plano en el chat. Mantén respuestas conversacionales y breves.
2. Si faltan datos, haz preguntas para obtenerlos.
3. Una vez tengas todos los datos listos, pregunta: "¿Deseas que genere tu documento en Word ahora?".
4. SÓLO cuando el profesor confirme, responde con tu planificación COMPLETA en formato Markdown bien estructurado.
5. La planificación debe incluir: encabezados (##), tablas si aplica, listas, negritas, etc.
6. Al final de tu respuesta agrega la etiqueta: [GENERATE_DOCX]

EJEMPLO DE FORMATO:
[GENERATE_DOCX]
## Planificación Diaria
**Docente:** [Nombre]
**Grado:** [Grado]

| Inicio | Desarrollo | Cierre |
|--------|------------|--------|
| ... | ... | ... |

- Punto importante 1
- Punto importante 2

REGLA: El documento se genera automáticamente desde tu Markdown. Mientras más estructurado, mejor se verá el Word.`;
                MINERD_SYSTEM_PROMPT += tmplIns;
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
                if (globalKnowledgeBlock.length > 150000) {
                    globalKnowledgeBlock = globalKnowledgeBlock.substring(0, 150000) + '\n...[CONTENIDO RECORTADO POR LÍMITE DE MEMORIA DEL SISTEMA]';
                }
                globalKnowledgeBlock += 'USA ESTA BASE DE CONOCIMIENTOS COMO FUENTE PRINCIPAL DE VERDAD. SI UN DATO ESTÁ AQUÍ, ES OFICIAL DEL MINERD.\n';
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

        async function tryOpenAI() {
            let reply = null;
            if (!openaiKey || openaiKey.includes('your_')) return null;

            const isSpecialistWork = selectedPrompt && defaultPrompt && selectedPrompt._id.toString() !== defaultPrompt._id.toString();
            const isDocConfirmation = /^(s[íi]|si|ok|dale|listo|genéralo|hazlo|adelante|perfecto|claro|mándamelo|envíamelo|si por favor|ya|bueno|sí quiero|quiero|generar)/i.test(message.trim());
            const shouldWork = isSpecialistWork && (hasFormat || isDocConfirmation || message.length > 50);

            try {
                if (shouldWork) {
                    // --- NUEVO FLUJO: router → especialista → docx → supervisor → principal ---
                    
                    const specModel = selectedPrompt.model || 'gpt-4o-mini';
                    
                    // 1. Especialista genera contenido en Markdown
                    req.app.emit('system_log', { type: 'ESPECIALISTA', color: '#f59e0b', title: 'Delegando al Back-Office', details: `Procesando en web con ${specModel}...` });
                    const specRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({ model: specModel, max_tokens: 3000, temperature: 0.3, messages })
                    });
                    
                    let specReply = '';
                    if (specRes.ok) {
                        const d = await specRes.json();
                        if (d.usage) await logApiUsage(userId, 'Web: Especialista', specModel, d.usage);
                        specReply = d?.choices?.[0]?.message?.content?.trim() || '';
                    }
                    
                    if (!specReply) return null;

                    // 2. Generar DOCX profesional (obligatorio: Google Docs API)
                    let docxUrl = null;
                    const shouldGenDocx = specReply.includes('[GENERATE_DOCX]') || specReply.includes('[GENERATE_WORD]') || specReply.length > 500;
                    
                    if (shouldGenDocx) {
                        let markdownData = specReply
                            .replace(/\[GENERATE_DOCX\]/g, '')
                            .replace(/\[GENERATE_WORD\]/g, '')
                            .replace(/\[GENERATE_PDF\]/g, '')
                            .trim();
                        
                        if (markdownData.length > 50) {
                            try {
                                const result = await generateDocx(markdownData, userId);
                                docxUrl = result.url;
                            } catch (docxErr) {
                                console.error("Error generando DOCX profesional:", docxErr);
                                reply = '⚠️ No se pudo generar el documento profesional. Verifica que Google Cloud Drive tenga espacio disponible.';
                                return reply;
                            }
                        }
                    }

                    // Limpiar etiquetas del contenido para supervisor/principal
                    const cleanContent = specReply
                        .replace(/\[GENERATE_DOCX\]/g, '')
                        .replace(/\[GENERATE_WORD\]/g, '')
                        .replace(/\[GENERATE_PDF\]/g, '')
                        .trim();

                    // 3. Supervisor IA
                    req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#10b981', title: 'Supervisando Generación', details: 'Supervisor IA verificando el contenido...' });
                    let supervisedReply = (await callSupervisor(userId, systemWithRefs, message, cleanContent)).text;

                    // 4. Planixa Principal (Entrega Web con link de descarga)
                    const prinModel = defaultPrompt.model || 'gpt-4o-mini';
                    let principalSystemPrompt = defaultPrompt.content + `\n\nERES LA SECRETARIA. Un Especialista generó este trabajo:\n---\n${supervisedReply}\n---\nEntrégaselo al profesor amable y profesionalmente en la interfaz web.`;
                    
                    if (docxUrl) {
                        principalSystemPrompt += `\n\nIMPORTANTE: El documento Word ya fue generado automáticamente. Incluye este enlace de descarga visible al final de tu mensaje:\n<a href="${docxUrl}" target="_blank" style="display:inline-block; padding:10px 15px; background:var(--primary); color:white; border-radius:5px; text-decoration:none; font-weight:bold;">📥 Descargar Documento Word</a>`;
                    }
                    
                    const prinRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({ model: prinModel, max_tokens: 4000, temperature: 0.5, messages: [{ role: 'system', content: principalSystemPrompt }] })
                    });
                    
                    if (prinRes.ok) {
                        const d = await prinRes.json();
                        if (d.usage) await logApiUsage(userId, 'Web: Principal Delivery', prinModel, d.usage);
                        reply = d?.choices?.[0]?.message?.content?.trim() || supervisedReply;
                        if (docxUrl && !reply.includes(docxUrl)) {
                            reply += `\n\n<a href="${docxUrl}" target="_blank" style="display:inline-block; padding:10px 15px; background:var(--primary); color:white; border-radius:5px; text-decoration:none; font-weight:bold;">📥 Descargar Documento Word</a>`;
                        }
                    } else {
                        reply = supervisedReply;
                        if (docxUrl) {
                            reply += `\n\n<a href="${docxUrl}" target="_blank" style="display:inline-block; padding:10px 15px; background:var(--primary); color:white; border-radius:5px; text-decoration:none; font-weight:bold;">📥 Descargar Documento Word</a>`;
                        }
                    }

                } else {
                    // --- FLUJO NORMAL (Planixa Principal) ---
                    const normModel = defaultPrompt.model || 'gpt-4o-mini';
                    req.app.emit('system_log', { type: 'PLANIXA ASISTENTE', color: '#8b5cf6', title: 'Consultando Asistente', details: `Procesando flujo normal con ${normModel}...` });
                    const r = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                        body: JSON.stringify({ model: normModel, max_tokens: 3000, temperature: 0.3, messages })
                    });
                    if (r.ok) {
                        const d = await r.json();
                        if (d.usage) await logApiUsage(userId, 'Web: Mensaje Principal', normModel, d.usage);
                        reply = d?.choices?.[0]?.message?.content?.trim();
                    }
                    reply = (await callSupervisor(userId, systemWithRefs, message, reply)).text;
                }
            } catch (e) {
                console.error("OpenAI Error:", e);
            }
            
            return reply;
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
        
        if (text) {
            text = text.replace(/\[?SOLICITAR_AL_PROMPT_PRINCIPAL\]?:?\s*/gi, '');

            const profileMatch = text.match(/\[UPDATE_PROFILE:\s*(\{[\s\S]*?\})\s*\]/i);
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
                    text = text.replace(/\[UPDATE_PROFILE:\s*\{[\s\S]*?\}\s*\]/i, '').trim();
                } catch(e) {
                    console.error("Error parsing UPDATE_PROFILE", e);
                }
            }

            const memMatch = text.match(/\[MEMORIA:\s*([\s\S]+?)\]/i);
            if (memMatch) {
                const newPref = memMatch[1].trim();
                text = text.replace(/\[MEMORIA:\s*[\s\S]+?\]/i, '').trim();
                const currentPrefs = userDoc.preferences ? userDoc.preferences + '\n- ' + newPref : '- ' + newPref;
                await getDb().collection('users').updateOne({ _id: userDoc._id }, { $set: { preferences: currentPrefs } });
            }

            // Generación de DOCX profesional (obligatorio: Google Docs API)
            const hasGenTag = text.includes('[GENERATE_WORD]') || text.includes('[GENERATE_DOCX]');
            if (hasGenTag) {
                let markdownData = text.replace(/\[GENERATE_DOCX\]/g, '').replace(/\[GENERATE_WORD\]/g, '').trim();
                if (markdownData.length > 50) {
                    try {
                        const result = await generateDocx(markdownData, user._id);
                        text = `Aquí tienes tu documento profesional en Word, profe 📄✨:\n\n<a href="${result.url}" target="_blank" download="${path.basename(result.path)}" style="display:inline-block; margin-top:10px; padding:10px 15px; background:var(--primary); color:white; border-radius:5px; text-decoration:none; font-weight:bold;">📥 Descargar Documento Word</a>`;
                    } catch(e) {
                        console.error("Error generando DOCX profesional:", e);
                        text = "⚠️ No se pudo generar el documento profesional. Verifica que Google Cloud Drive tenga espacio disponible y que el archivo google-credentials.json sea válido.";
                    }
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
