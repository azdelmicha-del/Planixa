const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { authenticateToken, isAdmin, normalizePhone } = require('../middleware/auth');
const { getDb } = require('../db');

module.exports = function (app) {
    app.post('/api/register', async (req, res) => {
        const phone = normalizePhone(req.body.phone);
        const password = String(req.body.password || '');
        const name = String(req.body.name || '').trim();
        if (!phone) return res.status(400).json({ success: false, message: 'Número de celular inválido (809/829/849)' });
        if (password.length < 8) return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 8 caracteres' });
        try {
            const existing = await getDb().collection('users').findOne({ phone });
            if (existing) return res.status(400).json({ success: false, message: 'Este número ya está registrado' });
            const hashed = await bcrypt.hash(password, 12);
            await getDb().collection('users').insertOne({ phone, password: hashed, name, grade: '', area: '', school: '', role: 'teacher', is_admin: false, plan: 'trial', plan_expires: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), plans_count: 0, created_at: new Date() });
            console.log('Nuevo usuario:', phone);
            res.json({ success: true, message: 'Registrado correctamente' });
        } catch (err) {
            console.error('Register error:', err.message);
            res.status(500).json({ success: false, message: 'Error interno' });
        }
    });

    app.post('/api/login', async (req, res) => {
        const phone = normalizePhone(req.body.phone);
        const password = String(req.body.password || '');
        if (!phone) return res.status(400).json({ success: false, message: 'Número inválido' });
        try {
            const user = await getDb().collection('users').findOne({ phone });
            if (!user) return res.status(401).json({ success: false, message: 'Número no registrado' });
            const match = await bcrypt.compare(password, user.password);
            if (!match) return res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
            
            const token = jwt.sign(
                { userId: user._id.toString(), role: user.role },
                process.env.JWT_SECRET || 'super_secret_jwt_key_planif_pro_2026',
                { expiresIn: '30d' }
            );

            res.json({
                success: true,
                token: token,
                user: { id: user._id.toString(), phone: user.phone, name: user.name || '' }
            });
        } catch (err) {
            console.error('Login error:', err.message);
            res.status(500).json({ success: false, message: 'Error interno' });
        }
    });
};
