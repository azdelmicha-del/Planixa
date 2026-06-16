const mongoose = require('mongoose');

const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
    const authHeader = String(req.headers.authorization || '').trim();
    const token = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : authHeader || String(req.body?.token || req.query?.token || '').trim();
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    // Bloquear tokens con el formato inseguro antiguo
    if (token.startsWith('plan_token_')) {
        return res.status(401).json({ success: false, message: 'Sesión expirada o inválida. Por favor, inicie sesión nuevamente.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_jwt_key_planif_pro_2026');
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Token inválido o expirado' });
    }
};

async function isAdmin(userId) {
    try {
        const db = require('../db').getDb();
        const user = await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(userId) });
        return !!(user && user.is_admin);
    } catch { return false; }
}

function normalizePhone(v) {
    let p = String(v || '').replace(/\D/g, '');
    if (p.startsWith('1')) p = p.slice(1);
    if (p.length === 10) return '1' + p;
    if (p.length === 11 && p.startsWith('1')) return p;
    return null;
}

module.exports = { authenticateToken, isAdmin, normalizePhone };
