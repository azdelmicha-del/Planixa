const fs = require('fs');
const path = require('path');

const targets = [
  'index.html',
  'public/js/app.js',
  'src/server.js',
  'src/routes/webhook.js',
  'src/routes/chat.js',
  'src/routes/export.js',
  'src/routes/generate.js',
  'src/routes/language.js',
  'src/routes/notify.js',
  'src/routes/students.js',
  'src/routes/pwa.js'
];

targets.forEach(file => {
  const filepath = path.join(__dirname, file);
  if (fs.existsSync(filepath)) {
    let content = fs.readFileSync(filepath, 'utf8');
    
    // Replace "El Profe 2.0" -> "Planixa"
    content = content.replace(/El Profe 2\.0/g, 'Planixa');
    // Replace "El Profe" -> "Planixa" (if any standalone)
    content = content.replace(/El Profe/g, 'Planixa');
    // Replace "el profe 2.0" -> "Planixa"
    content = content.replace(/el profe 2\.0/ig, 'Planixa');
    // Replace "El-profe-2.0" -> "Planixa"
    content = content.replace(/El-profe-2\.0/g, 'Planixa');
    
    fs.writeFileSync(filepath, content, 'utf8');
    console.log('Updated:', file);
  } else {
    console.warn('File not found:', file);
  }
});
