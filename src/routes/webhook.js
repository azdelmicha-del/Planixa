const { getDb } = require('../db');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

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
            if (!msg || msg.type !== 'text') return;

            const from = msg.from;
            const text = String(msg.text?.body || '').trim();
            if (!text) return;

            console.log('WhatsApp de', from, ':', text);
            await getDb().collection('client_messages').insertOne({ phone: from, message: text, direction: 'incoming', employeeId: null, employeeName: null, createdAt: new Date() });

            let userId;
            let user = await getDb().collection('users').findOne({ phone: from });
            if (!user) {
                const hashed = await bcrypt.hash(from.slice(-6), 12);
                const result = await getDb().collection('users').insertOne({ phone: from, password: hashed, name: '', grade: '', area: '', school: '', role: 'teacher', is_admin: false, plan: 'free', plan_expires: null, created_at: new Date() });
                userId = result.insertedId.toString();
                user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
                const welcomeReply = '¡Hola, profe! \n\nA partir de hoy voy a ser tu asistente de planificaciones.\n\nPuedo ayudarte a crear unidades, secuencias, planificaciones diarias, rúbricas, listas de cotejo, evaluaciones y actividades.\n\nAntes de empezar, cuéntame:\n📌 ¿Cuál es tu nombre?\n📌 ¿Qué grado y área trabajas normalmente?\n\nAsí puedo guardar tus planificaciones organizadas y adaptadas a ti.';
                await sendWhatsAppMessage(from, welcomeReply);
                return;
            }
            userId = user._id.toString();
            if (!user.name) {
                const askReply = '¡Hola de nuevo, profe! \n\nAntes de empezar, dime tu nombre y el grado que normalmente trabajas para guardar tus planificaciones organizadas.';
                await sendWhatsAppMessage(from, askReply);
                return;
            }

            // --- 1. MEMORIA DE WHATSAPP (AMNESIA FIX) ---
            const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
            let activeConv = await getDb().collection('conversations').findOne({
                userId,
                is_whatsapp: true,
                createdAt: { $gte: twelveHoursAgo }
            }, { sort: { createdAt: -1 } });

            const historyMessages = activeConv ? activeConv.messages.map(m => ({ role: m.role, content: m.content })) : [];

            const refDocs = await getDb().collection('references').find({ userId }).toArray();
            let refBlock = '';
            if (refDocs.length > 0) {
                refBlock = '\n\nDOCUMENTOS DE REFERENCIA:\n' + refDocs.map(r => `📄 ${r.name}: ${(r.text||'').slice(0,2000)}`).join('\n---\n');
            }

            const MINERD_SYSTEM_PROMPT = `Eres "Planixa", el asistente conversacional de planificación docente del Ministerio de Educación de República Dominicana (MINERD).

PERSONALIDAD:
- Eres cercano, amable y profesional. Nada robótico.
- Hablas como un compañero docente que ayuda a otro docente.
- Usas "profe" para dirigirte al usuario.
- Siempre respondes en español dominicano.

FUNCIÓN PRINCIPAL:
Ayudas a maestros dominicanos a crear PLANIFICACIONES DOCENTES completas.

REGLAS DE GENERACIÓN DE PDF:
Si el usuario te pide explícitamente "Envíame un PDF", "Hazme un PDF", "Quiero eso en PDF", o "Descargar" sobre la planificación actual, DEBES responder EXACTAMENTE incluyendo esta palabra mágica en tu respuesta: [GENERATE_PDF] y luego añades un mensaje amable indicando que el PDF se está enviando.
Si no pide un PDF explícitamente, responde normalmente.

CONOCIMIENTO CURRICULAR (MINERD):
- Niveles: Inicial, Primario, Secundario
- Enfoque por competencias y ejes transversales
- Estructura formal dominicana: inicio-desarrollo-cierre

FLUJO DE CONVERSACIÓN:
- Identifica qué tipo de documento necesita.
- Recolecta datos de forma natural si faltan (grado, área, tema).
- Entrega la planificación con estructura formal y clara, sin markdown excesivo.`;

            const systemWithRefs = MINERD_SYSTEM_PROMPT + refBlock;
            const messages = [
                { role: 'system', content: systemWithRefs },
                ...historyMessages,
                { role: 'user', content: text }
            ];

            let reply = '⚠️ No pude procesar tu solicitud. Intenta de nuevo.';
            try {
                const r = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
                    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 3000, temperature: 0.3, messages })
                });
                if (r.ok) {
                    const d = await r.json();
                    const t = d?.choices?.[0]?.message?.content?.trim();
                    if (t) reply = t;
                }
            } catch (e) {}

            const now = new Date();
            const newMessages = [
                { role: 'user', content: text, timestamp: now },
                { role: 'assistant', content: reply, timestamp: new Date() }
            ];

            if (activeConv) {
                await getDb().collection('conversations').updateOne(
                    { _id: activeConv._id },
                    { $push: { messages: { $each: newMessages } } }
                );
            } else {
                const insertResult = await getDb().collection('conversations').insertOne({
                    userId,
                    is_whatsapp: true,
                    title: 'WhatsApp: ' + now.toLocaleDateString('es-DO'),
                    messages: newMessages,
                    createdAt: now,
                    pdfGenerated: false
                });
                activeConv = await getDb().collection('conversations').findOne({ _id: insertResult.insertedId });
            }

            await getDb().collection('client_messages').insertOne({ phone: from, message: reply, direction: 'outgoing', employeeId: null, employeeName: 'Bot WhatsApp', createdAt: new Date() });

            // --- 2. ENTREGA DE PDFS POR WHATSAPP ---
            if (reply.includes('[GENERATE_PDF]')) {
                const cleanReply = reply.replace(/\[GENERATE_PDF\]/g, '').trim();
                
                // Generar PDF
                const pdfDir = path.join(PROJECT_ROOT, 'public', 'downloads');
                if (!fs.existsSync(pdfDir)) {
                    fs.mkdirSync(pdfDir, { recursive: true });
                }
                const pdfFilename = `planificacion-${from}-${Date.now()}.pdf`;
                const pdfPath = path.join(pdfDir, pdfFilename);
                const pdfUrl = `https://planixa.onrender.com/downloads/${pdfFilename}`;
                
                await createPdfFromConv(activeConv, user, pdfPath);
                
                // Enviar Mensaje de texto indicando que ahí va el PDF
                await sendWhatsAppMessage(from, cleanReply || "Aquí tienes tu planificación en PDF, profe:");
                
                // Enviar el PDF como documento
                await sendWhatsAppDocument(from, pdfUrl, pdfFilename);
            } else {
                // Mensaje normal, particionado si es muy largo
                const chunks = reply.match(/.{1,4000}/g) || [];
                for (const chunk of chunks) {
                    await sendWhatsAppMessage(from, chunk);
                }
            }

        } catch (err) {
            console.error('WhatsApp webhook error:', err.message);
        }
    });
};

async function sendWhatsAppMessage(to, text) {
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

function createPdfFromConv(conv, user, outputPath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
        const stream = fs.createWriteStream(outputPath);
        doc.pipe(stream);

        const leftMargin = 50;
        const pageWidth = 612;
        const centerX = pageWidth / 2;

        try {
            if (fs.existsSync(path.join(PROJECT_ROOT, 'assets', 'minerd-logo.png'))) {
                doc.image(path.join(PROJECT_ROOT, 'assets', 'minerd-logo.png'), centerX - 30, 20, { width: 60 });
            }
        } catch (e) {}

        doc.fontSize(16).font('Helvetica-Bold').text('Ministerio de Educación de República Dominicana', centerX, 90, { align: 'center' });
        doc.fontSize(12).font('Helvetica').text('Planificación Docente', centerX, 115, { align: 'center' });
        doc.moveDown();

        const dateStr = new Date().toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric' });
        doc.fontSize(9).fillColor('#666').text(`Generado el ${dateStr}`, { align: 'right' });
        doc.fillColor('#000');

        doc.moveDown();
        doc.moveTo(leftMargin, doc.y).lineTo(pageWidth - leftMargin, doc.y).stroke('#ccc');
        doc.moveDown();

        const titleText = conv.title || 'Planificación Docente';
        doc.fontSize(14).font('Helvetica-Bold').text(titleText, leftMargin, doc.y, { underline: true });
        doc.moveDown();

        if (user && user.name) {
            doc.fontSize(10).font('Helvetica').text(`Docente: ${user.name}     Celular: ${user.phone}`);
            doc.moveDown(0.5);
        }

        doc.moveTo(leftMargin, doc.y).lineTo(pageWidth - leftMargin, doc.y).stroke('#ccc');
        doc.moveDown();

        const messages = conv.messages || [];
        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.content.length > 100) {
                if (doc.y > 700) doc.addPage();
                
                let content = String(msg.content || '').replace(/\[GENERATE_PDF\]/g, '');
                
                doc.fontSize(10).font('Helvetica').fillColor('#333');
                const lines = content.split('\n');
                for (const line of lines) {
                    if (doc.y > 720) doc.addPage();
                    if (line.trim().startsWith('-') || line.trim().startsWith('*')) {
                        doc.text(`• ${line.replace(/^[-*]/, '').trim()}`, leftMargin + 10, doc.y);
                    } else if (line.trim().startsWith('#')) {
                        doc.moveDown(0.5);
                        doc.font('Helvetica-Bold').fillColor('#111').text(line.replace(/^#+/, '').trim(), leftMargin, doc.y);
                        doc.font('Helvetica').fillColor('#333');
                    } else {
                        doc.text(line, leftMargin, doc.y);
                    }
                }
                doc.moveDown();
            }
        }

        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}
