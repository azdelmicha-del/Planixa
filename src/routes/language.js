const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const mongoose = require('mongoose');

const LANGS = {
    es: { name: 'Español', native: 'Español', chat: 'Eres "Planixa", asistente de planificación docente del MINERD. Respondes en español dominicano, cercano y profesional.' },
    en: { name: 'English', native: 'English', chat: 'You are "Planixa", a lesson planning assistant for the Dominican Ministry of Education (MINERD). Respond in English, warm and professional.' },
    ht: { name: 'Kreyòl', native: 'Kreyòl Ayisyen', chat: 'Ou se "Planixa", yon asistan pou planifikasyon ansèyman Ministè Edikasyon Repiblik Dominikèn (MINERD). Reponn an kreyòl, cho ak pwofesyonèl.' }
};

module.exports = function (app) {

    app.get('/api/lang', (req, res) => { res.json({ languages: LANGS }); });

    app.put('/api/user/lang', authenticateToken, async (req, res) => {
        try {
            const lang = String(req.body.lang || 'es').trim();
            if (!LANGS[lang]) return res.status(400).json({ error: 'Idioma no soportado' });
            await getDb().collection('users').updateOne({ _id: new mongoose.Types.ObjectId(req.userId) }, { $set: { lang } });
            res.json({ success: true, lang });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};
