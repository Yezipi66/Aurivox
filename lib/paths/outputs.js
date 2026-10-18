// lib/paths/outputs.js
// 产物目录：outputs/ 下的推理结果
const path = require('path');
const { APP_DIR, envDir } = require('./system');

const OUTPUT_DIR = envDir('OUTPUT_DIR', path.join(APP_DIR, 'outputs'));
const GENERATE_DIR = path.join(OUTPUT_DIR, 'generate');
const COMPARE_DIR = path.join(OUTPUT_DIR, 'comparerefs');
const BROKER_DIR = path.join(OUTPUT_DIR, 'broker');
const FLOWGRAPH_OUTPUT_DIR = path.join(OUTPUT_DIR, 'flowgraph');

const OUTPUT_ROOTS = {
  generate: GENERATE_DIR,
  comparerefs: COMPARE_DIR,
  broker: BROKER_DIR,
};

module.exports = {
  OUTPUT_DIR, GENERATE_DIR, COMPARE_DIR, BROKER_DIR,
  FLOWGRAPH_OUTPUT_DIR, OUTPUT_ROOTS,
};
