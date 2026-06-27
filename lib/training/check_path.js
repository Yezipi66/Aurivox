const { getPythonPath } = require('./python_helper');
const fs = require('fs');
const p = getPythonPath();
console.log('getPythonPath() returned:', p);
console.log('Exists:', fs.existsSync(p));
