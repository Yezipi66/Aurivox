// 训练管线的对外入口：状态机、步骤循环、取消与断点恢复的实现都在 pipeline/ 下的模块里，
// 这里只做转发。每个步骤独立执行，可取消；日志按任务 id 轮询。
const { STAGING_ROOT } = require('../../paths');
const { createPipeline } = require('./createPipeline');
const { getTask, getAllTasks, getStatusById, getLogsById, readTaskJournal, listRecoverable } = require('./taskStore');
const { snapshotPronLexicon } = require('./pronLexicon');
const { parseListToSegments, mergeCustomParams, classifyFailure } = require('./pure');

module.exports = { createPipeline, getTask, getAllTasks, getStatusById, getLogsById, STAGING_ROOT, readTaskJournal, listRecoverable, snapshotPronLexicon, parseListToSegments, mergeCustomParams, classifyFailure };
