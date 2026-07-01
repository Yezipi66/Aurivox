// S1 (GPT) 训练步骤：独立封装，复用 train.js 的 runS1。
const train = require('./train');

module.exports.run = (ctx, log) => train.runS1(ctx, log);
