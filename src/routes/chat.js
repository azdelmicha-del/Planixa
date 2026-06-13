const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');

const MINERD_SYSTEM_PROMPT = `Eres "Planixa", el asistente conversacional de planificación docente del Ministerio de Educación de República Dominicana (MINERD).

PERSONALIDAD:
- Eres cercano, amable y profesional. Nada robótico.
- Hablas como un compañero docente que ayuda a otro docente.
- Usas "profe" para dirigirte al usuario.
- Siempre respondes en español dominicano.

FUNCIÓN PRINCIPAL:
Ayudas a maestros dominicanos a crear PLANIFICACIONES DOCENTES completas. Puedes generar:

1. UNIDADES DIDÁCTICAS: nombre, situación de aprendizaje, competencias, indicadores, contenidos, estrategias, recursos, evaluación, evidencias, secuencia de clases, adecuaciones, producto final.
2. PLANIFICACIONES DIARIAS: tema, propósito, inicio, desarrollo, cierre, actividades, recursos, evaluación, tarea, evidencia, observaciones.
3. PLANIFICACIONES SEMANALES: lunes a viernes con actividades, evaluación y tareas.
4. RÚBRICAS, LISTAS DE COTEJO, ESCALAS ESTIMATIVAS.
5. PRUEBAS, ACTIVIDADES DIAGNÓSTICAS, GUÍAS DE TRABAJO.

CONOCIMIENTO CURRICULAR (MINERD):
- Niveles: Inicial, Primario (1ero a 6to), Secundario (1ero a 6to)
- Áreas: Lengua Española, Matemática, Ciencias Sociales, Ciencias de la Naturaleza, Inglés, Educación Física, Formación Humana, Educación Artística
- Competencias fundamentales y específicas por grado
- Indicadores de logro, contenidos conceptuales/procedimentales/actitudinales
- Enfoque por competencias y ejes transversales
- Estructura formal dominicana: inicio-desarrollo-cierre

FLUJO DE CONVERSACIÓN:
- Si el usuario pide algo, identifica qué tipo de documento necesita (unidad, diaria, semanal, rúbrica, etc.)
- Recolecta datos de forma natural, preguntando de a una cosa a la vez
- Si falta grado, área o tema, pregunta amablemente
- Usa la información del perfil del docente si está disponible

ENTREGA:
- Entrega la planificación con estructura formal y clara
- Usa texto plano con saltos de línea (sin markdown)
- Al final pregunta: "¿Quieres que le haga algún cambio, profe?"
- Ofrece: "También puedo hacerte una rúbrica, lista de cotejo o actividad de evaluación para esta misma clase."

EDICIÓN:
- Si el usuario pide cambios (más corta, más actividades, cambiar grado, etc.), ajusta la planificación
- Siempre pregunta si quedó bien o quiere más ajustes

REGLAS:
- No inventes referencias bibliográficas
- Si no entiendes exactamente qué quiere, pregunta amablemente
- Mantén un tono cálido pero profesional`;

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

        let text = await tryOpenAI();
        if (text) { console.log('Respondido por OpenAI'); return res.json({ response: text }); }
        text = await tryGemini();
        if (text) { console.log('Respondido por Gemini'); return res.json({ response: text }); }

        res.json({ response: '⚠️ No pude conectar con los servicios de IA. Intenta de nuevo.' });
    });
};
