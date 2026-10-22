// 训练管线的对外门面：把 pipeline/index.js 组装好的能力原样转发给调用方（server.js 的 HTTP 层）。
// 实现分散在 pipeline/ 下的模块里：状态机与步骤循环在 createPipeline，任务存取在 taskStore，
// 纯函数在 pure。这里不做加工，只做转发。
const pipeline = require('./pipeline/index');

module.exports = pipeline;
