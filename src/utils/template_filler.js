/**
 * template_filler.js
 * Utilidad para rellenar las variables {{variable}} de un htmlTemplate 
 * con los datos JSON devueltos por el Especialista de planificación.
 */

/**
 * Convierte un valor a HTML de lista si es un array, o texto plano si es string.
 * @param {string|string[]} value
 * @returns {string}
 */
function toHtmlList(value) {
    if (Array.isArray(value) && value.length > 0) {
        return value.map(item => `- ${String(item).trim()}`).join('<br>');
    }
    if (typeof value === 'string' && value.includes('\n')) {
        const items = value.split('\n').map(l => l.replace(/^[-*•]\s*/, '').trim()).filter(l => l);
        if (items.length > 1) {
            return items.map(item => `- ${item}`).join('<br>');
        }
    }
    return String(value || '').trim();
}

/**
 * Convierte un booleano o string (true/false/si/no) en símbolo de checkbox.
 * @param {any} value
 * @returns {string}
 */
function toCheckbox(value) {
    if (!value) return '☐';
    const str = String(value).toLowerCase().trim();
    if (str === 'true' || str === 'si' || str === 'sí' || str === 'yes' || str === '1' || str === 'x') {
        return '☑';
    }
    return '☐';
}

/**
 * Rellena todas las variables {{key}} de un htmlTemplate con los datos del JSON.
 * Maneja casos especiales:
 *   - Variables con sufijo _html_list → convierte arrays/texto a <ul><li>
 *   - Variables con prefijo check_ → convierte a ☑/☐
 *   - Variables sin valor → reemplaza con guión (-)
 *
 * @param {string} htmlTemplate - El HTML de la plantilla con variables {{...}}
 * @param {Object} data - JSON con los valores del Especialista
 * @returns {string} - HTML con todas las variables reemplazadas
 */
function fillTemplate(htmlTemplate, data) {
    if (!htmlTemplate || typeof htmlTemplate !== 'string') {
        throw new Error('htmlTemplate inválido o vacío.');
    }
    if (!data || typeof data !== 'object') {
        throw new Error('data JSON inválido.');
    }

    let result = htmlTemplate;

    // Primero, reemplazar todas las variables que tienen un valor en data
    for (const [key, value] of Object.entries(data)) {
        const placeholder = `{{${key}}}`;
        if (!result.includes(placeholder)) continue;

        let replacement;

        if (key.startsWith('check_')) {
            replacement = toCheckbox(value);
        } else if (key.endsWith('_html_list')) {
            replacement = toHtmlList(value);
        } else {
            replacement = String(value !== null && value !== undefined ? value : '').trim();
        }

        // Escape special regex characters in placeholder for safety
        result = result.split(placeholder).join(replacement);
    }

    // Luego, limpiar todas las variables {{...}} que no fueron llenadas
    result = result.replace(/\{\{[a-z_A-Z0-9]+\}\}/g, (match) => {
        const key = match.slice(2, -2);
        // Checkboxes no llenados → vacío
        if (key.startsWith('check_')) return '☐';
        // Listas no llenadas → vacío
        if (key.endsWith('_html_list')) return '-';
        // Demás → guión
        return '-';
    });

    return result;
}

/**
 * Extrae el JSON de la respuesta del Especialista.
 * El Especialista puede devolver el JSON dentro de un bloque ```json ... ```
 * o directamente como texto plano empezando con {.
 *
 * @param {string} text - Respuesta completa del Especialista
 * @returns {{ json: Object|null, hasTag: boolean }}
 */
function extractSpecialistJson(text) {
    if (!text) return { json: null, hasTag: false };

    const hasTag = text.includes('[GENERATE_DOCX]') || text.includes('[GENERATE_WORD]');

    // Intentar extraer un bloque ```json ... ```
    const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/i);
    if (jsonBlockMatch) {
        try {
            return { json: JSON.parse(jsonBlockMatch[1].trim()), hasTag };
        } catch (e) {
            console.error('[template_filler] Error parseando bloque ```json```:', e.message);
        }
    }

    // Intentar extraer JSON directo que empiece con {
    const directMatch = text.match(/(\{[\s\S]*\})/);
    if (directMatch) {
        try {
            return { json: JSON.parse(directMatch[1]), hasTag };
        } catch (e) {
            console.error('[template_filler] Error parseando JSON directo:', e.message);
        }
    }

    return { json: null, hasTag };
}

module.exports = { fillTemplate, extractSpecialistJson, toHtmlList, toCheckbox };
