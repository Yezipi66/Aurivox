'use strict'

// 画布服务层：引擎、图库、运行记录都归这里管，上面的 HTTP 层只做翻译。
// 引擎需要外部提供的东西（合成、拼接、文件落哪）都在这里注入，因此引擎不用起
// 服务器就能测，服务器里也没有引擎内部的东西。

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

// 画布上「装了什么引擎就长什么样」的地方，数据全部从这里来。
// 名片是唯一真相：下游作者新建一个 engines/<id>/manifest.json，开画布时引擎下拉框里
// 就能选到它，「引擎参数」节点也会自动长出他 param_keys 里声明的格子，
// lib/、server.js、web/ 一个字不用改（契约 §2 的验收标准）。
// 放在这一层的原因：节点定义是 require 时就冻住的，而「装了哪些引擎」是运行时事实，
// describeDefinition 每次开画布重算一遍，正好是两者相遇的地方。
function engineChoices(engines) {
  return engines.map(m => ({
    value: m.id,
    label: docs.text(m.label || m.id, m.id),
  }))
}

// 「引擎参数」节点的格子 = 已装引擎 param_keys 的并集，减掉平台自己拿主意的
// 那几个（RESERVED_PARAM_KEYS）。
// 用并集而不是「当前选中引擎的那一份」：选引擎是另一个节点的事，两个节点可以没有
// 直接连线，服务器列目录时无从得知用户选了谁。改成全都给出来、但每个格子写清楚
// 哪几台引擎认它，填错了不会静悄悄失效，adapter.js 会带着键名拦下来。
// 老图不会因此坏掉：engine.js 用 Object.assign({}, def.params, node.params) 合并，
// 存盘的参数原样带着走，不需要这张表列过它。
function engineUnionParams(nodeType, engines, schemaFor) {
  const acceptedBy = new Map()
  // 键 → 名片里那条 schema（label / help / type / min / max …）。
  // 同一个键被两台引擎都声明时以先装的那台为准：这里只拿它的说明文字，
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
  // 排序三段：平台手写说明的资产字段（模型权重、参考音频）保持原有顺序；
  // 名片 params.schema 的声明顺序（作者按 common 在前、advanced 在后写的，
  // 本来就比字母序更像人排的）；只在 param_keys 里出现、名片没描述过的键按字母序兜底。
  // 这样装了一台新引擎不会让老用户的界面整个重排。
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
  // 名片的解析只有 profile.js 一处，registry.listEngines() 交出来的是生 JSON
  // （那里的 params.schema 还是个没校验过的对象）。所以格子的说明要经 paramTable
  // 走一趟解析器，而不是在这里自己读 manifest.params。
  // 留这条注入缝是为了测试：测试里的引擎是手里递进来的假名片，盘上没有对应目录，
  // 按 id 去解析必然找不到。
  const schemaFor = context.engineSchema || (m => engineUiSchema(m.id))
  const describePort = which => ([name, p]) => {
    const doc = docs.portDoc(def.type, name, which) || {}
    return {
      name,
      type: p.type,
      required: p.required,
      multiple: p.multiple,
      // 保留给还在读它的老代码；新的说明是 help 这个双语对。
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
        // 固定候选值：设置面板可以直接给一个列表，不必让人自己记住 '>=' 怎么写。
        // 'engines' 的候选项服务器自己就知道（engines/ 下装了什么），直接算好发下去。
        choices: pdoc.source === 'engines'
          ? engineChoices(engines)
          : (pdoc.choices || []).map(c => ({ value: c.value, label: docs.text(c.label, String(c.value)) })),
        // 服务器自己拥有的候选列表：'voices' 表示设置面板在打开时从 /api/voices 取。
        source: pdoc.source || null,
      }
    }).concat(def.dynamic_params === 'engine_union' ? engineUnionParams(def.type, engines, schemaFor) : []),
  }
}

// 保留成纯中文的常量，给还在导入它的老代码用；画布读的是 nodeCatalogue() 挂在
// 每个分类上的双语对。
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
    // 报告与引擎自己的运行记录放在一起，引擎不再管它之后仍然查得到。
    this.reports = new Map()
    this.maxReports = options.maxReports || 100
  }

  // -- 画布上能画的东西 -----------------------------------------------------

  nodeCatalogue() {
    // 每次重扫：新建一个 engines/<id>/ 目录后不用重启就能在画布上看见。
    // 名片坏掉时 listEngines() 会抛，让它抛：一个 JSON 语法错表现为
    // 「引擎莫名其妙消失了」比直接报错难查得多。
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

  // -- 图库 -----------------------------------------------------------------

  listGraphs() { return this.store.list() }
  loadGraph(graphId) { return this.store.load(graphId) }
  saveGraph(graph) { return this.store.save(graph) }
  deleteGraph(graphId) { return this.store.remove(graphId) }
  newGraph(name) { return emptyGraph(name) }

  // 只检查不运行是独立的一项操作：画布要在任何东西启动之前就能说出
  // 「这样跑不起来，原因是这个」。
  check(graph) {
    try {
      const result = validateGraph(normaliseGraph(graph))
      return { ok: result.ok, problems: result.problems || [] }
    } catch (error) {
      // 某些损坏（连到已不存在的节点）是在读图时发现的，还没进检查。
      // 那时抛异常会让检查在最需要它的时候没用，所以当成一条问题报进同一张列表。
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

  // -- 运行 -----------------------------------------------------------------

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

  // 失败的运行也是用户要看的运行，所以报告先归档再把错误抛上去，运行留在列表里。
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
 * 把服务接到服务器已有的 broker 上。这里不碰旧的生成路径：借用生成页调的那一个
 * 服务函数，画布和页面因此不会走偏。
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
    // 只有宿主真的提供了音色存储才有这个能力，保存音色的节点因此能说
    // 「本机未提供音色存储」而不是抛错。
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
