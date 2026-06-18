const { getDb } = require('../db');

/**
 * Llama al Supervisor IA si se dan las condiciones.
 * @param {string} userId - ID del usuario.
 * @param {string} systemPrompt - Prompt del sistema usado.
 * @param {string} userRequest - Último mensaje del usuario.
 * @param {string} draftResponse - Borrador generado por el asistente.
 * @returns {Promise<string>} - Respuesta corregida o la original si está aprobada.
 */
async function callSupervisor(userId, systemPrompt, userRequest, draftResponse) {
    try {
        const db = getDb();
        const settings = await db.collection('settings').findOne({ _id: 'general' });
        
        // Por defecto apagado para ahorrar costos, el admin debe activarlo
        if (settings?.supervisor_enabled !== true) {
            return { text: draftResponse, status: 'off' };
        }
        
        // Evaluar solo respuestas largas
        if (draftResponse.length < 400 && !draftResponse.includes('[GENERATE_')) {
            return { text: draftResponse, status: 'bypassed_length' };
        }

        const supervisorPrompt = `Eres un SUPERVISOR DE CALIDAD estricto. Tu tarea es revisar el borrador de respuesta que un Asistente IA ha generado para un profesor.

PROMPT DEL SISTEMA ORIGINAL:
${systemPrompt}

PETICIÓN DEL USUARIO:
${userRequest}

BORRADOR GENERADO:
${draftResponse}

INSTRUCCIONES DE SUPERVISIÓN:
1. Revisa si el borrador cumple con las directrices (MINERD, formato solicitado, responde directamente a la petición).
2. Asegúrate de que no haya información alucinada, y si se requiere el uso de separadores como |||, que estén bien aplicados.
3. Si el borrador es excelente y cumple todo, responde ÚNICAMENTE con la palabra: APROBADO
4. Si el borrador tiene errores, o es deficiente, NO des explicaciones. Reescribe la respuesta completa y correcta tú mismo de la manera en la que el Asistente debió responder. Tu respuesta reemplazará a la del asistente.
5. REGLA DE SISTEMA INQUEBRANTABLE: Si el borrador original incluye etiquetas internas como [GENERATE_WORD], [GENERATE_PDF] o [MEMORIA: ...], así como cualquier bloque \`\`\`json ... \`\`\`, es OBLIGATORIO que incluyas exactamente esas etiquetas y el JSON intacto en tu reescritura. Si las omites, el servidor fallará y no se generará el documento.`;

        let finalSupervisorPrompt = supervisorPrompt;
        if (settings.supervisor_rules) {
            finalSupervisorPrompt += `\n\nREGLAS ADICIONALES DEL ADMINISTRADOR:\n${settings.supervisor_rules}`;
        }

        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({ 
                model: 'gpt-4o-mini', 
                messages: [{ role: 'system', content: finalSupervisorPrompt }],
                max_tokens: 3000, 
                temperature: 0.1 
            })
        });

        if (r.ok) {
            const d = await r.json();
            const evaluation = d?.choices?.[0]?.message?.content?.trim();
            
            if (evaluation && evaluation.toUpperCase() !== 'APROBADO' && !evaluation.toUpperCase().includes('APROBADO')) {
                const cleaned = evaluation;
                // Registrar la corrección
                await db.collection('supervisor_logs').insertOne({
                    userId: userId,
                    userRequest: userRequest,
                    draftResponse: draftResponse,
                    correctedResponse: cleaned,
                    date: new Date()
                });
                return { text: cleaned, status: 'corrected' };
            }
        }
        
        return { text: draftResponse, status: 'approved' };
    } catch (err) {
        console.error("Supervisor IA Error:", err);
        return { text: draftResponse, status: 'error' };
    }
}

module.exports = { callSupervisor };
