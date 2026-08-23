'use strict'

// ---------------------------------------------------------------------------
//  Flowgraph service — one place that owns the engine, the graph library and
//  the list of runs, so the HTTP layer above stays a translator and nothing else
// ---------------------------------------------------------------------------
// Everything the engine needs from the outside world (synthesis, concat, where
// files go) is injected here. That is what keeps the engine testable without a
// server and the server free of engine internals.

const path = require('node:path')
const fs = require('node:fs')

const { FlowEngine, RUN_STATES, validateGraph } = require('./engine')
const { GraphStore, normaliseGraph, emptyGraph, SCHEMA_VERSION } = require('./graphStore')
const { listDefinitions } = require('./registry')
const { createSynthesizeAdapter, createConcatAdapter, createSaveVoiceAdapter, RESERVED_PARAM_KEYS } = require('./adapter')
const docs = require('./docs')
const engineRegistry = require('../engines/registry')
// 契约 C11：参数表只有一份。格子的名字和说明都从名片来。
const { engineUiSchema } = require('../engines/paramTable')

// A canvas needs more than a type name to draw a node: it needs the ports, their
// types (so a wire can be refused before it is dropped), the params with their
// defaults (so a freshly dragged node is already usable) — and, since 2026-08-16,
// a sentence for every one of those in both interface languages.
//
// The prose lives in docs.js rather than in the node definitions so that the
// engine files stay about running things; docs.node.test.js is what keeps the
// two from drifting apart.
// 画布上那些「装了什么引擎就长什么样」的地方，数据全部从这里来。
//
// 一句话：**名片是唯一真相**。下游作者新建一个
// engines/<id>/manifest.json，开画布时就能在引擎下拉框里选到它，
// 并且「引擎参数」节点会自动长出他 param_keys 里声明的格子 ——
// lib/、server.js、web/ 一个字不用改。这就是契约 §2 的验收标准。
//
// 为什么放在这一层：节点定义（nodes.js）是 require 时就冻住的，而「装了
// 哪些引擎」是运行时事实（新建一个目录就变）。describeDefinition 每次
// 开画布都重算一遍，正好是两者相遇的地方。
function engineChoices(engines) {
  return engines.map(m => ({
    value: m.id,
    label: docs.text(m.label || m.id, m.id),
  }))
}

// 「引擎参数」节点的格子 = 已装引擎 param_keys 的**并集**，减掉平台自己
// 拿主意的那几个（RESERVED_PARAM_KEYS）。
//
// 为什么是并集而不是「当前选中引擎的那一份」：选引擎是另一个节点的
// 事，两个节点可以没有直接连线，服务器在列目录时无从得知用户选了谁。
// 所以改用「全都给出来，但每个格子写清楚哪几台引擎认它」——
// 填错了不会静悄悄失效，adapter.js 会带着键名拦下来。
//
// 老图不会因此坏掉：engine.js 用 Object.assign({}, def.params, node.params)
// 合并，存盘的参数原样带着走，不需要这张表列过它。
function engineUnionParams(nodeType, engines, schemaFor) {
  const acceptedBy = new Map()
  // 键 → 名片里那条 schema（label / help / type / min / max …）。
  // 同一个键被两台引擎都声明时以先装的那台为准：这里只拿它的**说明文字**，
  // 而两台引擎对同一个参数的解释不会差到需要分别显示。
  const schemaOf = new Map()
  for (const manifest of engines) {
    for (const entry of schemaFor(manifest)) {
      if (!schemaOf.has(entry.name)) schemaOf.set(entry.name, entry)
    }
    for (const key of manifest.param_keys || []) {
      if (RESERVED_PARAM_KEYS.includes(key)) continue
      if (!acceptedBy.has(key)) acceptedBy.set(key, [])
      acceptedBy.get(key).push(docs.text(manifest.label || manifest.id, manifest.id))
    }
  }
  // 排序三段：
  //   1. 平台手写说明的资产字段（模型权重 / 参考音频），保持原有顺序
  //   2. 名片 params.schema 的**声明顺序** —— 作者是按 common 在前、
  //      advanced 在后写的，那本来就比字母序更像人排的
  //   3. 只在 param_keys 里出现、名片没描述过的键，按字母序兜底
  // 让老用户的界面不会因为装了一台新引擎就整个重排。
  const documented = Object.keys((docs.NODE_DOCS[nodeType] || {}).params || {})
  const declared = [...schemaOf.keys()].filter(k => acceptedBy.has(k) && !documented.includes(k))
  const seen = new Set([...documented, ...declared])
  const rest = [...acceptedBy.keys()].filter(k => !seen.has(k)).sort()
  const ordered = [...documented.filter(k => acceptedBy.has(k)), ...declared, ...rest]
  return ordered.map(name => {
    const labels = acceptedBy.get(name)
    const entry = schemaOf.get(name) || null
    const doc = docs.engineParamDoc(nodeType, name, labels.map(l => l.zh), engines.length, entry)
    const docEn = docs.engineParamDoc(nodeType, name, labels.map(l => l.en), engines.length, entry)
    return {
      name,
      default: null,
      label: docs.text(doc.label, name),
      help: { en: docEn.help.en, zh: doc.help.zh },
      choices: [],
      source: null,
      // 机器可读的「哪几台认它」，给以后的界面用。
      engines: engines.filter(m => (m.param_keys || []).includes(name)).map(m => m.id),
    }
  })
}

function describeDefinition(def, context = {}) {
  const engines = context.engines || []
  // 名片的**解析**只有 profile.js 一处，registry.listEngines() 交出来的是
  // 生 JSON（那里的 params.schema 还是个没校验过的对象）。所以格子的说明
  // 要经 paramTable 走一趟解析器，而不是在这里自己读 manifest.params。
  //
  // 留这条注入缝的理由和 synthesisService.js:17 一样：测试里的引擎是**手里
  // 递进来的**假名片，盘上没有对应目录，按 id 去解析必然找不到。
  const schemaFor = context.engineSchema || (m => engineUiSchema(m.id))
  const describePort = which => ([name, p]) => {
    const doc = docs.portDoc(def.type, name, which) || {}
    return {
      name,
      type: p.type,
      required: p.required,
      multiple: p.multiple,
      // Kept for anything already reading it; the bilingual pair is `help`.
      description: p.description || '',
      label: docs.text(doc.label, name),
      help: docs.text(doc.help, ''),
      type_help: docs.portTypeDoc(p.type),
    }
  }
  const doc = docs.nodeDoc(def.type) || {}
  return {
    type: def.type,
    category: def.category || 'other',
    label: docs.text(doc.label, def.label || def.type),
    help: docs.text(doc.help, ''),
    suspends: def.suspends === true,
    control: def.control || null,
    inputs: Object.entries(def.inputs).map(describePort('input')),
    outputs: Object.entries(def.outputs).map(describePort('output')),
    params: Object.entries(def.params).map(([name, value]) => {
      const pdoc = docs.paramDoc(def.type, name) || {}
      return {
        name,
        default: value,
        label: docs.text(pdoc.label, name),
        help: docs.text(pdoc.help, ''),
        // A fixed set of allowed values, so the settings panel can offer a list
        // instead of asking someone to remember that '>=' is spelled that way.
        // 'engines' 的候选项服务器自己就知道（就是 engines/ 下装了什么），
        // 直接算好发下去，前端不用再多跑一趟。
        choices: pdoc.source === 'engines'
          ? engineChoices(engines)
          : (pdoc.choices || []).map(c => ({ value: c.value, label: docs.text(c.label, String(c.value)) })),
        // A list the server owns rather than a fixed one — 'voices' means the
        // settings panel fills the dropdown from /api/voices at open time.
        source: pdoc.source || null,
      }
    }).concat(def.dynamic_params === 'engine_union' ? engineUnionParams(def.type, engines, schemaFor) : []),
  }
}

// Kept as plain Chinese strings for anything already importing it; the canvas
// reads the bilingual pair that nodeCatalogue() puts on each category.
const CATEGORY_LABELS = Object.freeze({
  load: '输入 / 载入',
  process: '处理',
  logic: '逻辑',
  loop: '循环',
  quality: '质量门',
  sink: '输出 / 落地',
  other: '其他',
})

function serviceError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

class FlowgraphService {
  constructor(options = {}) {
    this.fs = options.fs || fs
    this.rootDir = options.rootDir || path.join(process.cwd(), 'data', 'flowgraph')
    this.outputDir = options.outputDir || path.join(this.rootDir, 'outputs')
    this.stateDir = options.stateDir || path.join(this.rootDir, 'state')
    this.store = options.store || new GraphStore({ dir: options.graphDir || path.join(this.rootDir, 'graphs'), fs: this.fs })
    this.engine = options.engine || new FlowEngine({
      fs: this.fs,
      outputDir: this.outputDir,
      stateDir: this.stateDir,
      synthesize: options.synthesize || null,
      concatAudio: options.concatAudio || null,
      saveVoice: options.saveVoice || null,
      releaseVram: options.releaseVram || null,
    })
    // Reports are kept beside the engine's own runs so a finished run can still
    // be looked up after the engine has stopped caring about it.
    this.reports = new Map()
    this.maxReports = options.maxReports || 100
  }

  // -- what the canvas can draw ---------------------------------------------

  nodeCatalogue() {
    // 每次重扫：新建一个 engines/<id>/ 目录后不用重启就能在画布上看见。
    // 名片坏掉时 listEngines() 会抛，富少得让它抛 —— 一个 JSON 语法错
    // 表现为「引擎莫名其妙消失了」比直接报错难查得多。
    const engines = engineRegistry.listEngines()
    const definitions = listDefinitions().map(def => describeDefinition(def, { engines }))
    const byCategory = new Map()
    for (const def of definitions) {
      if (!byCategory.has(def.category)) byCategory.set(def.category, [])
      byCategory.get(def.category).push(def)
    }
    return {
      schema_version: SCHEMA_VERSION,
      count: definitions.length,
      categories: [...byCategory.entries()].map(([id, nodes]) => ({
        id,
        label: docs.text(docs.categoryDoc(id).label, CATEGORY_LABELS[id] || id),
        help: docs.text(docs.categoryDoc(id).help, ''),
        nodes: nodes.sort((a, b) => a.type.localeCompare(b.type)),
      })).sort((a, b) => {
        const order = Object.keys(CATEGORY_LABELS)
        return order.indexOf(a.id) - order.indexOf(b.id)
      }),
    }
  }

  // -- the graph library -----------------------------------------------------

  listGraphs() { return this.store.list() }
  loadGraph(graphId) { return this.store.load(graphId) }
  saveGraph(graph) { return this.store.save(graph) }
  deleteGraph(graphId) { return this.store.remove(graphId) }
  newGraph(name) { return emptyGraph(name) }

  // Checking without running is its own operation on purpose: the canvas should
  // be able to say "this will not run, and here is why" before anything starts.
  check(graph) {
    try {
      const result = validateGraph(normaliseGraph(graph))
      return { ok: result.ok, problems: result.problems || [] }
    } catch (error) {
      // Some breakages (a wire to a node that no longer exists) are found while
      // the graph is being read, before checking even starts. A checker that
      // throws there would be useless exactly when it is most needed, so it is
      // reported as one more problem in the same list.
      return {
        ok: false,
        problems: [{
          code: error.code || 'FG_GRAPH_UNREADABLE',
          node_id: error.node_id || null,
          message: error.message,
        }],
      }
    }
  }

  // -- running ---------------------------------------------------------------

  async start(graphOrId, options = {}) {
    const graph = typeof graphOrId === 'string' ? this.loadGraph(graphOrId) : normaliseGraph(graphOrId)
    return this._keepEvenIfItFails(() => this.engine.start(graph, options), graph)
  }

  async resume(runId, value) {
    if (!this.engine.get(runId)) {
      throw serviceError('FG_RUN_UNKNOWN', `没有编号为 ${runId} 的运行（服务器重启过的话，之前那次就断了）`, { run_id: runId })
    }
    return this._keepEvenIfItFails(() => this.engine.resume(runId, value))
  }

  // A failed run is still a run the user wants to look at — that is the whole
  // point of not releasing its memory. So the report is filed before the error
  // is passed up, and the run stays visible in the list.
  async _keepEvenIfItFails(work, graph = null) {
    try {
      return this._remember(await work(), graph)
    } catch (error) {
      if (error && error.run_id) {
        const report = this.engine.report(error.run_id)
        if (report) this._remember(report, graph)
      }
      throw error
    }
  }

  report(runId) {
    const live = this.engine.report(runId)
    if (live) return live
    const kept = this.reports.get(runId)
    if (!kept) throw serviceError('FG_RUN_UNKNOWN', `没有编号为 ${runId} 的运行`, { run_id: runId })
    return kept
  }

  listRuns() {
    return [...this.reports.values()].map(r => ({
      run_id: r.run_id,
      status: r.status,
      graph_name: r.graph_name || null,
      waiting_for: r.pending ? r.pending.node_id : null,
      live_values: r.live_values,
    }))
  }

  _remember(report, graph = null) {
    if (graph) report.graph_name = graph.name
    else if (this.reports.has(report.run_id)) report.graph_name = this.reports.get(report.run_id).graph_name
    this.reports.set(report.run_id, report)
    while (this.reports.size > this.maxReports) {
      this.reports.delete(this.reports.keys().next().value)
    }
    return report
  }
}

/**
 * Wire the service to the broker the server already has. Nothing here reaches
 * into the legacy generate path: it borrows the same service function the
 * generate page calls, so the canvas and the page cannot drift apart.
 */
function createFlowgraphService(ctx, deps = {}) {
  const rootDir = deps.rootDir || path.join(ctx.DATA_DIR || ctx.APP_DIR || process.cwd(), 'flowgraph')
  const outputRoot = deps.outputRoot || ctx.OUTPUT_DIR || null

  const synthesize = deps.generateService
    ? createSynthesizeAdapter(deps.generateService, { outputRoot, fs: deps.fs })
    : null
  const concatAudio = deps.concatWavFiles
    ? createConcatAdapter(deps.concatWavFiles, {
      outputDir: path.join(outputRoot || rootDir, 'flowgraph'),
      fs: deps.fs,
    })
    : null

  return new FlowgraphService({
    fs: deps.fs,
    rootDir,
    outputDir: path.join(outputRoot || rootDir, 'flowgraph'),
    synthesize,
    concatAudio,
    // Present only when the host actually has a voice store, which is what lets
    // the save-voice node say "本机未提供音色存储" instead of throwing.
    saveVoice: deps.saveVoice || createSaveVoiceAdapter(ctx),
    releaseVram: deps.releaseVram || null,
  })
}

module.exports = {
  FlowgraphService,
  createFlowgraphService,
  describeDefinition,
  CATEGORY_LABELS,
  RUN_STATES,
}
