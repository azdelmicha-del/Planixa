const express = require('express');
const { getDb } = require('../db');
const { authenticateToken, isAdmin } = require('../middleware/auth');

module.exports = function(app) {
    const router = express.Router();

    // ==========================================
    // ADMIN: Obtener Configuración de Pagos
    // ==========================================
    router.get('/settings', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ success: false, message: 'Solo admin' });
        try {
            const db = getDb();
            const settings = await db.collection('settings').findOne({ type: 'payment_gateways' });
            res.json({ success: true, data: settings || {} });
        } catch (err) {
            console.error('Error fetching payment settings:', err);
            res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
    });

    // ==========================================
    // ADMIN: Guardar Configuración de Pagos
    // ==========================================
    router.post('/settings', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ success: false, message: 'Solo admin' });
        try {
            const db = getDb();
            const { paypal, azul, carnet, bank } = req.body;
            
            await db.collection('settings').updateOne(
                { type: 'payment_gateways' },
                { $set: { paypal, azul, carnet, bank, updated_at: new Date() } },
                { upsert: true }
            );
            res.json({ success: true, message: 'Configuración guardada exitosamente' });
        } catch (err) {
            console.error('Error saving payment settings:', err);
            res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
    });

    // ==========================================
    // CLIENTE: Obtener Planes y Métodos Activos
    // ==========================================
    router.get('/public', authenticateToken, async (req, res) => {
        try {
            const db = getDb();
            const settings = await db.collection('settings').findOne({ type: 'payment_gateways' });
            
            // Retornar solo lo que el cliente necesita ver (ej. clientId de PayPal, datos bancarios)
            // NUNCA retornar secretos de servidor (Client Secret)
            const publicData = {
                paypal_client_id: settings?.paypal?.client_id || '',
                bank_info: settings?.bank?.info || '',
                azul_active: !!settings?.azul?.merchant_id,
                carnet_active: !!settings?.carnet?.merchant_id
            };

            const plans = [
                { id: 'semanal', name: 'Plan Semanal', price: 150, currency: 'DOP', desc: '10 Planificaciones' },
                { id: 'mensual', name: 'Plan Mensual', price: 395, currency: 'DOP', desc: '60 Planificaciones' },
                { id: 'trial', name: 'Plan Trial', price: 0, currency: 'DOP', desc: '3 Planificaciones (3 Días)' },
                { id: 'excento', name: 'Plan Exento', price: 0, currency: 'DOP', desc: 'Acceso Especial' }
            ];

            res.json({ success: true, gateways: publicData, plans });
        } catch (err) {
            console.error('Error fetching public payment info:', err);
            res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
    });

    // ==========================================
    // CLIENTE: Registrar Pago de Transferencia
    // ==========================================
    router.post('/transfer', authenticateToken, async (req, res) => {
        try {
            const db = getDb();
            const { plan_id, amount, reference } = req.body;
            
            if (!plan_id || !reference) return res.status(400).json({ success: false, message: 'Faltan datos' });

            await db.collection('manual_payments').insertOne({
                userId: req.user.id,
                phone: req.user.phone,
                plan_id,
                amount,
                reference,
                status: 'pending',
                created_at: new Date()
            });

            res.json({ success: true, message: 'Pago registrado. Esperando aprobación del administrador.' });
        } catch (err) {
            console.error('Error registering manual payment:', err);
            res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
    });

    // ==========================================
    // ADMIN: Obtener Transferencias Pendientes
    // ==========================================
    router.get('/transfers', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ success: false, message: 'Solo admin' });
        try {
            const db = getDb();
            const pending = await db.collection('manual_payments').find({ status: 'pending' }).sort({ created_at: -1 }).toArray();
            res.json({ success: true, data: pending });
        } catch (err) {
            res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
    });

    // ==========================================
    // ADMIN: Aprobar/Rechazar Transferencia
    // ==========================================
    router.post('/transfers/action', authenticateToken, async (req, res) => {
        if (!(await isAdmin(req.userId))) return res.status(403).json({ success: false, message: 'Solo admin' });
        try {
            const db = getDb();
            const { payment_id, action } = req.body; // action: 'approve', 'reject'
            const { ObjectId } = require('mongodb');

            const payment = await db.collection('manual_payments').findOne({ _id: new ObjectId(payment_id) });
            if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado' });

            if (action === 'reject') {
                await db.collection('manual_payments').updateOne({ _id: new ObjectId(payment_id) }, { $set: { status: 'rejected', updated_at: new Date() } });
                return res.json({ success: true, message: 'Pago rechazado' });
            }

            if (action === 'approve') {
                // Actualizar usuario basado en el plan
                let limits = { plans_count: 0 };
                const now = new Date();
                
                if (payment.plan_id === 'semanal') {
                    limits.plan = 'semanal';
                    limits.plan_expires = new Date(now.setDate(now.getDate() + 7));
                    limits.plans_count = 10;
                } else if (payment.plan_id === 'mensual') {
                    limits.plan = 'mensual';
                    limits.plan_expires = new Date(now.setMonth(now.getMonth() + 1));
                    limits.plans_count = 60;
                } else if (payment.plan_id === 'excento') {
                    limits.plan = 'excento';
                    limits.plan_expires = new Date(now.setFullYear(now.getFullYear() + 10)); // 10 years
                    limits.plans_count = 999999;
                }

                await db.collection('users').updateOne(
                    { _id: new ObjectId(payment.userId) },
                    { $set: limits }
                );

                await db.collection('manual_payments').updateOne(
                    { _id: new ObjectId(payment_id) },
                    { $set: { status: 'approved', updated_at: new Date() } }
                );

                return res.json({ success: true, message: 'Pago aprobado y plan asignado' });
            }

            res.status(400).json({ success: false, message: 'Acción no válida' });
        } catch (err) {
            console.error('Error in transfer action:', err);
            res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
    });

    app.use('/api/payments', router);
};
