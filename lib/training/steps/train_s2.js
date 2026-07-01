// S2 (SoVITS) 训练步骤：独立封装，复用 train.js 的 runS2。
const train = require('./train');

module.exports.run = (ctx, log) => train.runS2(ctx, log);
