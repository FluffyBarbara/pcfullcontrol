'use strict';
// Копирует общие файлы (иконки, jsQR) в www перед сборкой.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const www = path.join(root, 'www');
fs.copyFileSync(require.resolve('jsqr/dist/jsQR.js'), path.join(www, 'jsQR.js'));
fs.copyFileSync(path.join(root, '..', 'src', 'shared', 'icons.js'), path.join(www, 'icons.js'));
fs.copyFileSync(path.join(root, '..', 'src', 'mobile', 'icon-192.png'), path.join(www, 'icon-192.png'));
console.log('www готов');
