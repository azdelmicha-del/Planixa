const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

module.exports = function (app) {
    app.get('/api/students', authenticateToken, async (req, res) => {
        try {
            const students = await getDb().collection('students').find({ userId: req.userId }).sort({ name: 1 }).toArray();
            res.json({ students: students.map(s => ({
                id: s._id.toString(), name: s.name, grade: s.grade, section: s.section,
                parentPhone: s.parentPhone, notes: s.notes, attendance: s.attendance || [],
                grades: s.grades || [], createdAt: s.createdAt
            })) });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/students', authenticateToken, async (req, res) => {
        try {
            const doc = {
                userId: req.userId, name: String(req.body.name || '').trim(),
                grade: String(req.body.grade || '').trim(), section: String(req.body.section || '').trim(),
                parentPhone: String(req.body.parentPhone || '').trim(), notes: String(req.body.notes || '').trim(),
                attendance: [], grades: [], createdAt: new Date()
            };
            if (!doc.name) return res.status(400).json({ error: 'Nombre requerido' });
            const r = await getDb().collection('students').insertOne(doc);
            res.json({ success: true, id: r.insertedId.toString() });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/students/:id', authenticateToken, async (req, res) => {
        try {
            const update = {};
            if (req.body.name !== undefined) update.name = String(req.body.name).trim();
            if (req.body.grade !== undefined) update.grade = String(req.body.grade).trim();
            if (req.body.section !== undefined) update.section = String(req.body.section).trim();
            if (req.body.parentPhone !== undefined) update.parentPhone = String(req.body.parentPhone).trim();
            if (req.body.notes !== undefined) update.notes = String(req.body.notes).trim();
            await getDb().collection('students').updateOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId }, { $set: update });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/students/:id', authenticateToken, async (req, res) => {
        try {
            await getDb().collection('students').deleteOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/students/:id/attendance', authenticateToken, async (req, res) => {
        try {
            const record = { date: new Date(), present: req.body.present === true };
            await getDb().collection('students').updateOne(
                { _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId },
                { $push: { attendance: record } }
            );
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/students/:id/grades', authenticateToken, async (req, res) => {
        try {
            const grade = {
                name: String(req.body.name || '').trim(),
                score: parseFloat(req.body.score) || 0,
                maxScore: parseFloat(req.body.maxScore) || 100,
                date: new Date()
            };
            if (!grade.name) return res.status(400).json({ error: 'Nombre de evaluación requerido' });
            await getDb().collection('students').updateOne(
                { _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId },
                { $push: { grades: grade } }
            );
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/students/:id/report', authenticateToken, async (req, res) => {
        try {
            const student = await getDb().collection('students').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!student) return res.status(404).json({ error: 'No encontrado' });

            const attendance = student.attendance || [];
            const grades = student.grades || [];
            const present = attendance.filter(a => a.present).length;
            const attendancePct = attendance.length ? Math.round(present / attendance.length * 100) : 0;

            let avg = 0;
            if (grades.length) {
                const pcts = grades.map(g => (g.score / g.maxScore) * 100);
                avg = Math.round(pcts.reduce((a, b) => a + b, 0) / grades.length);
            }

            res.json({
                id: student._id.toString(), name: student.name, grade: student.grade, section: student.section,
                attendance: { total: attendance.length, present, absent: attendance.length - present, percentage: attendancePct },
                average: avg, grades, parentPhone: student.parentPhone
            });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/students/:id/report-card', authenticateToken, async (req, res) => {
        try {
            const student = await getDb().collection('students').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!student) return res.status(404).json({ error: 'No encontrado' });
            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });

            const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="boletin-${student.name.replace(/\s+/g, '_')}.pdf"`);
            doc.pipe(res);

            doc.rect(50, 40, 512, 70).fillAndStroke('#1a56db', '#1a56db');
            doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('BOLETÍN DE CALIFICACIONES', 50, 50, { align: 'center', width: 512 });
            doc.fontSize(11).text('Ministerio de Educación de República Dominicana', 50, 75, { align: 'center', width: 512 });
            doc.fillColor('#000');
            doc.y = 130;
            doc.fontSize(11).font('Helvetica-Bold').text('Estudiante: ', 50, doc.y, { continued: true }).font('Helvetica').text(student.name);
            doc.fontSize(11).font('Helvetica-Bold').text('Grado: ', 50, doc.y + 15, { continued: true }).font('Helvetica').text(`${student.grade || ''} ${student.section || ''}`);
            if (user?.name) doc.fontSize(11).font('Helvetica-Bold').text('Docente: ', 50, doc.y + 15, { continued: true }).font('Helvetica').text(user.name);
            doc.moveDown(2);
            doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke('#ccc');
            doc.moveDown(1);

            const grades = student.grades || [];
            if (grades.length) {
                doc.fontSize(11).font('Helvetica-Bold').text('Evaluaciones:', 50, doc.y);
                doc.moveDown(0.5);
                grades.forEach(g => {
                    const pct = Math.round((g.score / g.maxScore) * 100);
                    doc.fontSize(10).font('Helvetica').text(`  ${g.name}: ${g.score}/${g.maxScore} (${pct}%)`, 50, doc.y, { width: 480 });
                });
                const avg = Math.round(grades.reduce((a, g) => a + (g.score / g.maxScore * 100), 0) / grades.length);
                doc.moveDown(0.5);
                doc.fontSize(11).font('Helvetica-Bold').fillColor('#059669').text(`Promedio general: ${avg}%`, 50, doc.y);
                doc.fillColor('#000');
            } else {
                doc.fontSize(10).font('Helvetica').text('Sin evaluaciones registradas.', 50, doc.y);
            }
            doc.moveDown(2);
            const att = student.attendance || [];
            const present = att.filter(a => a.present).length;
            doc.fontSize(11).font('Helvetica-Bold').text('Asistencia:', 50, doc.y);
            doc.fontSize(10).font('Helvetica').text(`  Presente: ${present} / ${att.length} (${att.length ? Math.round(present / att.length * 100) : 0}%)`, 50, doc.y);

            doc.y = 700;
            doc.fontSize(8).fillColor('#999').text('Documento generado por Planixa', 50, doc.y, { align: 'center', width: 512 });
            doc.end();
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
};
