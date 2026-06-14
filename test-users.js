require('dotenv').config();
const { MongoClient } = require('mongodb');

async function testUsers() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db(process.env.DB_NAME || 'planixa');
    const users = await db.collection('users').find({}, { projection: { password: 0 } }).sort({ created_at: -1 }).toArray();
    console.log('Total users:', users.length);
    if(users.length > 0) {
      console.log('First user sample:', users[0]);
    }
    await client.close();
}

testUsers().catch(console.error);
