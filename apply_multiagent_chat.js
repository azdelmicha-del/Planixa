const fs = require('fs');
const path = require('path');

const targetFile = path.resolve('d:\\$______________________Planixa Asistente\\Planixa Asistente v.2\\src\\routes\\chat.js');
let content = fs.readFileSync(targetFile, 'utf8');

const startMarker = `        const openaiKey = process.env.OPENAI_API_KEY;`;
const endMarker = `        const user = userDoc;`;

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error("No se encontraron los marcadores en chat.js");
    process.exit(1);
}

const newLogic = `        const openaiKey = process.env.OPENAI_API_KEY;
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
                        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${openaiKey}\` },
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
                            const convoContext = history.map(m => (m.role === 'user' ? 'Profesor' : 'Asistente') + ': ' + m.content).join('\\n') + '\\nProfesor: ' + message;
                            const forcedPrompt = \`Eres un experto generador de planificaciones.\\nTAREA: Genera un JSON completo para Word.\\n\${fmtDoc2.instructions || ''}\\nCONVERSACIÓN:\\n\${convoContext}\\nResponde ÚNICAMENTE con el bloque [GENERATE_WORD] seguido del JSON.\`;
                            
                            const fr2 = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${openaiKey}\` },
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
                    const principalSystemPrompt = defaultPrompt.content + \`\\n\\nERES LA SECRETARIA. Un Especialista generó este trabajo:\\n---\\n\${supervisedReply}\\n---\\nEntrégaselo al profesor amable y profesionalmente en la interfaz web. \\nREGLA DE ORO: DEBES incluir EXACTAMENTE el mismo bloque [GENERATE_WORD] o [GENERATE_PDF] con su estructura intacta al final de tu mensaje.\`;

                    const prinRes = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${openaiKey}\` },
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
                        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${openaiKey}\` },
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
            const r = await fetch(\`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=\${googleKey}\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ systemInstruction: { parts: [{ text: systemWithRefs }] }, contents: [{ role: 'user', parts: [{ text: message }] }], generationConfig: { maxOutputTokens: 2000, temperature: 0.3 } })
            });
            if (!r.ok) return null;
            const d = await r.json();
            return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
        }

`;

content = content.substring(0, startIndex) + newLogic + content.substring(endIndex);
fs.writeFileSync(targetFile, content, 'utf8');
console.log('Chat.js modificado exitosamente.');
