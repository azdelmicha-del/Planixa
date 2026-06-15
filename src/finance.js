const { getDb } = require('./db');

// Costos por 1 millón de tokens (en USD)
const PRICING = {
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4o': { input: 5.00, output: 15.00 }
};

async function logApiUsage(identifier, actionDesc, model, usage) {
    if (!usage || typeof usage.prompt_tokens === 'undefined') return;
    
    try {
        const db = getDb();
        const prices = PRICING[model] || PRICING['gpt-4o-mini'];
        
        // Calcular costo
        const inputCost = (usage.prompt_tokens / 1000000) * prices.input;
        const outputCost = (usage.completion_tokens / 1000000) * prices.output;
        const totalCost = inputCost + outputCost;

        // Registrar en logs de finanzas
        const logEntry = {
            date: new Date(),
            identifier: identifier || 'Sistema',
            action: actionDesc,
            model: model,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cost: totalCost
        };
        await db.collection('api_usage').insertOne(logEntry);

        // Descontar del balance global en settings
        await db.collection('settings').updateOne(
            { _id: 'general' },
            { $inc: { api_balance: -totalCost } },
            { upsert: true }
        );
    } catch (err) {
        console.error('Error logging API usage:', err);
    }
}

module.exports = { logApiUsage };
