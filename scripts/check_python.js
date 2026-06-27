const path = require('path');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('lib/training/python.json', 'utf-8'));
let p = cfg.python;
console.log('__dirname:', __dirname);
console.log('python.json value:', p);
if (!path.isAbsolute(p)) {
  p = path.resolve(__dirname, '..', '..', p);
}
console.log('Resolved:', p);
console.log('Exists:', fs.existsSync(p));
