const http = require('http');
const fetch = require('node-fetch'); // we can just use native fetch if node 18+

async function run() {
  // we know from earlier the admin is 18296836932
  // but let's just make a JWT token
  const jwt = require('jsonwebtoken');
  const { connectMongo, getDb } = require('./src/db');
  await connectMongo();
  const db = getDb();
  const admin = await db.collection('users').findOne({ is_admin: true });
  if (!admin) {
    console.log("NO ADMIN FOUND IN DB");
    process.exit(1);
  }
  
  const token = jwt.sign(
      { userId: admin._id.toString(), role: admin.role },
      process.env.JWT_SECRET || 'super_secret_jwt_key_planif_pro_2026',
      { expiresIn: '1d' }
  );

  const res = await fetch('http://localhost:3000/api/admin/users', {
      headers: { 'Authorization': 'Bearer ' + token }
  });
  
  const text = await res.text();
  console.log("HTTP RESPONSE:", text);
  process.exit(0);
}
run();
