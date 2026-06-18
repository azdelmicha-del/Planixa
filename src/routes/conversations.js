const mongoose = require('mongoose');
const crypto = require('crypto');
const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');

module.exports = function (app) {
    app.get('/api/conversations', authenticateToken, async (req, res) => {
        try {
            const userId = req.userId;
            const conversations = await getDb().collection('conversations')
                .find({ userId }, { projection: { userId: 0 } })
                .sort({ createdAt: -1 })
                .toArray();
            res.json({ conversations: conversations.map(c => ({
                id: c._id.toString(),
                title: c.title || 'Planificación',
                messageCount: (c.messages || []).length,
                createdAt: c.createdAt,
                hasPdf: !!c.pdfGenerated
            })) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/conversations', authenticateToken, async (req, res) => {
        try {
            const userId = req.userId;
            const title = String(req.body.title || 'Nueva planificación').trim().slice(0, 100);
            const msg = req.body.message || null;
            const reply = req.body.reply || null;

            const doc = {
                userId,
                title,
                messages: [],
                createdAt: new Date(),
                pdfGenerated: false
            };
            if (msg) doc.messages.push({ role: 'user', content: msg, timestamp: new Date() });
            if (reply) doc.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
            const result = await getDb().collection('conversations').insertOne(doc);
            res.json({ success: true, id: result.insertedId.toString() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/conversations/:id', authenticateToken, async (req, res) => {
        try {
            const title = String(req.body.title || '').trim().slice(0, 100);
            if (!title) return res.status(400).json({ error: 'Título requerido' });
            await getDb().collection('conversations').updateOne(
                { _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId },
                { $set: { title } }
            );
            res.json({ success: true, title });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/conversations/:id/messages/:msgIndex', authenticateToken, async (req, res) => {
        try {
            const convId = new mongoose.Types.ObjectId(req.params.id);
            const msgIndex = parseInt(req.params.msgIndex, 10);
            const newContent = String(req.body.content || '').trim();
            if (!newContent) return res.status(400).json({ error: 'Contenido requerido' });

            const conv = await getDb().collection('conversations').findOne({ _id: convId, userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });
            if (!conv.messages || msgIndex < 0 || msgIndex >= conv.messages.length) {
                return res.status(400).json({ error: 'Índice inválido' });
            }

            const msgs = conv.messages;
            msgs[msgIndex].content = newContent;
            msgs[msgIndex].edited = true;
            const trimmed = msgs.slice(0, msgIndex + 1);

            await getDb().collection('conversations').updateOne(
                { _id: convId },
                { $set: { messages: trimmed } }
            );

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
        try {
            const userId = req.userId;
            const convId = new mongoose.Types.ObjectId(req.params.id);
            const msg = String(req.body.message || '').trim();
            const reply = String(req.body.reply || '').trim();
            if (!msg && !reply) return res.status(400).json({ error: 'Sin datos' });

            const update = {};
            if (msg) update.$push = { messages: { role: 'user', content: msg, timestamp: new Date() } };
            if (reply) update.$push = { messages: { role: 'assistant', content: reply, timestamp: new Date() } };

            const result = await getDb().collection('conversations').updateOne({ _id: convId, userId }, update);

            if (result.matchedCount === 0) {
                // La conversación fue borrada (ej. por el admin), recrearla dinámicamente
                const doc = {
                    _id: convId,
                    userId,
                    title: req.body.title || 'Planificación restaurada',
                    messages: [],
                    createdAt: new Date(),
                    pdfGenerated: false
                };
                if (msg) doc.messages.push({ role: 'user', content: msg, timestamp: new Date() });
                if (reply) doc.messages.push({ role: 'assistant', content: reply, timestamp: new Date() });
                await getDb().collection('conversations').insertOne(doc);
            } else if (req.body.title) {
                await getDb().collection('conversations').updateOne({ _id: convId, userId }, { $set: { title: String(req.body.title).trim().slice(0, 100) } });
            }

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/conversations/:id', authenticateToken, async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });
            res.json({
                id: conv._id.toString(),
                title: conv.title,
                messages: conv.messages || [],
                createdAt: conv.createdAt,
                hasPdf: !!conv.pdfGenerated
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/conversations/:id', authenticateToken, async (req, res) => {
        try {
            await getDb().collection('conversations').deleteOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/conversations/calendar', authenticateToken, async (req, res) => {
        try {
            const year = parseInt(req.query.year) || new Date().getFullYear();
            const month = parseInt(req.query.month) || new Date().getMonth() + 1;
            const start = new Date(year, month - 1, 1);
            const end = new Date(year, month, 0, 23, 59, 59);

            const convs = await getDb().collection('conversations').find({
                userId: req.userId,
                createdAt: { $gte: start, $lte: end }
            }, { projection: { title: 1, createdAt: 1 } }).sort({ createdAt: 1 }).toArray();

            const days = {};
            for (const c of convs) {
                const date = c.createdAt instanceof Date ? c.createdAt : new Date(c.createdAt);
                if (isNaN(date.getTime())) continue;
                const d = date.getDate();
                if (!days[d]) days[d] = [];
                days[d].push({ id: c._id.toString(), title: c.title || 'Sin título' });
            }

            res.json({ year, month, days });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/conversations/:id/share', authenticateToken, async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });

            let shareToken = conv.shareToken;
            if (!shareToken) {
                shareToken = crypto.randomBytes(12).toString('hex');
                await getDb().collection('conversations').updateOne(
                    { _id: new mongoose.Types.ObjectId(req.params.id) },
                    { $set: { shareToken, sharedAt: new Date() } }
                );
            }
            res.json({ success: true, url: `/api/shared/${shareToken}` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/conversations/:id/share', authenticateToken, async (req, res) => {
        try {
            await getDb().collection('conversations').updateOne(
                { _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId },
                { $unset: { shareToken: '', sharedAt: '' } }
            );
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/shared/:token', async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ shareToken: req.params.token });
            if (!conv) return res.status(404).json({ error: 'No encontrada o enlace expirado' });

            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(conv.userId) });

            res.json({
                title: conv.title || 'Planificación Docente',
                teacher: user ? user.name || 'Docente' : 'Docente',
                messages: conv.messages || [],
                createdAt: conv.createdAt
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/conversations/:id/version', authenticateToken, async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });
            await getDb().collection('versions').insertOne({ conversationId: req.params.id, userId: req.userId, messages: conv.messages || [], title: conv.title, savedAt: new Date() });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/conversations/:id/versions', authenticateToken, async (req, res) => {
        try {
            const versions = await getDb().collection('versions').find({ conversationId: req.params.id, userId: req.userId }).sort({ savedAt: -1 }).limit(20).toArray();
            res.json({ versions: versions.map(v => ({ id: v._id.toString(), title: v.title, savedAt: v.savedAt, msgCount: (v.messages || []).length })) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/versions/:id', authenticateToken, async (req, res) => {
        try {
            const v = await getDb().collection('versions').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!v) return res.status(404).json({ error: 'No encontrada' });
            res.json({ id: v._id.toString(), title: v.title, messages: v.messages || [], savedAt: v.savedAt });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
