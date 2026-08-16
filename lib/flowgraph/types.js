'use strict'

// ---------------------------------------------------------------------------
//  Port types
// ---------------------------------------------------------------------------
// Ruling (2026-08-14): "类型多我认为是对的，以应对更多情况".
// So this list ADDS to what lib/workflow/nodeRegistry.js already had; nothing
// was removed. Type richness is a feature here: a wrong connection should be
// impossible to make, not merely discouraged.
//
// The one correction made was NOT a removal: `Model` is a new, engine-agnostic
// type that does not say how many files a model is made of. `ModelPair`
// (GPT + SoVITS weights) survives as a concrete case of it, so a single-file
// engine can be wired without inventing a fake second weight.

const PORT_TYPES = Object.freeze([
  // data
  'Text',
  'TextList',
  'Audio',
  'AudioList',
  'ReferenceAudio',
  'Transcript',
  // engine + models
  'Engine',
  'EngineParams',
  'Model',        // generic: "a model", file count unspecified
  'ModelPair',    // concrete: GPT + SoVITS, a kind of Model
  'VoiceRef',
  'Recipe',
  'PronunciationMap',
  // measurement / gate
  'Metrics',
  'MetricsList',
  'Score',
  'ScoreList',
  'QualityStandard',
  'Table',
  // scalars
  'Number',
  'Boolean',
  'String',
  'IndexList',
  // catch-all for release / preview style sinks
  'Any',
])

// A model port accepts any concrete model shape; Any accepts everything.
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
