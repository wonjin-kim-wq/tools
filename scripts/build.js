const fs = require('node:fs');
fs.mkdirSync('public/assets', {recursive:true});
for (const name of ['index.html','tools.css','tools.js']) fs.copyFileSync(name,`public/${name}`);
fs.copyFileSync('assets/chamssaem.png','public/assets/chamssaem.png');
fs.copyFileSync('assets/chamcoding-upload-template.xlsx','public/assets/chamcoding-upload-template.xlsx');
console.log('Static site built. Server API is bundled separately by Vercel.');
