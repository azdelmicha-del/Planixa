const { authenticateToken } = require('../middleware/auth');
const { getDb } = require('../db');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

module.exports = function (app) {

    /* ── TXT ────────────────────────────────────────────────────────────── */
    app.get('/api/conversations/:id/txt', authenticateToken, async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });
            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });
            let txt = `=== Planixa - Planificación Docente MINERD ===\n`;
            txt += `Título: ${conv.title || 'Sin título'}\n`;
            txt += `Docente: ${user?.name || 'Desconocido'} (${user?.phone || ''})\n`;
            txt += `Generado: ${new Date().toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}\n\n`;
            txt += `───────────────────────────────────────────────\n\n`;
            const msgs = conv.messages || [];
            for (const m of msgs) {
                const label = m.role === 'user' ? 'DOCENTE' : 'PLANIFIA';
                txt += `[${label}]\n${m.content}\n\n---\n\n`;
            }
            txt += `───────────────────────────────────────────────\n`;
            txt += `Fin de la planificación.\n`;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            const safeName = (user?.name || 'docente').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
            res.setHeader('Content-Disposition', `attachment; filename="planificacion-${safeName}-${conv._id.toString().slice(-6)}.txt"`);
            res.send(txt);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /* ── PDF ────────────────────────────────────────────────────────────── */
    app.get('/api/conversations/:id/pdf', authenticateToken, async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });

            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });

            const safeName = (user?.name || 'docente').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
            const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="planificacion-${safeName}-${conv._id.toString().slice(-6)}.pdf"`);
            doc.pipe(res);

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
                const label = msg.role === 'user' ? 'Docente' : 'PlanifIA';
                const color = msg.role === 'user' ? '#1a56db' : '#059669';

                if (doc.y > 700) doc.addPage();

                doc.fontSize(10).font('Helvetica-Bold').fillColor(color).text(`${label}:`);
                doc.fontSize(9).font('Helvetica').fillColor('#333');

                const content = String(msg.content || '');
                const lines = content.split('\n');
                for (const line of lines) {
                    if (doc.y > 730) doc.addPage();
                    doc.text(line.length > 0 ? line : ' ', leftMargin + 10, doc.y, { width: pageWidth - leftMargin - 60 });
                }
                doc.fillColor('#000');
                doc.moveDown(0.3);
                doc.moveTo(leftMargin, doc.y).lineTo(pageWidth - leftMargin, doc.y).stroke('#eee');
                doc.moveDown(0.3);
            }

            doc.moveDown(2);
            doc.fontSize(8).fillColor('#999').text('Documento generado por Planixa - Sistema de Planificación Docente MINERD', { align: 'center' });
            doc.text('Los datos contenidos en este documento son responsabilidad del docente.', { align: 'center' });

            doc.end();

            await getDb().collection('conversations').updateOne(
                { _id: new mongoose.Types.ObjectId(req.params.id) },
                { $set: { pdfGenerated: true } }
            );
        } catch (err) {
            console.error('PDF error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Error generando PDF' });
        }
    });

    /* ── ENHANCED PDF ────────────────────────────────────────────────────── */
    app.get('/api/conversations/:id/pdf-enhanced', authenticateToken, async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });

            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });
            const safeName = (user?.name || 'docente').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
            const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="planificacion-${safeName}-${conv._id.toString().slice(-6)}.pdf"`);
            doc.pipe(res);

            const leftM = 50, pageW = 612;
            let pageNum = 1;

            doc.on('pageAdded', () => {
                pageNum++;
                doc.fontSize(7).fillColor('#999').text(`Planixa - ${conv.title || 'Planificación'}`, leftM, 10);
                doc.text(`Pág. ${pageNum}`, pageW - leftM - 50, 10, { align: 'right' });
                doc.moveTo(leftM, 20).lineTo(pageW - leftM, 20).stroke('#ddd');
            });
            doc.fontSize(7).fillColor('#999').text(`Planixa - ${conv.title || 'Planificación'}`, leftM, 10);
            doc.text(`Pág. ${pageNum}`, pageW - leftM - 50, 10, { align: 'right' });
            doc.moveTo(leftM, 20).lineTo(pageW - leftM, 20).stroke('#ddd');

            doc.y = 35;

            doc.rect(leftM - 10, doc.y, pageW - leftM * 2 + 20, 80).fillAndStroke('#1a56db', '#1a56db');
            doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('Ministerio de Educación RD', leftM, doc.y + 12, { align: 'center', width: pageW - leftM * 2 });
            doc.fontSize(13).text('Planificación Docente - Planixa', leftM, doc.y + 38, { align: 'center', width: pageW - leftM * 2 });
            doc.fillColor('#000');
            doc.y += 95;

            const dateStr = new Date().toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric' });
            doc.fontSize(9).fillColor('#555');
            doc.text(`Título: ${conv.title || 'Planificación Docente'}`, leftM, doc.y);
            doc.text(`Generado: ${dateStr}`, leftM, doc.y + 12);
            if (user?.name) doc.text(`Docente: ${user.name} (${user.phone})`, leftM, doc.y + 24);
            doc.fillColor('#000');
            doc.y += 40;
            doc.moveTo(leftM, doc.y).lineTo(pageW - leftM, doc.y).stroke('#ccc');
            doc.y += 10;

            const msgs = conv.messages || [];
            for (const msg of msgs) {
                if (doc.y > 700) doc.addPage();
                const label = msg.role === 'user' ? 'Docente' : 'PlanifIA';
                const color = msg.role === 'user' ? '#1a56db' : '#059669';
                doc.fontSize(11).font('Helvetica-Bold').fillColor(color).text(label + ':', leftM, doc.y);
                doc.fontSize(9).font('Helvetica').fillColor('#333');
                const lines = String(msg.content || '').split('\n');
                for (const line of lines) {
                    if (doc.y > 730) doc.addPage();
                    doc.text(line.length > 0 ? line : ' ', leftM + 10, doc.y, { width: pageW - leftM - 60 });
                }
                doc.fillColor('#000');
                doc.moveDown(0.5);
            }

            doc.y = 740;
            doc.moveTo(leftM, doc.y).lineTo(pageW - leftM, doc.y).stroke('#ccc');
            doc.fontSize(7).fillColor('#999').text('Documento generado por Planixa - Sistema de Planificación Docente MINERD', leftM, doc.y + 4, { align: 'center', width: pageW - leftM * 2 });

            doc.end();
        } catch (err) {
            console.error('Enhanced PDF error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Error generando PDF' });
        }
    });

    /* ── DOCX ────────────────────────────────────────────────────────────── */
    app.get('/api/conversations/:id/docx', authenticateToken, async (req, res) => {
        try {
            const conv = await getDb().collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(req.params.id), userId: req.userId });
            if (!conv) return res.status(404).json({ error: 'No encontrada' });

            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });

            const sections = [];

            sections.push(
                new Paragraph({ children: [new TextRun({ text: 'Ministerio de Educación de República Dominicana', bold: true, size: 28 })], alignment: AlignmentType.CENTER }),
                new Paragraph({ children: [new TextRun({ text: 'Planificación Docente', size: 24 })], alignment: AlignmentType.CENTER }),
                new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: `Generado el ${new Date().toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric' })}`, size: 18, italics: true, color: '666666' })] }),
                new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: conv.title || 'Planificación Docente', bold: true, size: 26 })] }),
            );

            if (user && user.name) {
                sections.push(
                    new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: `Docente: ${user.name}     Celular: ${user.phone}`, size: 20 })] })
                );
            }

            sections.push(new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } } }));

            const messages = conv.messages || [];
            for (const msg of messages) {
                const label = msg.role === 'user' ? 'Docente' : 'PlanifIA';
                const color = msg.role === 'user' ? '1A56DB' : '059669';
                sections.push(new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: `${label}:`, bold: true, size: 20, color })] }));

                const content = String(msg.content || '');
                const lines = content.split('\n');
                for (const line of lines) {
                    sections.push(new Paragraph({
                        spacing: { after: 60 },
                        indent: { left: 200 },
                        children: [new TextRun({ text: line || ' ', size: 18, color: '333333' })]
                    }));
                }
                sections.push(new Paragraph({ spacing: { after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'EEEEEE' } } }));
            }

            sections.push(
                new Paragraph({ spacing: { before: 400 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Documento generado por Planixa - Sistema de Planificación Docente MINERD', size: 16, color: '999999' })] }),
                new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Los datos contenidos en este documento son responsabilidad del docente.', size: 16, color: '999999' })] })
            );

            const doc = new Document({ sections: [{ properties: {}, children: sections }] });
            const buffer = await Packer.toBuffer(doc);

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            const safeName = (user?.name || 'docente').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
            res.setHeader('Content-Disposition', `attachment; filename="planificacion-${safeName}-${conv._id.toString().slice(-6)}.docx"`);
            res.send(buffer);
        } catch (err) {
            console.error('DOCX error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Error generando Word' });
        }
    });

    /* ── EXPORT ZIP ──────────────────────────────────────────────────────── */
    app.get('/api/export/zip', authenticateToken, async (req, res) => {
        try {
            const convs = await getDb().collection('conversations').find({ userId: req.userId }).sort({ createdAt: -1 }).toArray();
            const user = await getDb().collection('users').findOne({ _id: new mongoose.Types.ObjectId(req.userId) });

            res.setHeader('Content-Type', 'application/zip');
            const safeName = (user?.name || 'docente').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
            res.setHeader('Content-Disposition', `attachment; filename="planificaciones-${safeName}-${new Date().toISOString().slice(0, 10)}.zip"`);

            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(res);

            for (const conv of convs) {
                const safeTitle = (conv.title || 'planificacion').replace(/[<>:"/\\|?*]/g, '_').slice(0, 40);
                const dateStr = conv.createdAt ? new Date(conv.createdAt).toISOString().slice(0, 10) : '0000-00-00';
                let txt = `Título: ${conv.title || 'Sin título'}\n`;
                txt += `Fecha: ${dateStr}\n\n`;
                txt += `========================================\n\n`;
                for (const m of conv.messages || []) {
                    const label = m.role === 'user' ? 'DOCENTE' : 'PLANIFIA';
                    txt += `[${label}]\n${m.content}\n\n---\n\n`;
                }
                archive.append(txt, { name: `${dateStr}_${safeTitle}.txt` });
            }

            archive.append(JSON.stringify(convs.map(c => ({ id: c._id.toString(), title: c.title, createdAt: c.createdAt })), null, 2), { name: 'indice.json' });
            archive.finalize();
        } catch (err) {
            console.error('ZIP error:', err.message);
            if (!res.headersSent) res.status(500).json({ error: 'Error generando ZIP' });
        }
    });

    /* ── EXPORT EXCEL ───────────────────────────────────────────────────── */
    app.get('/api/export/students/xlsx', authenticateToken, async (req, res) => {
        try {
            const ExcelJS = require('exceljs');
            const students = await getDb().collection('students').find({ userId: req.userId }).sort({ name: 1 }).toArray();
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Estudiantes');
            ws.columns = [
                { header: 'Nombre', key: 'name', width: 25 },
                { header: 'Grado', key: 'grade', width: 15 },
                { header: 'Asistencias', key: 'attendance', width: 12 },
                { header: 'Presente', key: 'present', width: 10 },
                { header: 'Ausente', key: 'absent', width: 10 },
                { header: '% Asistencia', key: 'pct', width: 13 },
                { header: 'Promedio', key: 'avg', width: 10 },
            ];
            students.forEach(s => {
                const att = s.attendance || [];
                const present = att.filter(a => a.present).length;
                const grades = s.grades || [];
                const avg = grades.length ? Math.round(grades.reduce((a, g) => a + (g.score / g.maxScore * 100), 0) / grades.length) : 0;
                ws.addRow({ name: s.name, grade: s.grade || '', attendance: att.length, present, absent: att.length - present, pct: att.length ? Math.round(present / att.length * 100) + '%' : '-', avg: avg || '-' });
            });
            ws.getRow(1).font = { bold: true };
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="estudiantes-${new Date().toISOString().slice(0, 10)}.xlsx"`);
            await wb.xlsx.write(res);
            res.end();
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

};
