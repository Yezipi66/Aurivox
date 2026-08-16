'use strict'

// ---------------------------------------------------------------------------
//  Quality nodes — the threshold family
// ---------------------------------------------------------------------------
// Ruling: "门槛是质量门的核心理念，因为更清晰更容易定义". Not "pick the best":
// the machine draws a line, everything above the line is usable, and the last
// cut is the user's ears (that is what `select` is for).
//
// The division of labour is the important part and must not drift:
//   measure  -> only numbers, never a verdict
//   normalise/weight -> turn numbers into one 0-100 score
//   compare / filter -> where the line actually gets drawn
// The threshold value itself always comes from the graph, never from code,
// because the threshold is the user's taste.

const nodeFs = require('node:fs')

const { define, port } = require('./registry')
const acoustics = require('./acoustics')

function qualityError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// A "list" arrives in one of two shapes and the user should never have to care
// which: either several wires into one port (multiple), or a single wire
// carrying the list an 累加 node published. Flatten one level and both work.
function asList(value) {
  if (value === undefined) return []
  const outer = Array.isArray(value) ? value : [value]
  const flat = []
  for (const item of outer) {
    if (Array.isArray(item)) flat.push(...item)
    else flat.push(item)
  }
  return flat
}

function readAudio(item, fs, what) {
  const p = item && (item.path || (typeof item === 'string' ? item : null))
  if (!p) throw qualityError('FG_MEASURE_NO_PATH', `${what}没有文件路径，测不了`)
  if (!fs.existsSync(p)) {
    throw qualityError('FG_MEASURE_FILE_MISSING', `${what}找不到了：${p}（跑之前它还在，检查是不是被移动或改名了）`, { path: p })
  }
  return fs.readFileSync(p)
}

// ---------------------------------------------------------------------------
//  测量 — tier 1 and tier 2
// ---------------------------------------------------------------------------

define({
  type: 'quality.measure_basic',
  category: 'quality',
  label: '测量·基础（第一档）',
  inputs: {
    audio: port('Audio'),
    text: port('Text', { required: false }),
  },
  outputs: { metrics: port('Metrics') },
  params: { silence_db: -45 },
  handler: async ({ inputs, params, ctx }) => {
    const buffer = readAudio(inputs.audio, ctx.fs || nodeFs, '要测的音频')
    const metrics = acoustics.measureBasic(buffer, {
      text: inputs.text || (inputs.audio && inputs.audio.recipe && inputs.audio.recipe.text) || null,
      silenceDb: Number(params.silence_db),
    })
    // The measurement travels with what it measured, so a score table later can
    // still say WHICH clip a row is about.
    return { outputs: { metrics: Object.assign({ source: inputs.audio }, metrics) } }
  },
})

define({
  type: 'quality.measure_similarity',
  category: 'quality',
  label: '测量·像不像参考音（第二档）',
  inputs: {
    audio: port('Audio'),
    reference: port('ReferenceAudio'),
  },
  outputs: { metrics: port('Metrics') },
  handler: async ({ inputs, ctx }) => {
    const fs = ctx.fs || nodeFs
    const candidate = readAudio(inputs.audio, fs, '要测的音频')
    const reference = readAudio(inputs.reference, fs, '参考音频')
    const metrics = acoustics.measureSimilarity(candidate, reference)
    return { outputs: { metrics: Object.assign({ source: inputs.audio }, metrics) } }
  },
})

define({
  type: 'quality.read_metric',
  category: 'quality',
  label: '取一项指标',
  inputs: { metrics: port('Metrics') },
  outputs: { value: port('Number') },
  params: { name: 'duration_sec' },
  handler: async ({ inputs, params }) => {
    const name = params.name
    if (!(name in inputs.metrics)) {
      throw qualityError('FG_METRIC_UNKNOWN',
        `测量结果里没有叫「${name}」的项目。有的是：${Object.keys(inputs.metrics).filter(k => typeof inputs.metrics[k] === 'number').join('、')}`,
        { name })
    }
    const value = inputs.metrics[name]
    if (value === null) {
      throw qualityError('FG_METRIC_NOT_MEASURED', `「${name}」这一项这次没测出来（多半是缺了它需要的输入，比如没给文字就算不了语速）`, { name })
    }
    return { outputs: { value: Number(value) } }
  },
})

// ---------------------------------------------------------------------------
//  归一 / 打分 — different units, one 0-100 scale
// ---------------------------------------------------------------------------

define({
  type: 'quality.normalize',
  category: 'quality',
  label: '归一 / 打分（0~100）',
  inputs: { value: port('Number') },
  outputs: { score: port('Score') },
  // `good` is the value that deserves 100, `bad` the one that deserves 0.
  // Putting `good` BELOW `bad` is how "smaller is better" metrics (a distance,
  // a clipping ratio) are handled — no separate direction switch needed.
  params: { good: 0, bad: 1 },
  handler: async ({ inputs, params }) => {
    const good = Number(params.good)
    const bad = Number(params.bad)
    if (good === bad) {
      throw qualityError('FG_NORMALIZE_SAME_ENDS', '归一节点的「满分值」和「零分值」填成一样了，那没法打分')
    }
    const raw = Number(inputs.value)
    const ratio = (raw - bad) / (good - bad)
    const score = Math.max(0, Math.min(100, ratio * 100))
    return { outputs: { score: Math.round(score * 100) / 100 } }
  },
})

define({
  type: 'quality.weighted_score',
  category: 'quality',
  label: '加权汇总',
  inputs: { scores: port('Score', { multiple: true }) },
  outputs: { score: port('Score') },
  // The weights ARE the user's taste, which is exactly why they are a graph
  // parameter and not a constant in this file.
  params: { weights: null },
  handler: async ({ inputs, params }) => {
    const scores = asList(inputs.scores).map(Number)
    if (!scores.length) throw qualityError('FG_WEIGHTED_NO_SCORES', '加权汇总没有收到任何分数')
    const weights = Array.isArray(params.weights) && params.weights.length
      ? params.weights.map(Number)
      : new Array(scores.length).fill(1)
    if (weights.length !== scores.length) {
      throw qualityError('FG_WEIGHTED_LENGTH_MISMATCH',
        `接进来 ${scores.length} 个分数，但填了 ${weights.length} 个权重，对不上`,
        { scores: scores.length, weights: weights.length })
    }
    const total = weights.reduce((a, b) => a + b, 0)
    if (total <= 0) throw qualityError('FG_WEIGHTED_ZERO', '权重加起来是 0，除不了')
    const sum = scores.reduce((acc, s, i) => acc + s * weights[i], 0)
    return { outputs: { score: Math.round((sum / total) * 100) / 100 } }
  },
})

// ---------------------------------------------------------------------------
//  质量标准 — the weights and lines, saved and swappable like a recipe
// ---------------------------------------------------------------------------

define({
  type: 'quality.standard',
  category: 'quality',
  label: '质量标准（门槛 + 权重）',
  outputs: { standard: port('QualityStandard') },
  params: { name: '默认标准', pass_score: 80, weights: null, limits: null },
  handler: async ({ params }) => ({
    outputs: {
      standard: {
        kind: 'quality_standard',
        name: params.name || '默认标准',
        pass_score: Number(params.pass_score),
        weights: params.weights || null,
        limits: params.limits || null,
      },
    },
  }),
})

define({
  type: 'quality.threshold',
  category: 'quality',
  label: '门槛判定',
  inputs: {
    score: port('Score'),
    standard: port('QualityStandard', { required: false }),
  },
  outputs: { pass: port('Boolean'), score: port('Score') },
  params: { pass_score: 80 },
  handler: async ({ inputs, params }) => {
    const line = inputs.standard && inputs.standard.pass_score !== undefined
      ? Number(inputs.standard.pass_score)
      : Number(params.pass_score)
    const score = Number(inputs.score)
    // Note what this node does NOT do: it does not retry, it does not pick a
    // winner, it does not decide what happens next. It puts out a 0 or a 1.
    // Wire the 0 to another seed, or to 释放 — that choice is the user's.
    return { outputs: { pass: score >= line ? 1 : 0, score } }
  },
})

// ---------------------------------------------------------------------------
//  列表过滤 — a whole batch at once, because compare only judges one
// ---------------------------------------------------------------------------

define({
  type: 'quality.filter_list',
  category: 'quality',
  label: '列表过滤',
  inputs: {
    items: port('Any'),
    scores: port('Any'),
    standard: port('QualityStandard', { required: false }),
  },
  outputs: {
    kept: port('Any'),
    dropped: port('Any'),
    kept_indices: port('IndexList'),
    kept_count: port('Number'),
  },
  params: { pass_score: 80 },
  handler: async ({ inputs, params }) => {
    const items = Array.isArray(inputs.items) ? inputs.items : [inputs.items]
    const scores = (Array.isArray(inputs.scores) ? inputs.scores : [inputs.scores]).map(Number)
    if (items.length !== scores.length) {
      throw qualityError('FG_FILTER_LENGTH_MISMATCH',
        `有 ${items.length} 个候选，却只有 ${scores.length} 个分数，对不上号（多半是分数那条线没跟着循环一起攒）`,
        { items: items.length, scores: scores.length })
    }
    const line = inputs.standard && inputs.standard.pass_score !== undefined
      ? Number(inputs.standard.pass_score)
      : Number(params.pass_score)
    const kept = []
    const dropped = []
    const keptIndices = []
    items.forEach((item, i) => {
      if (scores[i] >= line) { kept.push(item); keptIndices.push(i) } else dropped.push(item)
    })
    // The dropped ones are handed out too, on purpose: "不接不等于结束" — if the
    // user wants to see them, or release them, there is a port to wire.
    return { outputs: { kept, dropped, kept_indices: keptIndices, kept_count: kept.length } }
  },
})

define({
  type: 'quality.top_k',
  category: 'quality',
  label: '排序取前几（可选，不是主线）',
  inputs: { items: port('Any'), scores: port('Any') },
  outputs: { top: port('Any'), top_indices: port('IndexList') },
  params: { k: 1 },
  handler: async ({ inputs, params }) => {
    const items = Array.isArray(inputs.items) ? inputs.items : [inputs.items]
    const scores = (Array.isArray(inputs.scores) ? inputs.scores : [inputs.scores]).map(Number)
    if (items.length !== scores.length) {
      throw qualityError('FG_TOPK_LENGTH_MISMATCH', `有 ${items.length} 个候选，却只有 ${scores.length} 个分数`, {})
    }
    const k = Math.max(1, Math.min(items.length, Number(params.k) || 1))
    const order = items.map((_, i) => i).sort((a, b) => scores[b] - scores[a]).slice(0, k)
    return { outputs: { top: order.map(i => items[i]), top_indices: order } }
  },
})

// ---------------------------------------------------------------------------
//  看得见 — otherwise the threshold is a black box
// ---------------------------------------------------------------------------

const NUMERIC_ONLY = value => value !== null && typeof value === 'number'

define({
  type: 'quality.score_table',
  category: 'quality',
  label: '分数表',
  inputs: {
    metrics: port('Any', { multiple: true }),
    scores: port('Any', { required: false, multiple: true }),
    standard: port('QualityStandard', { required: false }),
  },
  outputs: { table: port('Table') },
  params: { columns: null, pass_score: 80 },
  handler: async ({ inputs, params, ctx, node }) => {
    const rows = asList(inputs.metrics)
    const scores = inputs.scores === undefined ? null : asList(inputs.scores).map(Number)
    const line = inputs.standard && inputs.standard.pass_score !== undefined
      ? Number(inputs.standard.pass_score)
      : Number(params.pass_score)

    const columns = Array.isArray(params.columns) && params.columns.length
      ? params.columns
      : [...new Set(rows.flatMap(r => Object.keys(r || {}).filter(k => NUMERIC_ONLY(r[k]))))]

    const table = {
      kind: 'table',
      pass_score: line,
      columns: ['#', ...columns, ...(scores ? ['总分', '结果'] : [])],
      rows: rows.map((row, i) => {
        const cells = { '#': i + 1 }
        for (const column of columns) cells[column] = row ? row[column] : null
        if (scores) {
          cells['总分'] = scores[i]
          // Why it was dropped is visible right here, in the same row.
          cells['结果'] = scores[i] >= line ? '通过' : `未通过（低于及格线 ${Math.round((line - scores[i]) * 100) / 100} 分）`
        }
        return cells
      }),
    }
    ctx.emit('table', { node_id: node.id, table })
    return { outputs: { table } }
  },
})

define({
  type: 'quality.check_recipe',
  category: 'quality',
  label: '看配方',
  inputs: { audio: port('Any') },
  outputs: { recipe: port('Recipe') },
  handler: async ({ inputs, ctx, node }) => {
    const items = Array.isArray(inputs.audio) ? inputs.audio : [inputs.audio]
    // "必须带着「我是用什么设置生成的」一起走" — the adapter attaches the recipe
    // to every clip it makes, so this node is a read, never a lookup elsewhere.
    const recipes = items.map((item, i) => {
      if (!item || !item.recipe) {
        throw qualityError('FG_RECIPE_MISSING',
          `第 ${i + 1} 条音频身上没有配方（它多半不是这张图合成出来的，是从外面读进来的文件）`,
          { index: i })
      }
      return item.recipe
    })
    const recipe = recipes.length === 1 ? recipes[0] : recipes
    ctx.emit('recipe', { node_id: node.id, recipe })
    return { outputs: { recipe } }
  },
})

module.exports = { acoustics }
