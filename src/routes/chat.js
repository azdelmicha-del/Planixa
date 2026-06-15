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
            if (conv) history = conv.messages || [];
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
            let selectedPrompt = null;

            if (prompts.length === 1) {
                selectedPrompt = prompts[0];
            } else if (prompts.length > 1) {
                // --- AI ROUTER ---
                const routerPrompt = `Eres un enrutador inteligente. Tienes los siguientes Especialistas (Prompts) disponibles:
${prompts.map(p => `- ID: ${p._id.toString()} | Nombre: ${p.name} | Cuándo usar: ${p.description}`).join('\n')}

El usuario ha dicho: "${message}"

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
                    if (rData.usage) await logApiUsage(userId, 'Chat: Enrutador IA', 'gpt-4o-mini', rData.usage);
                    const chosenId = rData.choices?.[0]?.message?.content?.trim();
                    selectedPrompt = prompts.find(p => p._id.toString() === chosenId) || prompts[0];
                } else {
                    selectedPrompt = prompts[0];
                }
            }

            if (selectedPrompt) {
                MINERD_SYSTEM_PROMPT = selectedPrompt.content;
            }

            const profileBlock = `\n\nDATOS DEL PROFESOR:\nNombre: ${userDoc.name || 'Profe'}\nGrado: ${userDoc.grade || 'No especificado'}\nÁrea/Materia: ${userDoc.area || 'No especificada'}\nCentro Educativo: ${userDoc.school || 'No especificado'}\nIdioma: ${userDoc.language || 'es'}\nUSA ESTOS DATOS PARA PERSONALIZAR TU RESPUESTA.\n`;
        
            let identityRule = `\n\nREGLA DE IDENTIDAD:\nAntes de enviar o comenzar la creación de CUALQUIER planificación o documento, verifica el "Nombre" en los DATOS DEL PROFESOR. Si el nombre es genérico (ej. "hola", "Profe", "Maestro") o está vacío, DEBES preguntarle cortésmente cuál es su nombre completo antes de generar el documento.`;

            // --- FORMAT INJECTOR ---
            const formats = await getDb().collection('doc_formats').find({}).toArray();
            let hasFormat = false;

            if (formats.length > 0) {
                const formatMatcherPrompt = `Eres un clasificador. Revisa si el mensaje del usuario está pidiendo generar un documento. Formatos disponibles: ${formats.map(f => f.type).join(', ')}. Si pide uno de esos, responde EXACTAMENTE con el tipo. Si no, responde "NINGUNO".
Mensaje: "${message}"`;
                
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
                    if (fData.usage) await logApiUsage(userId, 'Chat: Clasificador Formato', 'gpt-4o-mini', fData.usage);
                    const chosenType = fData.choices?.[0]?.message?.content?.trim();
                    if (chosenType && chosenType !== "NINGUNO") {
                        const matchedFormat = formats.find(f => f.type.toLowerCase() === chosenType.toLowerCase());
                        if (matchedFormat) {
                            hasFormat = true;
                            let tmplIns = `\n\nREGLA ESTRICTA DE FORMATO VISUAL (PLANTILLA WORD):\nEl administrador ha asignado una plantilla Word para este documento.`;
                            if (matchedFormat.instructions) tmplIns += `\nINSTRUCCIONES EXTRA DEL ADMIN: ${matchedFormat.instructions}`;
                            
                            tmplIns += `\n\nREGLA DE APROBACIÓN (MUY IMPORTANTE):
1. Llena los datos que correspondan y preséntalos EN TEXTO NORMAL para que el profesor los lea. 
2. AL FINAL del mensaje, OBLIGATORIAMENTE pregúntale: "¿Quedó todo bien? ¿Deseas que te genere este documento listo en Word?". 
3. NO USES la etiqueta [GENERATE_WORD] en este momento.
4. SÓLO usa [GENERATE_WORD] en tu SIGUIENTE mensaje si el profesor te responde que SÍ lo quiere en documento.

CUANDO EL PROFESOR DE LA APROBACIÓN:
Debes responder EXACTAMENTE con este formato:
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
        const systemWithRefs = MINERD_SYSTEM_PROMPT + profileBlock + identityRule + referencesBlock;

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
            try {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 2000, temperature: 0.3, messages })
                });
                if (r.ok) {
                    const d = await r.json();
                    if (d.usage) await logApiUsage(userId, 'Chat: Mensaje Principal', 'gpt-4o-mini', d.usage);
                    const t = d?.choices?.[0]?.message?.content?.trim();
                    if (t) reply = t;
                }
            } catch (e) {
                console.error("OpenAI Error:", e);
            }
            
            // -- PASO SUPERVISOR IA --
            if (reply) reply = await callSupervisor(userId, systemWithRefs, message, reply);
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
