const { connectMongo, getDb } = require('./src/db');
async function test() {
    await connectMongo();
    try {
        const admin = await getDb().collection('users').findOne({ is_admin: true });
        console.log("Admin ID:", admin._id, "Type:", typeof admin._id, "IsObjectId:", admin._id instanceof require('mongodb').ObjectId);
    } catch (e) {
        console.error("ERROR:", e.message);
    }
    process.exit(0);
}
test();
