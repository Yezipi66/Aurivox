// lib/assetScanner/index.js
// 目录入口：把 lib/assetScanner/ 各模块按原来的导出名单汇总。
const consts = require("./consts");
const scan = require("./scan");
const transcript = require("./transcript");
const importer = require("./import");
const plan = require("./plan");
const audio = require("./audioDuration");
const format = require("./format");

module.exports = {
 ASSETS_DIR: consts.ASSETS_DIR,
 GSV_BASE: consts.GSV_BASE,
 GSV_PATHS: consts.GSV_PATHS,
 listVoiceAssets: scan.listVoiceAssets,
 scanVoiceDir: scan.scanVoiceDir,
 generateSegments: transcript.generateSegments,
 buildSegmentsFor: transcript.buildSegmentsFor,
 parseSlicerOptList: transcript.parseSlicerOptList,
 importFromList: importer.importFromList, // @deprecated — kept for backward compat, training pipeline now uses promote → scanVoiceDir
 fullScan: scan.fullScan,
 detectAssetState: scan.detectAssetState,
 planRebuild: plan.planRebuild,
 getWavDuration: audio.getWavDuration,
 getAudioDuration: audio.getAudioDuration,
 sniffAudioFormat: audio.sniffAudioFormat,
 getFlacDuration: audio.getFlacDuration,
 getMp3Duration: audio.getMp3Duration,
 getMp4Duration: audio.getMp4Duration,
 getOggDuration: audio.getOggDuration,
 formatSize: format.formatSize,
};
