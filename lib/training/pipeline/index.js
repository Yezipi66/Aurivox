/**
 * Training Pipeline 编排器
 *
 * 状态机：pending → running → completed / failed
 * 每个步骤独立执行，支持取消
 * 实时日志输出（轮询）
 *
 * 使用方式：
 * const pipeline = createPipeline({ voiceId: 'xxx', language: 'ja', steps: {...} });
 * pipeline.start();
 */
const { STAGING_ROOT } = require('../../paths');
const { createPipeline } = require('./createPipeline');
const { getTask, getAllTasks, getStatusById, getLogsById, readTaskJournal, listRecoverable } = require('./taskStore');
const { snapshotPronLexicon } = require('./pronLexicon');
const { parseListToSegments, mergeCustomParams, classifyFailure } = require('./pure');

module.exports = { createPipeline, getTask, getAllTasks, getStatusById, getLogsById, STAGING_ROOT, readTaskJournal, listRecoverable, snapshotPronLexicon, parseListToSegments, mergeCustomParams, classifyFailure };
