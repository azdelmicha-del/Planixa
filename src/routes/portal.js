const { getDb } = require('../db');
const mongoose = require('mongoose');

module.exports = function(app) {
    
    // Login to portal using WhatsApp phone number
    app.post('/api/portal/login', async (req, res) => {
        try {
            const { phone } = req.body;
            if (!phone) return res.status(400).json({ error: 'Phone number required' });
            
            // Check if user exists with this phone
            const user = await getDb().collection('users').findOne({ phone: phone });
            if (!user) return res.status(404).json({ error: 'User not found' });
            
            res.json({ success: true, phone: user.phone });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get files for a phone number
    app.get('/api/portal/files', async (req, res) => {
        try {
            const phone = req.query.phone;
            if (!phone) return res.status(400).json({ error: 'Phone required' });
            
            const user = await getDb().collection('users').findOne({ phone: phone });
            if (!user) return res.status(404).json({ error: 'User not found' });
            
            // Files are stored inside conversations
            const convs = await getDb().collection('conversations').find({ userId: user._id.toString() }).sort({ createdAt: -1 }).toArray();
            
            const files = [];
            convs.forEach(c => {
                // If a conversation has messages from assistant containing [GENERATE_PDF] or word, we can assume there's a file
                // But realistically, the ID of the conversation is the file ID
                const titleMatch = (c.messages || []).find(m => m.role === 'user');
                const title = c.title || (titleMatch ? titleMatch.content.substring(0, 50) + '...' : 'Planificación Docente');
                
                files.push({
                    id: c._id.toString(),
                    title: title,
                    date: c.createdAt
                });
            });
            
            res.json({ name: user.name || user.phone, files });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Download proxy (since existing /api/export/:id needs auth, we use phone verification here)
    app.get('/api/portal/download', async (req, res) => {
        try {
            const { id, type, phone } = req.query;
            const user = await getDb().collection('users').findOne({ phone: phone });
            if (!user) return res.status(403).json({ error: 'Unauthorized' });
            
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(id) });
            if (!conv || conv.userId !== user._id.toString()) return res.status(404).json({ error: 'Not found' });
            
            // Redirect to standard export route (but that route requires JWT token)
            // A better way is to call the export functions directly or generate a temporary token.
            // For now, since it's a proxy for downloading, we will just instruct the client to use a temporary JWT or fetch directly if we bypass auth for portal.
            // Actually, we can generate a short-lived token for them:
            const jwt = require('jsonwebtoken');
            const token = jwt.sign({ userId: user._id.toString(), role: user.role }, process.env.JWT_SECRET || 'elprofe_secret', { expiresIn: '15m' });
            
            res.redirect(`/api/export/${id}?format=${type}&token=${token}`);
        } catch (err) {
            res.status(500).send('Error');
        }
    });
};
