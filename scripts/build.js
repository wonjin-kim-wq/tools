const fs = require('node:fs');
fs.mkdirSync('public/assets', {recursive:true});
for (const name of ['index.html','tools.css','tools.js']) fs.copyFileSync(name,`public/${name}`);
fs.copyFileSync('assets/chamssaem.png','public/assets/chamssaem.png');
fs.copyFileSync('favicon.ico','public/favicon.ico');
for (const name of ['favicon.svg','favicon-32.png','favicon-192.png','apple-touch-icon.png']) fs.copyFileSync(`assets/${name}`,`public/assets/${name}`);
console.log('Static site built. Server API is bundled separately by Vercel.');
