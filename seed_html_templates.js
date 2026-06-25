require('dotenv').config();
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('Error: MONGODB_URI no está definido en .env');
    process.exit(1);
}

function generateHtmlTemplate(formatType) {
    const isUnidad = /unidad|unidad/i.test(formatType);
    const title = isUnidad ? 'Planificación de Unidad de Aprendizaje' : 'Planificación Diaria';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 2.5cm 2cm; }
  body {
    font-family: 'Times New Roman', Times, serif;
    font-size: 12pt;
    color: #1a1a1a;
    line-height: 1.6;
  }
  .header {
    text-align: center;
    margin-bottom: 25px;
    padding-bottom: 15px;
    border-bottom: 3px solid #003366;
  }
  .header .logo-text {
    font-size: 16pt;
    font-weight: bold;
    color: #003366;
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 1pt;
  }
  .header .subtitle {
    font-size: 11pt;
    color: #003366;
    margin: 5px 0 0 0;
  }
  .header .doc-title {
    font-size: 14pt;
    font-weight: bold;
    color: #003366;
    margin: 15px 0 0 0;
    text-transform: uppercase;
    border-top: 1px solid #003366;
    padding-top: 10px;
  }
  .content {
    margin-top: 20px;
  }
  .footer {
    text-align: center;
    border-top: 1px solid #003366;
    padding-top: 10px;
    margin-top: 30px;
    font-size: 9pt;
    color: #666;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 15px 0;
    font-size: 11pt;
  }
  th {
    background-color: #003366;
    color: white;
    padding: 10px 12px;
    text-align: left;
    font-weight: bold;
    border: 1px solid #003366;
  }
  td {
    border: 1px solid #003366;
    padding: 8px 12px;
    vertical-align: top;
  }
  tr:nth-child(even) td {
    background-color: #f5f8fc;
  }
  h1 {
    color: #003366;
    font-size: 16pt;
    border-bottom: 1px solid #ccc;
    padding-bottom: 5px;
  }
  h2 {
    color: #003366;
    font-size: 14pt;
    margin-top: 20px;
  }
  h3 {
    color: #003366;
    font-size: 12pt;
  }
  strong {
    color: #003366;
  }
  ul, ol {
    margin: 10px 0;
    padding-left: 20px;
  }
  li {
    margin: 5px 0;
  }
  p {
    margin: 8px 0;
    text-align: justify;
  }
</style>
</head>
<body>
<div class="header">
  <p class="logo-text">Ministerio de Educación de la República Dominicana</p>
  <p class="subtitle">Viceministerio de Servicios Técnicos Pedagógicos</p>
  <p class="doc-title">${title}</p>
</div>
<div class="content">
{{content}}
</div>
<div class="footer">
  Documento generado por Planixa Asistente - Sistema de Planificación Docente MINERD
</div>
</body>
</html>`;
}

async function run() {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db();
        console.log('Conectado a MongoDB.');

        const formats = await db.collection('doc_formats').find({}).toArray();
        console.log(`Encontrados ${formats.length} formatos.`);

        let updated = 0;
        let skipped = 0;

        for (const format of formats) {
            const hasTemplate = format.htmlTemplate && format.htmlTemplate.length >= 50;
            if (hasTemplate) {
                console.log(`  ↺ ${format.type}: ya tiene htmlTemplate (${format.htmlTemplate.length} chars) → saltando`);
                skipped++;
                continue;
            }

            const template = generateHtmlTemplate(format.type);
            await db.collection('doc_formats').updateOne(
                { _id: format._id },
                { $set: { htmlTemplate: template } }
            );
            console.log(`  ✓ ${format.type}: htmlTemplate asignado (${template.length} chars)`);
            updated++;
        }

        console.log(`\nResumen: ${updated} actualizados, ${skipped} saltados.`);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.close();
    }
}

run();
