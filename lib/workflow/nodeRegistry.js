'use strict'

// FLOW-CORE-001: the first built-in node registry.
//
// This registry describes graph shape and port contracts only. It does not
// execute inference, training, or review UI. Those concerns belong to later
// adapters and the Executor after the architecture contract is frozen.

const PORT_TYPES = Object.freeze([
  'AudioFile',
  'AudioSet',
  'AudioArtifact',
  'TextArtifact',
  'Transcript',
  'PronunciationRecipe',
  'PronunciationMap',
  'LanguageAssignment',
  'ReferenceAudio',
  'VoiceRef',
  'ModelCheckpoint',
  'ModelPair',
  'Recipe',
  'QualityReport',
  'ReviewRecord',
  'GateDecision',
  'ArtifactRef',
  'InferenceResult',
  'TrainingAsset',
  'Scalar',
  'Boolean',
  'String',
])

const ARTIFACT_TYPES = new Set([
  'AudioFile',
  'AudioSet',
  'AudioArtifact',
  'TextArtifact',
  'Transcript',
  'PronunciationRecipe',
  'PronunciationMap',
  'LanguageAssignment',
  'ReferenceAudio',
  'ModelCheckpoint',
  'ModelPair',
  'Recipe',
  'QualityReport',
  'ReviewRecord',
  'InferenceResult',
  'TrainingAsset',
])

const HUMAN_GATE_DECISIONS = Object.freeze([
  'approve',
  'submit_revision',
  'reject',
  'cancel',
])

function port(type, options = {}) {
  return Object.freeze({
    type,
    required: options.required !== false,
    multiple: options.multiple === true,
  })
}

function definition(type, options = {}) {
  return Object.freeze({
    type,
    version: options.version || 1,
    label: options.label || type,
    inputs: Object.freeze({ ...(options.inputs || {}) }),
    outputs: Object.freeze({ ...(options.outputs || {}) }),
    source: options.source === true,
    resourcePolicy: Object.freeze({ ...(options.resourcePolicy || {}) }),
  })
}

const DEFINITIONS = [
  definition('io.text_input', {
    label: 'Text Input',
    source: true,
    outputs: { text: port('TextArtifact') },
  }),
  definition('io.voice_input', {
    label: 'Voice Input',
    source: true,
    outputs: { voice: port('VoiceRef') },
  }),
  definition('io.audio_input', {
    label: 'Audio Input',
    source: true,
    outputs: { audio: port('AudioArtifact') },
  }),
  definition('io.audio_output', {
    label: 'Audio Output',
    inputs: { audio: port('AudioArtifact') },
  }),
  definition('text.auto_language', {
    label: 'Auto Language Route',
    inputs: { text: port('TextArtifact') },
    outputs: {
      text: port('TextArtifact'),
      language_assignment: port('LanguageAssignment'),
      pronunciation_recipe: port('PronunciationRecipe', { required: false }),
    },
  }),
  definition('text.pronunciation_preview', {
    label: 'Pronunciation Preview',
    inputs: { text: port('TextArtifact') },
    outputs: {
      pronunciation: port('PronunciationRecipe'),
      preview: port('InferenceResult', { required: false }),
    },
  }),
  definition('review.human_gate', {
    label: 'Human Review Gate',
    inputs: {
      review_target: port('ArtifactRef', { multiple: true }),
    },
    outputs: {
      decision: port('GateDecision'),
      review_record: port('ReviewRecord'),
      approved: port('ArtifactRef', { required: false, multiple: true }),
      revised: port('ArtifactRef', { required: false, multiple: true }),
      rejected: port('ReviewRecord', { required: false }),
    },
  }),
  definition('tts.generate', {
    label: 'TTS Inference',
    inputs: {
      text: port('TextArtifact'),
      voice: port('VoiceRef'),
      recipe: port('ArtifactRef', { required: false, multiple: true }),
      language: port('LanguageAssignment', { required: false }),
    },
    outputs: {
      audio: port('AudioArtifact'),
      result: port('InferenceResult', { required: false }),
    },
    resourcePolicy: {
      requires_gpu: true,
      exclusive_gpu: true,
    },
  }),
  definition('quality.audio_basic', {
    label: 'Basic Audio Quality Gate',
    inputs: { audio: port('AudioArtifact') },
    outputs: {
      report: port('QualityReport'),
      decision: port('GateDecision'),
    },
  }),
  definition('audio.vocal_extract', {
    label: 'Vocal Extraction',
    inputs: { audio: port('AudioSet') },
    outputs: { vocals: port('AudioSet') },
    resourcePolicy: {
      requires_gpu: true,
      exclusive_gpu: true,
    },
  }),
  definition('audio.slice', {
    label: 'Slice Audio',
    inputs: { audio: port('AudioSet') },
    outputs: { slices: port('AudioSet') },
  }),
  definition('asr.transcribe', {
    label: 'ASR Transcribe',
    inputs: { audio: port('AudioSet') },
    outputs: { transcript: port('Transcript') },
    resourcePolicy: {
      requires_gpu: true,
      exclusive_gpu: true,
    },
  }),
  definition('text.preprocess', {
    label: 'Text Preprocess',
    inputs: { transcript: port('Transcript') },
    outputs: { training_asset: port('TrainingAsset') },
  }),
  definition('train.s1', {
    label: 'Train S1',
    inputs: { training_asset: port('TrainingAsset') },
    outputs: { checkpoint: port('ModelCheckpoint') },
    resourcePolicy: {
      requires_gpu: true,
      exclusive_gpu: true,
    },
  }),
  definition('train.s2', {
    label: 'Train S2',
    inputs: {
      training_asset: port('TrainingAsset'),
      s1_checkpoint: port('ModelCheckpoint'),
    },
    outputs: { checkpoint: port('ModelCheckpoint') },
    resourcePolicy: {
      requires_gpu: true,
      exclusive_gpu: true,
    },
  }),
  definition('asset.publish', {
    label: 'Publish Asset',
    inputs: {
      model: port('ModelCheckpoint', { multiple: true }),
      metadata: port('Recipe', { required: false }),
    },
    outputs: { asset: port('TrainingAsset') },
  }),
  definition('legacy.training_pipeline.v1', {
    label: 'Legacy Training Pipeline',
    inputs: { audio: port('AudioSet') },
    outputs: { asset: port('TrainingAsset') },
    resourcePolicy: {
      requires_gpu: true,
      exclusive_gpu: true,
    },
  }),
]

const REGISTRY = new Map(DEFINITIONS.map(item => [item.type, item]))

function getNodeDefinition(type, version = 1) {
  const item = REGISTRY.get(type)
  if (!item || item.version !== version) return null
  return item
}

function listNodeDefinitions() {
  return DEFINITIONS.slice()
}

function isKnownPortType(type) {
  return typeof type === 'string' && PORT_TYPES.includes(type)
}

function isArtifactType(type) {
  return ARTIFACT_TYPES.has(type)
}

function isHumanGateDecision(value) {
  return HUMAN_GATE_DECISIONS.includes(value)
}

module.exports = {
  ARTIFACT_TYPES,
  HUMAN_GATE_DECISIONS,
  PORT_TYPES,
  getNodeDefinition,
  isArtifactType,
  isHumanGateDecision,
  isKnownPortType,
  listNodeDefinitions,
}
