const fs = require('fs');
const path = require('path');

const targetFile = path.resolve('d:\\$______________________Planixa Asistente\\Planixa Asistente v.2\\src\\routes\\webhook.js');
let content = fs.readFileSync(targetFile, 'utf8');

const startMarker = `            let reply = '⚠️ No pude procesar tu solicitud. Intenta de nuevo.';\n            \n            // Lanzar vigilante y llamada IA en PARALELO`;
const endMarker = `            // SANITIZE LEAKED PROMPT DIRECTIVES`;

const startIndex = content.indexOf(startMarker);
const endIndex = content.indexOf(endMarker);

if (startIndex === -1 || endIndex === -1) {
    console.error("No se encontraron los marcadores en webhook.js");
    process.exit(1);
}

const newLogic = `            let reply = '⚠️ No pude procesar tu solicitud. Intenta de nuevo.';
            
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
                        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${process.env.OPENAI_API_KEY}\` },
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
                            const convoContext = historyMessages.map(m => (m.role === 'user' ? 'Profesor' : 'Asistente') + ': ' + m.content).join('\\n') + '\\nProfesor: ' + text;
                            const forcedPrompt = \`Eres un experto generador de planificaciones docentes del MINERD.
TAREA: Genera un JSON completo para rellenar una plantilla Word.
\${fmtDoc2.instructions || ''}
DATOS DEL PROFESOR:
- Nombre: \${user.name || 'No especificado'}
- Grado: \${user.grade || 'No especificado'}
- Área: \${user.area || 'No especificada'}
CONVERSACIÓN:
\${convoContext}
Responde ÚNICAMENTE con el bloque [GENERATE_WORD] seguido del JSON.\`;
                            const fr2 = await fetch('https://api.openai.com/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${process.env.OPENAI_API_KEY}\` },
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
                const principalSystemPrompt = defaultPrompt.content + \`\\n\\nDATOS DEL PROFESOR:\\nNombre: \${user.name || 'Profe'}\\nGrado: \${user.grade || 'No especificado'}\\n\\nERES LA SECRETARIA. Un Especialista ha generado el siguiente trabajo estructural para el profesor:\\n---\\n\${supervisedReply}\\n---\\n\\nTu tarea es entregarle esto al profesor de forma muy amable y profesional. \\nREGLA DE ORO: DEBES incluir EXACTAMENTE el mismo bloque [GENERATE_WORD] con su JSON intacto al final de tu mensaje. NO MODIFIQUES EL JSON, SOLO AGREGA TU SALUDO AL PRINCIPIO. Usa el separador ||| entre tu charla y el documento.\`;

                const prinRes = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${process.env.OPENAI_API_KEY}\` },
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
                        headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${process.env.OPENAI_API_KEY}\` },
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

`;

content = content.substring(0, startIndex) + newLogic + content.substring(endIndex);
fs.writeFileSync(targetFile, content, 'utf8');
console.log('Webhook modificado exitosamente.');
