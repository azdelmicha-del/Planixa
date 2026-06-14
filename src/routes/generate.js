const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const mongoose = require('mongoose');

module.exports = function (app) {

    async function checkLimits(userId) {
        const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
        if (!user) return { allowed: false, error: 'Usuario no encontrado' };
        const limits = { 'trial': 5, '1_week': 10, '1_month': 60, '3_months': 180, '6_months': 360, '1_year': 720, 'lifetime': 999999 };
        const maxPlans = limits[user.plan] || 5;
        const currentCount = user.plans_count || 0;
        if (user.plan !== 'lifetime' && !user.is_admin) {
            const now = new Date();
            const expires = user.plan_expires ? new Date(user.plan_expires) : null;
            if (!expires || expires < now) return { allowed: false, error: 'Tu membresía ha expirado. Por favor renueva tu plan en el soporte técnico.' };
            if (currentCount >= maxPlans) return { allowed: false, error: `Has alcanzado el límite de ${maxPlans} planificaciones en tu plan.` };
        }
        return { allowed: true, user };
    }

    async function incrementCount(user) {
        if (user.plan !== 'lifetime' && !user.is_admin) {
            await getDb().collection('users').updateOne({ _id: user._id }, { $inc: { plans_count: 1 } });
        }
    }

    /* ── GENERATE STRUCTURED PLAN ────────────────────────────────────────── */
    app.post('/api/generate', authenticateToken, async (req, res) => {
        try {
            const type = String(req.body.type || '').trim();
            const params = Object.assign({}, req.body.params || {});

            if (!['unit', 'daily', 'weekly', 'rubric'].includes(type)) {
                return res.status(400).json({ error: 'Tipo inválido. Use: unit, daily, weekly, rubric' });
            }

            const limitCheck = await checkLimits(req.userId);
            if (!limitCheck.allowed) return res.json({ response: '⚠️ ' + limitCheck.error });
            const userDoc = limitCheck.user;

            let profileBlock = '';
            if (userDoc) {
                const parts = [];
                if (userDoc.name) parts.push('Nombre del docente: ' + userDoc.name);
                if (userDoc.grade) parts.push('Grado que trabaja: ' + userDoc.grade);
                if (userDoc.area) parts.push('Área/Materia: ' + userDoc.area);
                if (userDoc.school) parts.push('Centro educativo: ' + userDoc.school);
                if (parts.length > 0) profileBlock = '\n\n📋 DATOS DEL DOCENTE:\n' + parts.join('\n') + '\n';
            }

            const prompts = {
                unit: `Genera una UNIDAD DIDÁCTICA completa alineada al currículo MINERD con esta estructura:
- Nombre de la unidad
- Situación de aprendizaje
- Competencias fundamentales y específicas
- Indicadores de logro
- Contenidos (conceptuales, procedimentales, actitudinales)
- Estrategias de enseñanza y aprendizaje
- Recursos
- Criterios de evaluación
- Evidencias
- Secuencia de clases (número de clases sugerido)
- Adecuaciones curriculares
- Producto final

Datos: ${JSON.stringify(params)}

Entrega la unidad completa en texto plano, bien estructurada y lista para usar.`,

                daily: `Genera una PLANIFICACIÓN DIARIA alineada al currículo MINERD con esta estructura:
- Tema
- Propósito/Competencia del día
- Inicio (activación de conocimientos previos)
- Desarrollo (actividades paso a paso)
- Cierre (reflexión y retroalimentación)
- Recursos
- Evaluación
- Tarea/Actividad complementaria
- Evidencia de aprendizaje
- Observaciones

Datos: ${JSON.stringify(params)}

Entrega la planificación completa en texto plano.`,

                weekly: `Genera una PLANIFICACIÓN SEMANAL (lunes a viernes) alineada al currículo MINERD.
Para cada día incluye: tema del día, propósito, actividades de inicio-desarrollo-cierre, recursos, evaluación y tarea.

Datos: ${JSON.stringify(params)}

Entrega la planificación completa en texto plano con cada día claramente separado.`,

                rubric: `Genera una RÚBRICA DE EVALUACIÓN alineada al currículo MINERD.
Incluye: nombre de la rúbrica, criterios a evaluar (mínimo 4), niveles de desempeño (Excelente, Bueno, Aceptable, En desarrollo), descripción de cada nivel por criterio, y puntuación total.

Datos: ${JSON.stringify(params)}

Entrega la rúbrica completa en formato de tabla textual.`
            };

            const systemPrompt = `Eres "Planixa", asistente de planificación docente del MINERD. Eres un experto en currículo dominicano por competencias. Siempre respondes en español dominicano, con tono cálido y profesional.` + profileBlock;

            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompts[type] }
            ];

            const openaiKey = process.env.OPENAI_API_KEY;

            async function tryOpenAI() {
                if (!openaiKey || openaiKey.includes('your_')) return null;
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                });
                if (!r.ok) return null;
                const d = await r.json();
                return d?.choices?.[0]?.message?.content?.trim() || null;
            }

            let text = await tryOpenAI();
            if (!text) return res.json({ response: '⚠️ No pude conectar con el servicio de IA. Intenta de nuevo.' });

            await incrementCount(userDoc);
            res.json({ response: text, type });
        } catch (err) {
            console.error('Generate error:', err.message);
            res.status(500).json({ error: 'Error generando planificación' });
        }
    });

    /* ── EXAM GENERATOR ─────────────────────────────────────────────────── */
    app.post('/api/generate/exam', authenticateToken, async (req, res) => {
        try {
            const { grade, area, topic, type, numQuestions } = req.body;
            if (!topic) return res.status(400).json({ error: 'Tema requerido' });

            const limitCheck = await checkLimits(req.userId);
            if (!limitCheck.allowed) return res.json({ response: '⚠️ ' + limitCheck.error });
            const userDoc = limitCheck.user;

            const lang = userDoc?.lang || 'es';

            const examTypes = {
                multiple: 'selección múltiple (4 opciones por pregunta)',
                truefalse: 'verdadero y falso',
                completion: 'completar espacios en blanco',
                open: 'preguntas abiertas de desarrollo',
                mixed: 'combinación de selección múltiple, verdadero/falso y desarrollo'
            };

            const prompt = `Genera un examen de ${area || 'la materia'} para ${grade || 'el grado'} sobre "${topic}".
Tipo: ${examTypes[type] || examTypes.mixed}.
Cantidad de preguntas: ${numQuestions || 10}.

Estructura:
- Encabezado: nombre de la escuela, asignatura, grado, fecha, valor total
- Instrucciones claras para cada sección
- Las preguntas numeradas
- Espacio para nombre del estudiante y fecha

Responde en ${lang === 'en' ? 'inglés' : lang === 'ht' ? 'criollo haitiano' : 'español dominicano'}.`;

            const systemPrompt = `Eres un docente experto en crear evaluaciones alineadas al currículo MINERD.`;
            const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }];

            const openaiKey = process.env.OPENAI_API_KEY;
            let text = null;
            if (openaiKey && !openaiKey.includes('your_')) {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                });
                if (r.ok) { const d = await r.json(); text = d?.choices?.[0]?.message?.content?.trim(); }
            }
            if (text) await incrementCount(userDoc);
            res.json({ response: text || '⚠️ No pude generar el examen. Intenta de nuevo.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /* ── PROJECT-BASED LEARNING ────────────────────────────────────────── */
    app.post('/api/generate/project', authenticateToken, async (req, res) => {
        try {
            const { grade, area, topic, duration } = req.body;
            if (!topic) return res.status(400).json({ error: 'Tema requerido' });

            const limitCheck = await checkLimits(req.userId);
            if (!limitCheck.allowed) return res.json({ response: '⚠️ ' + limitCheck.error });
            const userDoc = limitCheck.user;

            const prompt = `Diseña un proyecto de aprendizaje basado en proyectos (ABP) para ${grade || 'el grado'} de ${area || 'la materia'} sobre "${topic}".
Duración: ${duration || '4 semanas'}.

Incluye:
- Nombre del proyecto
- Problema o pregunta generadora
- Competencias a desarrollar
- Producto final
- Etapas del proyecto (semana a semana)
- Actividades por etapa
- Recursos necesarios
- Evaluación del proyecto (rúbrica o criterios)
- Reflexión final

Responde en español dominicano, formato claro y listo para aplicar.`;

            const messages = [{ role: 'system', content: 'Eres un experto en ABP (Aprendizaje Basado en Proyectos) alineado al currículo MINERD.' }, { role: 'user', content: prompt }];
            const openaiKey = process.env.OPENAI_API_KEY;
            let text = null;
            if (openaiKey && !openaiKey.includes('your_')) {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                });
                if (r.ok) { const d = await r.json(); text = d?.choices?.[0]?.message?.content?.trim(); }
            }
            if (text) await incrementCount(userDoc);
            res.json({ response: text || '⚠️ No pude generar el proyecto. Intenta de nuevo.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /* ── ADECUACIÓN CURRICULAR ──────────────────────────────────────────── */
    app.post('/api/generate/adecuacion', authenticateToken, async (req, res) => {
        try {
            const { grade, area, topic, needs } = req.body;
            if (!topic) return res.status(400).json({ error: 'Tema requerido' });

            const limitCheck = await checkLimits(req.userId);
            if (!limitCheck.allowed) return res.json({ response: '⚠️ ' + limitCheck.error });
            const userDoc = limitCheck.user;

            const prompt = `Diseña un plan de adecuación curricular para un estudiante de ${grade || 'el grado'} en ${area || 'la materia'} sobre "${topic}".
Necesidades educativas: ${needs || 'dificultades de aprendizaje generales'}.

Incluye:
- Objetivos adaptados
- Contenidos priorizados
- Estrategias metodológicas diferenciadas
- Recursos y materiales adaptados
- Evaluación diferenciada (criterios e instrumentos)
- Recomendaciones para el docente

Responde en español dominicano.`;

            const messages = [{ role: 'system', content: 'Eres un especialista en adecuación curricular e inclusión educativa del MINERD.' }, { role: 'user', content: prompt }];
            const openaiKey = process.env.OPENAI_API_KEY;
            let text = null;
            if (openaiKey && !openaiKey.includes('your_')) {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                });
                if (r.ok) { const d = await r.json(); text = d?.choices?.[0]?.message?.content?.trim(); }
            }
            if (text) await incrementCount(userDoc);
            res.json({ response: text || '⚠️ No pude generar la adecuación. Intenta de nuevo.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};
