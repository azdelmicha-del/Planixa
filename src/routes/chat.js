const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');



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

        let config = await getDb().collection('settings').findOne({ _id: 'global' });
        const MINERD_SYSTEM_PROMPT = config?.system_prompt || `Eres "Planixa", asistente de planificación docente del MINERD. Responde en español dominicano.`;

        const systemWithRefs = MINERD_SYSTEM_PROMPT + profileBlock + referencesBlock;

        const messages = [
            { role: 'system', content: systemWithRefs },
            ...history.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: message }
        ];

        const openaiKey = process.env.OPENAI_API_KEY;
        const googleKey = process.env.GOOGLE_AI_KEY;

        async function tryOpenAI() {
            if (!openaiKey || openaiKey.includes('your_')) return null;
            const r = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 2000, temperature: 0.3, messages })
            });
            if (!r.ok) return null;
            const d = await r.json();
            return d?.choices?.[0]?.message?.content?.trim() || null;
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
            // Increment plans_count if the response is substantial (likely a planification)
            if (text.length > 300 && user.plan !== 'lifetime' && !user.is_admin) {
                await getDb().collection('users').updateOne({ _id: user._id }, { $inc: { plans_count: 1 } });
            }
            return res.json({ response: text });
        }

        res.json({ response: '⚠️ No pude conectar con los servicios de IA. Intenta de nuevo.' });
    });
};
