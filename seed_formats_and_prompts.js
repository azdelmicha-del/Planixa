require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const PizZip = require('pizzip');

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('Error: MONGODB_URI no está definido en .env');
    process.exit(1);
}

const plantillasDir = path.join(__dirname, 'plantillas');

async function run() {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db();
        console.log('Conectado a MongoDB.');

        const publicFormatsDir = path.join(__dirname, 'public', 'uploads', 'formats');
        if (!fs.existsSync(publicFormatsDir)) fs.mkdirSync(publicFormatsDir, { recursive: true });

        const formatFiles = fs.readdirSync(plantillasDir).filter(f => f.endsWith('.docx'));
        
        for (const file of formatFiles) {
            const filePath = path.join(plantillasDir, file);
            const targetFilePath = path.join(publicFormatsDir, file);
            
            // Copiar el archivo para que esté disponible en la web/API
            fs.copyFileSync(filePath, targetFilePath);

            const content = fs.readFileSync(filePath, 'binary');
            const zip = new PizZip(content);
            
            let tags = [];
            try {
                const rawXml = zip.files['word/document.xml'] ? zip.files['word/document.xml'].asText() : '';
                const pureText = rawXml.replace(/<[^>]+>/g, '');
                const tagMatches = pureText.match(/\{\{([^}]+)\}\}/g) || [];
                tags = [...new Set(tagMatches.map(t => t.replace(/[{}]/g, '').trim()))];
            } catch (err) {
                console.error(`Error extrayendo tags de ${file}:`, err.message);
            }

            const docName = file.replace('.docx', '');
            
            // Upsert format
            await db.collection('doc_formats').updateOne(
                { type: docName },
                { 
                    $set: { 
                        type: docName,
                        filePath: `/uploads/formats/${file}`, // Ruta web estándar
                        tags: tags,
                        updatedAt: new Date()
                    }
                },
                { upsert: true }
            );
            console.log(`✅ Formato sincronizado: ${docName} (Tags: ${tags.length})`);
        }

        // 2. ACTUALIZAR PROMPTS DE ESPECIALISTAS Y ORQUESTADOR
        const prompts = await db.collection('prompts').find({}).toArray();
        for (const prompt of prompts) {
            let updatedContent = prompt.content;
            let changed = false;

            if (prompt.name === 'Planixa_Asistente') {
                // Limpiar reglas viejas del Orquestador
                if (updatedContent.includes('Documento Word .docx listo para entregar.')) {
                    updatedContent = updatedContent.replace(/CUANDO EL ESPECIALISTA ENTREGA EL RESULTADO[\s\S]*?(?=CUANDO HAY PROBLEMAS INTERNOS)/, `CUANDO EL ESPECIALISTA ENTREGA EL RESULTADO\nCuando el especialista devuelve el resultado, verificas que haya entregado el código JSON con las variables.\nFelicita al profesor y escribe al final de tu mensaje la etiqueta [GENERATE_DOCX]. Nuestro servidor Node.js leerá esa etiqueta y fabricará el documento físico.\n\n`);
                    changed = true;
                }
                if (updatedContent.includes('CUANDO EL ESPECIALISTA ENTREGA TEXTO EN VEZ DE DOCUMENTO O PLANTILLA')) {
                    updatedContent = updatedContent.replace(/CUANDO EL ESPECIALISTA ENTREGA TEXTO EN VEZ DE DOCUMENTO O PLANTILLA[\s\S]*?(?=---)/, '');
                    changed = true;
                }
            } else if (prompt.name.startsWith('Especialista_')) {
                // Limpiar regla vieja de los Especialistas
                if (updatedContent.includes('REGLA OBLIGATORIA DE ENTREGA EN DOCUMENTO')) {
                    const newRule = `REGLA OBLIGATORIA DE ENTREGA (SISTEMA ZERO-GUESS)\nTÚ ERES UN CEREBRO TÉCNICO. Tu único objetivo final es estructurar los datos pedagógicos y entregárselos al sistema informático para que este fabrique el documento Word real.\n\nPor lo tanto, tu resultado final DEBE SER ÚNICA Y EXCLUSIVAMENTE UN BLOQUE DE CÓDIGO EN FORMATO \`.json\` con todas las variables llenas.\n\n- No intentes generar enlaces de descarga.\n- No intentes simular archivos físicos.\n- No entregues texto plano explicando la planificación.\n- Si un dato no aplica o no existe, déjalo como un string vacío "".\n\nEl Orquestador te enviará de forma dinámica cuáles son las llaves exactas que requiere la plantilla. Tú solo debes tomar tu conocimiento pedagógico, rellenar esas llaves y devolver el bloque json completo al Orquestador.\n`;
                    updatedContent = updatedContent.replace(/REGLA OBLIGATORIA DE ENTREGA EN DOCUMENTO[\s\S]*?(?=FORMATO DE RESPUESTA A PLANIXA_PRINCIPAL CUANDO EL DOCUMENTO ESTÁ LISTO)/, newRule);
                    changed = true;
                }
                if (updatedContent.includes('DOCUMENTO_ENTREGABLE')) {
                    updatedContent = updatedContent.replace(/DOCUMENTO_ENTREGABLE:\n\[Archivo Word \.docx editable listo para entregar\]/g, 'DOCUMENTO_ENTREGABLE:\n[Bloque de código ```json con las variables llenas]');
                    changed = true;
                }
            }

            if (changed) {
                await db.collection('prompts').updateOne({ _id: prompt._id }, { $set: { content: updatedContent } });
                console.log(`✅ Prompt actualizado: ${prompt.name}`);
            }
        }

        console.log('🎉 Sincronización completada con éxito.');
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.close();
    }
}

run();
