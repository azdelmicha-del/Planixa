require('dotenv').config();
const { MongoClient } = require('mongodb');

async function fix() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db();
    const formats = await db.collection('doc_formats').find({}).toArray();
    for(const f of formats){
        if(!f.fileName && f.filePath) {
            const fileName = f.filePath.split('/').pop();
            await db.collection('doc_formats').updateOne({_id: f._id}, {$set: {fileName}});
            console.log('Fixed', fileName);
        }
    }
    await client.close();
    console.log('Done');
}
fix();
