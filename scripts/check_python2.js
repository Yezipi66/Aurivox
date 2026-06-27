const path = require('path');
const fs = require('fs');
const PYTHON_CONFIG = path.join(__dirname, 'python.json');
const cfg = JSON.parse(fs.readFileSync(PYTHON_CONFIG, 'utf-8'));
let p = cfg.python;
if (!path.isAbsolute(p)) {
  p = path.resolve(__dirname, '..', '..', p);
}
console.log('__dirname:', __dirname);
console.log('Resolved:', p);
console.log('Exists:', fs.existsSync(p));
