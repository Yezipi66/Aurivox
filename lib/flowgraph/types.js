'use strict'

// 画布端口的类型表。类型只增不减：宁可多一种类型，也不要让画布上接错的线还能连上。
// Model 是与引擎无关的泛型位，不规定一份模型由几个文件组成；ModelPair 是它的一个
// 具体形态。单文件引擎用 Model 就够，不必假装有第二份权重。

const PORT_TYPES = Object.freeze([
  // 数据
  'Text',
  'TextList',
  'Audio',
  'AudioList',
  'ReferenceAudio',
  'Transcript',
  // 引擎与模型
  'Engine',
  'EngineParams',
  'Model',
  'ModelPair',
  'VoiceRef',
  'Recipe',
  'PronunciationMap',
  // 度量与门
  'Metrics',
  'MetricsList',
  'Score',
  'ScoreList',
  'QualityStandard',
  'Table',
  // 标量
  'Number',
  'Boolean',
  'String',
  'IndexList',
  // 兜底：导出、预览一类没有固定形状的落点
  'Any',
])

// 子类型表：Model 端口可接 ModelPair，Any 端口可接任何类型。
const SUBTYPES = Object.freeze({
  Model: ['ModelPair'],
  Audio: ['ReferenceAudio'],
  Text: ['String'],
  Number: ['Score'],
})

function isPortType(type) {
  return PORT_TYPES.includes(type)
}

function accepts(targetType, sourceType) {
  if (targetType === 'Any' || sourceType === 'Any') return true
  if (targetType === sourceType) return true
  const subs = SUBTYPES[targetType]
  return Array.isArray(subs) && subs.includes(sourceType)
}

module.exports = { PORT_TYPES, SUBTYPES, accepts, isPortType }
