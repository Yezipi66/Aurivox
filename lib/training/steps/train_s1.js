// 训练第 5 步的入口：S1（GPT 半模型）训练。
// 训练管线的 createPipeline 按 step key 逐个 require 同名文件并调用它的 run，
// 因此每个步骤必须单独成文件；本文件只转调 train.js 的 runS1。
// 产物与参数细节都在 train.js，这里不重复。

const train = require('./train');

module.exports.run = (ctx, log) => train.runS1(ctx, log);
