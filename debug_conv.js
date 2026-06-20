const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    const db = mongoose.connection.db;
    const convs = await db.collection('conversations').find().sort({createdAt: -1}).limit(3).toArray();
    
    for (const c of convs) {
        console.log('\n--- CONV', c._id, '| is_whatsapp:', c.is_whatsapp, '---');
        if (c.messages) {
            const msgs = c.messages.filter(m => m.role === 'assistant' && (m.content.includes('GENERATE_') || m.content.includes('```json')));
            msgs.forEach(m => console.log('ASSISTANT:', m.content.substring(0, 500)));
        }
    }
    process.exit();
}).catch(e => {
    console.error(e);
    process.exit();
});
