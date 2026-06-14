const mongoose = require('mongoose');
const { authenticateToken, isAdmin } = require('../middleware/auth');
const { getDb } = require('../db');

module.exports = function (app) {
    app.get('/api/admin/users', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const users = await getDb().collection('users').find({}, { projection: { password: 0 } }).sort({ created_at: -1 }).toArray();
            res.json({ users: users.map(u => ({ id: u._id.toString(), phone: u.phone, name: u.name || '', role: u.role, is_admin: !!u.is_admin, plan: u.plan || 'free', plan_expires: u.plan_expires, plans_count: u.plans_count || 0, created_at: u.created_at })) });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/users/:id/role', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const is_admin = req.body.is_admin === true;
            await getDb().collection('users').updateOne({ _id }, { $set: { is_admin, role: is_admin ? 'admin' : 'teacher' } });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/users/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const update = {};
            if (req.body.name !== undefined) update.name = String(req.body.name || '').trim();
            if (req.body.phone !== undefined) update.phone = String(req.body.phone || '').trim();
            if (req.body.plan !== undefined) update.plan = String(req.body.plan);
            if (req.body.plan_expires !== undefined) update.plan_expires = req.body.plan_expires ? new Date(req.body.plan_expires) : null;
            if (req.body.resetCount === true) update.plans_count = 0;
            await getDb().collection('users').updateOne({ _id }, { $set: update });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/admin/users/:id', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const _id = new mongoose.Types.ObjectId(req.params.id);
            const user = await getDb().collection('users').findOne({ _id });
            if (!user) return res.status(404).json({ error: 'No encontrado' });
            if (user.is_admin) return res.status(400).json({ error: 'No puedes eliminar un admin' });
            await getDb().collection('users').deleteOne({ _id });
            await getDb().collection('conversations').deleteMany({ userId: req.params.id });
            await getDb().collection('references').deleteMany({ userId: req.params.id });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/admin/users/:id/chat', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const userId = req.params.id;
            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
            if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
            
            // Get messages directly from client_messages if available, or extract from conversations
            const messages = await getDb().collection('client_messages').find({ phone: user.phone }).sort({ createdAt: 1 }).toArray();
            
            // Also get conversation history from 'conversations' collection if we want the AI context
            const convs = await getDb().collection('conversations').find({ userId }).sort({ createdAt: -1 }).limit(10).toArray();
            
            res.json({ messages, conversations: convs });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/ai', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ error: 'Solo admin' });
        try {
            const { message, context } = req.body;
            const { generateAIResponse } = require('../services/openai');
            const systemPrompt = "Eres el asistente personal experto del Administrador del negocio SaaS 'Planixa'. Ayudas a gestionar ventas, redactar estrategias de marketing, evaluar chats de clientes para mejorar prompts, y dar soporte técnico. Responde de forma brillante, comercial y técnica.";
            
            const messages = [
                { role: 'system', content: systemPrompt },
            ];
            
            if (context) {
                messages.push({ role: 'user', content: `Contexto del cliente actual: ${JSON.stringify(context)}` });
            }
            messages.push({ role: 'user', content: message });
            
            const aiResponse = await generateAIResponse(messages, 'gpt-4o', 1500, 0.7);
            res.json({ response: aiResponse });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
};
