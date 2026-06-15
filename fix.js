const fs = require('fs');
['public/js/admin.js', 'public/js/app.js'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  
  // Fix swallowed characters
  // The script replaced '([^...])alert(' with 'PremiumModal.alert(' (swallowing the char)
  // Let's restore await and the missing '!' or ' ' before it.
  
  // We need to find places where PremiumModal is used without await and fix them.
  // Actually, since we lost the prefix character (like '!' or ' '), we need to fix it manually or with regex.
  // Let's look at the patterns:
  
  // 1. "return PremiumModal.alert" -> "return await PremiumModal.alert"
  content = content.replace(/return PremiumModal\.alert/g, 'return await PremiumModal.alert');
  
  // 2. "if ( PremiumModal.confirm" -> this used to be "if (!confirm"
  content = content.replace(/if \( PremiumModal\.confirm/g, 'if (!(await PremiumModal.confirm)');
  
  // 3. "= PremiumModal.prompt" -> "= await PremiumModal.prompt"
  content = content.replace(/= PremiumModal\.prompt/g, '= await PremiumModal.prompt');
  
  // 4. Any other PremiumModal.alert that is not awaited:
  content = content.replace(/(?<!await )PremiumModal\.alert/g, 'await PremiumModal.alert');
  
  // 5. Any other PremiumModal.confirm that is not awaited:
  content = content.replace(/(?<!await )PremiumModal\.confirm/g, 'await PremiumModal.confirm');

  fs.writeFileSync(file, content);
});
console.log('Fixed await and swallowed chars.');
