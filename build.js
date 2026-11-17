// Construit docs/index.html : la page avec le moteur intégré (un seul fichier, sans dépendance).
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app/index.src.html', 'utf8');
const engine = fs.readFileSync(__dirname + '/engine.js', 'utf8');
fs.mkdirSync(__dirname + '/docs', { recursive: true });
fs.writeFileSync(__dirname + '/docs/index.html', src.replace('/*ENGINE*/', () => engine));
for (const f of fs.readdirSync(__dirname + '/app/pwa')) fs.copyFileSync(__dirname + '/app/pwa/' + f, __dirname + '/docs/' + f);
console.log('docs/index.html', fs.statSync(__dirname + '/docs/index.html').size, 'octets');
