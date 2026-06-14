const { connectMongo, getDb } = require('./src/db');
async function test() {
    await connectMongo();
    try {
        const users = await getDb().collection('users').find({}, { projection: { password: 0 } }).sort({ created_at: -1 }).toArray();
        console.log("Users returned:", users.length);
    } catch (e) {
        console.error("ERROR:", e.message);
    }
    process.exit(0);
}
test();
