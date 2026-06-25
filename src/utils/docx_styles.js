const path = require('path');
const fs = require('fs');

function buildProfessionalHtml(markdownHtml) {
    const dateStr = new Date().toLocaleDateString('es-DO', {
        year: 'numeric', month: 'long', day: 'numeric'
    });

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <style>
        @page { size: letter; margin: 2.5cm 2.5cm 2.5cm 2.5cm; }
        body {
            font-family: 'Times New Roman', Times, serif;
            font-size: 12pt; color: #000000; line-height: 1.5;
        }
        .header {
            text-align: center; margin-bottom: 20px;
            border-bottom: 2px solid #003366; padding-bottom: 15px;
        }
        .header h1 {
            font-family: 'Times New Roman', Times, serif;
            font-size: 16pt; color: #003366; margin: 5px 0;
            font-weight: bold; text-transform: uppercase;
        }
        .header h2 {
            font-family: 'Times New Roman', Times, serif;
            font-size: 13pt; color: #003366; margin: 3px 0;
        }
        .header .date {
            font-size: 9pt; color: #666; text-align: right; margin-top: 5px;
        }
        .content { margin-top: 20px; }
        .content h1 {
            font-size: 14pt; color: #003366;
            border-bottom: 1px solid #003366; padding-bottom: 5px; margin-top: 20px;
        }
        .content h2 { font-size: 13pt; color: #003366; margin-top: 15px; }
        .content h3 { font-size: 12pt; color: #333; font-weight: bold; margin-top: 10px; }
        .content table {
            width: 100%; border-collapse: collapse; margin: 15px 0;
        }
        .content table th {
            background-color: #003366; color: #fff;
            padding: 8px 10px; border: 1px solid #003366;
            font-weight: bold; text-align: left;
        }
        .content table td {
            padding: 8px 10px; border: 1px solid #333; vertical-align: top;
        }
        .content table tr:nth-child(even) { background-color: #f5f5f5; }
        .content ul, .content ol { margin: 10px 0; padding-left: 25px; }
        .content li { margin-bottom: 5px; }
        .content p { margin: 8px 0; text-align: justify; }
        .content strong { color: #003366; }
        .footer {
            text-align: center; font-size: 9pt; color: #999;
            border-top: 1px solid #ccc; padding-top: 10px; margin-top: 30px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Ministerio de Educación de República Dominicana</h1>
        <h2>Planificación Docente</h2>
        <div class="date">Generado el ${dateStr}</div>
    </div>
    <div class="content">
        ${markdownHtml}
    </div>
    <div class="footer">
        Documento generado por Planixa Asistente - MINERD
    </div>
</body>
</html>`;
}

module.exports = { buildProfessionalHtml };
