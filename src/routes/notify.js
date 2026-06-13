const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const mongoose = require('mongoose');

module.exports = function (app) {
    app.post('/api/notify-parent', authenticateToken, async (req, res) => {
        try {
            const { studentId, message } = req.body;
            const student = await getDb().collection('students').findOne({ _id: new mongoose.Types.ObjectId(studentId), userId: req.userId });
            if (!student) return res.status(404).json({ error: 'No encontrado' });
            if (!student.parentPhone) return res.status(400).json({ error: 'Este estudiante no tiene teléfono de padre registrado' });

            const waToken = process.env.WA_TOKEN;
            const waPhoneId = process.env.WA_PHONE_ID;
            if (waToken && waPhoneId) {
                await fetch(`https://graph.facebook.com/v21.0/${waPhoneId}/messages`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${waToken}` },
                    body: JSON.stringify({ messaging_product: 'whatsapp', to: student.parentPhone, type: 'text', text: { body: `📋 Notificación de Planixa\nEstudiante: ${student.name}\n\n${message || 'Comunicado del docente.'}` } })
                });
                res.json({ success: true, sent: true });
            } else {
                res.json({ success: true, sent: false, message: `Simulado: Mensaje para ${student.parentPhone}: ${message || 'Comunicado del docente.'}` });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
