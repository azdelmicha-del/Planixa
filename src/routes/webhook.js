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
                const result = await getDb().collection('users').insertOne({ phone: from, password: hashed, name: '', grade: '', area: '', school: '', role: 'teacher', is_admin: false, plan: 'trial', plan_expires: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), plans_count: 0, created_at: new Date() });
                userId = result.insertedId.toString();
                user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
                const welcomeReply = '¡Hola, profe! \n\nA partir de hoy voy a ser tu asistente de planificaciones.\n\nPuedo ayudarte a crear unidades, secuencias, planificaciones diarias, rúbricas, listas de cotejo, evaluaciones y actividades.\n\nAntes de empezar, cuéntame:\n📌 ¿Cuál es tu nombre?\n📌 ¿Qué grado y área trabajas normalmente?\n\nAsí puedo guardar tus planificaciones organizadas y adaptadas a ti.';
                await sendWhatsAppMessage(from, welcomeReply);
                return;
            }
            userId = user._id.toString();

            // --- SUSCRIPTION CHECK ---
            const limits = { 'trial': 5, '1_week': 10, '1_month': 60, '3_months': 180, '6_months': 360, '1_year': 720, 'lifetime': 999999 };
            const maxPlans = limits[user.plan] || 5;
            const currentCount = user.plans_count || 0;

            if (user.plan !== 'lifetime' && !user.is_admin) {
                const now = new Date();
                const expires = user.plan_expires ? new Date(user.plan_expires) : null;
                const isTrial = user.plan === 'trial';
                
                let blockReason = null;
                if (!expires || expires < now) blockReason = isTrial ? 'Tu período de prueba de 3 días ha finalizado. 😔' : 'Tu membresía ha expirado. 😔';
                else if (currentCount >= maxPlans) blockReason = isTrial ? `Has alcanzado el límite de ${maxPlans} planificaciones gratuitas. 😔` : `Has alcanzado el límite de ${maxPlans} planificaciones en tu plan. 😔`;

                if (blockReason) {
                    const payMsg = `Hola profe. ${blockReason}\n\nPara seguir ahorrando horas de trabajo con mis planificaciones automáticas, por favor renueva tu plan:\n\n⭐ 1 Sem: $150 DOP (10 planes)\n⭐ 1 Mes: $395 DOP (60 planes)\n⭐ 3 Meses: $1,066 DOP (-10%)\n⭐ 6 Meses: $2,014 DOP (-15%)\n⭐ 1 Año: $3,792 DOP (-20%)\n\n💳 Para pagar mediante transferencia bancaria (Banreservas/Popular) o PayPal, escríbenos a este mismo número para enviarte los datos.\n\nEn cuanto envíes el comprobante activaremos tu cuenta de inmediato. ¡Te espero!`;
                    await sendWhatsAppMessage(from, payMsg);
                    return;
                }
            }

            if (!user.name) {
                await getDb().collection('users').updateOne({ _id: user._id }, { $set: { name: text } });
                const confirmReply = '¡Excelente profe! Ya he guardado tus datos. ¿En qué puedo ayudarte hoy con tu planificación?';
                await sendWhatsAppMessage(from, confirmReply);
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

            let config = await getDb().collection('settings').findOne({ _id: 'global' });
            const MINERD_SYSTEM_PROMPT = config?.system_prompt || `Eres "Planixa", asistente de planificación docente del MINERD. Responde en español dominicano.`;

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

            if (reply.length > 300 && user.plan !== 'lifetime' && !user.is_admin) {
                await getDb().collection('users').updateOne({ _id: user._id }, { $inc: { plans_count: 1 } });
            }

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
