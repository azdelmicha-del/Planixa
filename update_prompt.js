const { connectMongo, getDb } = require('./src/db');
async function run() {
    await connectMongo();
    const db = getDb();
    const p = await db.collection('prompts').findOne({ name: 'Especialista_Planificacion_Diaria_Unidad' });
    let newContent = p.content.replace(
        'Si falta un dato esencial, debes responder únicamente a PLANIXA_principal indicando qué dato falta y cómo debe preguntarlo.',
        'Si falta un dato estructural obligatorio para llenar la plantilla (como el Nivel o Grado), indica qué dato falta. IMPORTANTE: Acepta CUALQUIER Tema, Contenido o Materia enviado en los parámetros (incluso si parece inusual, tiene errores tipográficos o no está explícitamente en la base de conocimientos). NO rechaces temas enviados por el docente. Utiliza la base de conocimientos como referencia, pero la voluntad del docente en el Tema es absoluta.'
    );
    await db.collection('prompts').updateOne({ name: 'Especialista_Planificacion_Diaria_Unidad' }, { $set: { content: newContent } });
    console.log('Updated Especialista prompt!');
    process.exit(0);
}
run();
