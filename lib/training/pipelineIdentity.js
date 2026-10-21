'use strict';

// 训练管线的身份：全仓库唯一一处声明这条管线属于哪台引擎、产出哪两个权重位（gpt 是 S1 产物，sovits 是 S2 产物）。
// id 与位名都必须与 engines/gpt-sovits/manifest.json 一致，否则界面上「有模型」、合成时「找不到」；合成路径永远问名片，不许拿它当「默认引擎」。
const TRAINING_ENGINE_ID = 'gpt-sovits';

const TRAINING_SLOTS = Object.freeze({
  gpt: Object.freeze({ name: 'gpt', ext: '.ckpt' }),
  sovits: Object.freeze({ name: 'sovits', ext: '.pth' }),
});

module.exports = { TRAINING_ENGINE_ID, TRAINING_SLOTS };
