require('dotenv').config();
const { connectMongo, getDb } = require('./src/db');

const commonCSS = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: A4; margin: 15mm 12mm; }
body { font-family: Arial, sans-serif; font-size: 9pt; line-height: 1.3; color: #000; }
h1.titulo-principal { font-size: 11pt; font-weight: bold; text-align: center; margin: 0 0 4px 0; border-bottom: 2px solid #1a3a6b; padding-bottom: 4px; }
h2.subtitulo { font-size: 10pt; font-weight: bold; text-align: center; color: #1a3a6b; margin: 0 0 8px 0; }
table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
th { background-color: #1a3a6b; color: white; font-weight: bold; padding: 4px 6px; font-size: 8.5pt; text-align: left; border: 1px solid #1a3a6b; }
td { border: 1px solid #aaa; padding: 4px 6px; font-size: 8.5pt; vertical-align: top; }
td.label { background-color: #dce6f1; font-weight: bold; width: 18%; white-space: nowrap; }
td.valor { width: 32%; }
.seccion-header { background-color: #1a3a6b; color: white; font-weight: bold; padding: 4px 6px; font-size: 9pt; margin-top: 6px; margin-bottom: 0; }
.momento-header { background-color: #2e75b6; color: white; font-weight: bold; text-align: center; padding: 3px; font-size: 8.5pt; }
ul { margin: 0; padding-left: 14px; }
li { margin-bottom: 2px; }
.checkbox-list { list-style: none; padding-left: 0; margin: 0; }
.checkbox-list li { margin-bottom: 2px; }
.grid-table th { text-align: center; }
.grid-table td { text-align: left; }
</style>
</head>
<body>
<div style="text-align: center; margin-bottom: 15px;">
    <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Logo_del_Ministerio_de_Educaci%C3%B3n_de_la_Rep%C3%BAblica_Dominicana.png/800px-Logo_del_Ministerio_de_Educaci%C3%B3n_de_la_Rep%C3%BAblica_Dominicana.png" style="height: 70px; width: auto;" alt="Logo MINERD" />
</div>
<h1 class="titulo-principal">Ministerio de Educación de la República Dominicana</h1>
`;

const commonDatosGenerales = `
<!-- DATOS GENERALES -->
<div class="seccion-header">Datos Generales</div>
<table>
  <tr>
    <td class="label">Nombre completo</td><td class="valor">{{nombre_completo_docente}}</td>
    <td class="label">Cédula</td><td class="valor">{{cedula}}</td>
  </tr>
  <tr>
    <td class="label">Regional</td><td class="valor">{{regional}}</td>
    <td class="label">Distrito</td><td class="valor">{{distrito}}</td>
  </tr>
  <tr>
    <td class="label">Centro Educativo</td><td class="valor">{{centro_educativo}}</td>
    <td class="label">Código del Centro</td><td class="valor">{{codigo_centro}}</td>
  </tr>
  <tr>
    <td class="label">Grado y Sección</td><td class="valor">{{grado_y_seccion}}</td>
    <td class="label">Área Curricular</td><td class="valor">{{area_curricular}}</td>
  </tr>
  <tr>
    <td class="label">Fecha</td><td class="valor">{{fecha}}</td>
    <td class="label">Duración/Mes</td><td class="valor">{{duracion}}</td>
  </tr>
</table>
`;

const templates = [
    {
        type: 'Plantilla_Unidad_Aprendizaje',
        variables: [
            'nombre_completo_docente', 'cedula', 'regional', 'distrito', 'centro_educativo', 'codigo_centro', 'grado_y_seccion', 'area_curricular', 'fecha', 'duracion',
            'titulo_unidad', 'eje_tematico', 'situacion_aprendizaje', 'competencias_fundamentales_html_list', 'competencias_especificas_html_list',
            'conceptuales_html_list', 'procedimentales_html_list', 'actitudinales_html_list', 'secuencia_actividades_html_list', 'evaluacion_html_list', 'recursos_html_list'
        ],
        html: commonCSS + `<h2 class="subtitulo">Planificación por Unidad de Aprendizaje</h2>` + commonDatosGenerales + `
<div class="seccion-header">1. Articulación de la Unidad</div>
<table>
  <tr>
    <td class="label">Título de la Unidad</td><td colspan="3">{{titulo_unidad}}</td>
  </tr>
  <tr>
    <td class="label">Eje Temático</td><td colspan="3">{{eje_tematico}}</td>
  </tr>
  <tr>
    <td class="label">Situación de Aprendizaje</td><td colspan="3">{{situacion_aprendizaje}}</td>
  </tr>
</table>
<div class="seccion-header">2. Competencias</div>
<table>
  <tr>
    <th style="width:50%">Competencias Fundamentales (Descriptores)</th>
    <th style="width:50%">Competencias Específicas del Área</th>
  </tr>
  <tr>
    <td>{{competencias_fundamentales_html_list}}</td>
    <td>{{competencias_especificas_html_list}}</td>
  </tr>
</table>
<div class="seccion-header">3. Malla Curricular (Contenidos)</div>
<table>
  <tr>
    <th style="width:33%">Conceptuales</th>
    <th style="width:33%">Procedimentales</th>
    <th style="width:34%">Actitudinales</th>
  </tr>
  <tr>
    <td>{{conceptuales_html_list}}</td>
    <td>{{procedimentales_html_list}}</td>
    <td>{{actitudinales_html_list}}</td>
  </tr>
</table>
<div class="seccion-header">4. Secuencia Didáctica (Resumen)</div>
<table>
  <tr>
    <th style="width:40%">Actividades de Enseñanza y Aprendizaje</th>
    <th style="width:30%">Técnicas e Instrumentos de Evaluación</th>
    <th style="width:30%">Recursos Educativos</th>
  </tr>
  <tr>
    <td>{{secuencia_actividades_html_list}}</td>
    <td>{{evaluacion_html_list}}</td>
    <td>{{recursos_html_list}}</td>
  </tr>
</table>
</body></html>`
    },
    {
        type: 'Plantilla_Proyecto_Aula_PPA',
        variables: [
            'nombre_completo_docente', 'cedula', 'regional', 'distrito', 'centro_educativo', 'codigo_centro', 'grado_y_seccion', 'area_curricular', 'fecha', 'duracion',
            'nombre_proyecto', 'problema', 'justificacion', 'propositos_html_list', 'preguntas_problematizadoras_html_list', 
            'fase_1_html_list', 'fase_2_html_list', 'fase_3_html_list', 'evaluacion_proyecto_html_list'
        ],
        html: commonCSS + `<h2 class="subtitulo">Proyecto Participativo de Aula (PPA)</h2>` + commonDatosGenerales + `
<div class="seccion-header">Fase I: Identificación y Justificación</div>
<table>
  <tr>
    <td class="label">Nombre del Proyecto</td><td colspan="3">{{nombre_proyecto}}</td>
  </tr>
  <tr>
    <td class="label">Problema a Investigar</td><td colspan="3">{{problema}}</td>
  </tr>
  <tr>
    <td class="label">Justificación</td><td colspan="3">{{justificacion}}</td>
  </tr>
</table>
<div class="seccion-header">Fase II: Propósitos y Problematización</div>
<table>
  <tr>
    <th style="width:50%">Propósitos del Proyecto</th>
    <th style="width:50%">Preguntas Problematizadoras</th>
  </tr>
  <tr>
    <td>{{propositos_html_list}}</td>
    <td>{{preguntas_problematizadoras_html_list}}</td>
  </tr>
</table>
<div class="seccion-header">Fase III: Acciones y Actividades</div>
<table>
  <tr>
    <td class="momento-header" colspan="2">1. Descubrimiento e Investigación (Inicio)</td>
  </tr>
  <tr><td colspan="2">{{fase_1_html_list}}</td></tr>
  <tr>
    <td class="momento-header" colspan="2">2. Construcción y Ejecución (Desarrollo)</td>
  </tr>
  <tr><td colspan="2">{{fase_2_html_list}}</td></tr>
  <tr>
    <td class="momento-header" colspan="2">3. Presentación y Cierre</td>
  </tr>
  <tr><td colspan="2">{{fase_3_html_list}}</td></tr>
</table>
<div class="seccion-header">Evaluación del Proyecto</div>
<table>
  <tr><td>{{evaluacion_proyecto_html_list}}</td></tr>
</table>
</body></html>`
    },
    {
        type: 'Plantilla_Rubrica_Analitica',
        variables: [
            'nombre_completo_docente', 'cedula', 'regional', 'distrito', 'centro_educativo', 'codigo_centro', 'grado_y_seccion', 'area_curricular', 'fecha', 'duracion',
            'actividad_evaluar', 'competencia_especifica', 'indicador_1', 'ind1_excelente', 'ind1_bueno', 'ind1_regular', 'ind1_deficiente',
            'indicador_2', 'ind2_excelente', 'ind2_bueno', 'ind2_regular', 'ind2_deficiente',
            'indicador_3', 'ind3_excelente', 'ind3_bueno', 'ind3_regular', 'ind3_deficiente'
        ],
        html: commonCSS + `<h2 class="subtitulo">Rúbrica Analítica de Evaluación</h2>` + commonDatosGenerales + `
<table>
  <tr>
    <td class="label">Actividad/Producto a Evaluar</td><td>{{actividad_evaluar}}</td>
  </tr>
  <tr>
    <td class="label">Competencia Específica</td><td>{{competencia_especifica}}</td>
  </tr>
</table>
<div class="seccion-header">Matriz de Evaluación</div>
<table class="grid-table">
  <tr>
    <th style="width:20%">Indicadores de Logro / Criterios</th>
    <th style="width:20%">Excelente (Destacado)</th>
    <th style="width:20%">Bueno (Logrado)</th>
    <th style="width:20%">Regular (En Proceso)</th>
    <th style="width:20%">Deficiente (Iniciado)</th>
  </tr>
  <tr>
    <td><strong>{{indicador_1}}</strong></td>
    <td>{{ind1_excelente}}</td>
    <td>{{ind1_bueno}}</td>
    <td>{{ind1_regular}}</td>
    <td>{{ind1_deficiente}}</td>
  </tr>
  <tr>
    <td><strong>{{indicador_2}}</strong></td>
    <td>{{ind2_excelente}}</td>
    <td>{{ind2_bueno}}</td>
    <td>{{ind2_regular}}</td>
    <td>{{ind2_deficiente}}</td>
  </tr>
  <tr>
    <td><strong>{{indicador_3}}</strong></td>
    <td>{{ind3_excelente}}</td>
    <td>{{ind3_bueno}}</td>
    <td>{{ind3_regular}}</td>
    <td>{{ind3_deficiente}}</td>
  </tr>
</table>
</body></html>`
    },
    {
        type: 'Plantilla_Lista_Cotejo',
        variables: [
            'nombre_completo_docente', 'cedula', 'regional', 'distrito', 'centro_educativo', 'codigo_centro', 'grado_y_seccion', 'area_curricular', 'fecha', 'duracion',
            'actividad_evaluar', 'indicador_1', 'indicador_2', 'indicador_3', 'indicador_4', 'indicador_5'
        ],
        html: commonCSS + `<h2 class="subtitulo">Lista de Cotejo (Formato Maestro)</h2>` + commonDatosGenerales + `
<table>
  <tr>
    <td class="label">Actividad a Evaluar</td><td>{{actividad_evaluar}}</td>
  </tr>
</table>
<div class="seccion-header">Registro de Estudiantes</div>
<table class="grid-table">
  <tr>
    <th rowspan="2" style="width:25%; vertical-align:middle;">Nombres y Apellidos</th>
    <th colspan="5">Indicadores (Criterios de Evaluación)</th>
    <th rowspan="2" style="width:15%; vertical-align:middle;">Observaciones</th>
  </tr>
  <tr>
    <th style="width:12%; font-size:7pt; font-weight:normal;">1. {{indicador_1}}</th>
    <th style="width:12%; font-size:7pt; font-weight:normal;">2. {{indicador_2}}</th>
    <th style="width:12%; font-size:7pt; font-weight:normal;">3. {{indicador_3}}</th>
    <th style="width:12%; font-size:7pt; font-weight:normal;">4. {{indicador_4}}</th>
    <th style="width:12%; font-size:7pt; font-weight:normal;">5. {{indicador_5}}</th>
  </tr>
  <!-- Filas vacías para los estudiantes -->
  <tr><td style="height:20px;">1. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">2. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">3. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">4. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">5. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">6. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">7. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">8. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">9. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">10. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">11. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">12. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">13. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">14. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td style="height:20px;">15. </td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</table>
</body></html>`
    },
    {
        type: 'Plantilla_Situacion_Aprendizaje',
        variables: [
            'nombre_completo_docente', 'cedula', 'regional', 'distrito', 'centro_educativo', 'codigo_centro', 'grado_y_seccion', 'area_curricular', 'fecha', 'duracion',
            'titulo_unidad', 'contexto', 'problema', 'estrategia', 'producto', 'punto_llegada', 'redaccion_completa'
        ],
        html: commonCSS + `<h2 class="subtitulo">Diseño de Situación de Aprendizaje</h2>` + commonDatosGenerales + `
<table>
  <tr>
    <td class="label">Unidad de Aprendizaje Asociada</td><td>{{titulo_unidad}}</td>
  </tr>
</table>
<div class="seccion-header">Componentes de la Situación</div>
<table>
  <tr>
    <td class="label" style="width:25%">1. Contexto (El escenario)</td><td>{{contexto}}</td>
  </tr>
  <tr>
    <td class="label">2. Situación o Problema</td><td>{{problema}}</td>
  </tr>
  <tr>
    <td class="label">3. Estrategia a utilizar</td><td>{{estrategia}}</td>
  </tr>
  <tr>
    <td class="label">4. Producto esperado</td><td>{{producto}}</td>
  </tr>
  <tr>
    <td class="label">5. Punto de llegada (Resolución)</td><td>{{punto_llegada}}</td>
  </tr>
</table>
<div class="seccion-header">Redacción Final Consolidada</div>
<table>
  <tr>
    <td style="padding: 10px; font-size: 10pt; line-height: 1.5; text-align: justify;">{{redaccion_completa}}</td>
  </tr>
</table>
</body></html>`
    }
];

const prompts = [
    {
        name: 'Especialista_Unidad_Aprendizaje',
        description: 'Experto en redactar la Planificación de Unidad de Aprendizaje completa (a mediano plazo) con su malla curricular.',
        model: 'gpt-4o',
        content: `Eres el Especialista en Unidades de Aprendizaje del MINERD.
Tu objetivo es diseñar una Unidad de Aprendizaje completa y articulada, que dure entre 2 y 4 semanas.

DEBES extraer el tema y área del usuario y proponer:
1. Un Eje Temático integrador.
2. Una Situación de Aprendizaje (contexto + problema + producto).
3. Seleccionar Competencias Fundamentales y Específicas.
4. Desglosar los contenidos Conceptuales, Procedimentales y Actitudinales rigurosamente.
5. Proponer una secuencia de actividades de enseñanza y evaluación general.`
    },
    {
        name: 'Especialista_Proyectos_PPA',
        description: 'Experto en metodologías ABP (Aprendizaje Basado en Proyectos) y Proyectos Participativos de Aula (PPA).',
        model: 'gpt-4o',
        content: `Eres el Especialista en Proyectos Participativos de Aula (PPA) del MINERD.
Tu objetivo es diseñar un proyecto escolar que resuelva un problema real de la comunidad o del centro.

Debes redactar:
1. El problema a investigar y su justificación.
2. Los propósitos del proyecto.
3. Las preguntas problematizadoras que guiarán la investigación de los niños.
4. Dividir el trabajo en 3 fases: Descubrimiento, Ejecución y Cierre, listando actividades claras en cada una.`
    },
    {
        name: 'Especialista_Rubricas',
        description: 'Experto en evaluación educativa para redactar Rúbricas Analíticas con descriptores escalonados.',
        model: 'gpt-4o',
        content: `Eres el Especialista en Evaluación Educativa del MINERD.
Tu objetivo es crear una Rúbrica Analítica de Evaluación para la actividad o producto que el docente te indique.

Debes:
1. Definir la competencia específica a evaluar.
2. Crear 3 indicadores de logro / criterios principales (ej. Contenido, Presentación, Trabajo en Equipo).
3. Redactar descriptores muy claros y mutuamente excluyentes para los niveles: Excelente, Bueno, Regular y Deficiente. Los descriptores deben ser precisos (ej. 'Cumple con 4 de 5 requisitos...').`
    },
    {
        name: 'Especialista_Lista_Cotejo',
        description: 'Experto en evaluación rápida para redactar Listas de Cotejo con criterios binarios.',
        model: 'gpt-4o',
        content: `Eres el Especialista en Instrumentos de Evaluación del MINERD.
Tu objetivo es crear una Lista de Cotejo para evaluar de manera binaria (Sí/No) una actividad específica de los alumnos.

Debes crear 5 indicadores (criterios) precisos, observables e inconfundibles. Cada indicador debe redactarse de forma afirmativa (Ej. "El estudiante sigue las instrucciones dadas", "Mantiene su área limpia"). Que sean breves (máximo 8-10 palabras por indicador).`
    },
    {
        name: 'Especialista_Situaciones_Aprendizaje',
        description: 'Experto en pedagogía narrativa para redactar Situaciones de Aprendizaje creativas y contextualizadas.',
        model: 'gpt-4o',
        content: `Eres el Especialista en Situaciones de Aprendizaje del MINERD.
Tu objetivo es redactar la historia introductoria (Situación de Aprendizaje) de una unidad didáctica, logrando que sea interesante y realista para los estudiantes dominicanos.

Debes separar el proceso en:
1. Contexto (dónde ocurre).
2. Problema (qué pasa que necesita solución).
3. Estrategia (cómo los alumnos lo abordarán, ej. indagación dialógica, ABP).
4. Producto (qué entregarán al final, ej. un mural, un debate).
5. Punto de llegada (qué aprenderán con esto).
Finalmente, unir todo en un solo párrafo consolidado de 4 a 6 líneas ("Redacción Completa").`
    }
];

async function run() {
    await connectMongo();
    const db = getDb();
    
    console.log("=== INICIANDO EXPANSIÓN DEL CATÁLOGO ===");

    for (const tmpl of templates) {
        await db.collection('doc_formats').updateOne(
            { type: tmpl.type },
            { $set: { type: tmpl.type, htmlTemplate: tmpl.html, variables: tmpl.variables, schema_version: 1 } },
            { upsert: true }
        );
        console.log(`✅ Plantilla inyectada: ${tmpl.type}`);
    }

    for (const pr of prompts) {
        await db.collection('prompts').updateOne(
            { name: pr.name },
            { $set: { name: pr.name, description: pr.description, model: pr.model, content: pr.content } },
            { upsert: true }
        );
        console.log(`✅ Especialista inyectado: ${pr.name}`);
    }

    console.log("=== EXPANSIÓN COMPLETADA EXITOSAMENTE ===");
    process.exit(0);
}

run().catch(console.error);
