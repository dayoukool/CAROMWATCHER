// Copie l'application web construite (docs/index.html) dans un module JS embarqué dans l'APK.
// L'APK fonctionne ainsi hors ligne, sans dépendre de GitHub Pages.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'docs', 'index.html');
const out = path.join(__dirname, '..', 'web', 'appHtml.js');
const html = fs.readFileSync(src, 'utf8');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '// Généré par scripts/embed-web.js — ne pas modifier.\nexport default ' + JSON.stringify(html) + ';\n');
console.log(`web/appHtml.js : ${html.length} caractères`);
