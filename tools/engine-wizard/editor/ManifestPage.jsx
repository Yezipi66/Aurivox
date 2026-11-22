// 名片编辑页：左欄参数池、中欄表单、右侧预览。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import ManifestForm from './ManifestForm'
import ModeCards from './ModeCards'
import Diagnostics from './Diagnostics'
import PanelPreview from './PanelPreview'
import Stage from './Stage'
import StepCard from './StepCard'
import EngineScanZone from './EngineScanZone'
import EngineIdentity from './EngineIdentity'
import { computeCliFill, computePythonFill, withPythonEntryFromScan } from './scanAutofill'
import { modelFilesOf } from './declarationFill'
import { PARAM_MIME, dragLabelOf, isParamTaken, addParamsFromScan, syncParamsFromScan, scanParamFor } from './paramDrop'
import { entryFileOf } from './entryChoiceField'
import { scopeParams } from './paramScope'
import { loadSession, saveSession } from './useInstallSession'

// 名片编辑页：左边条、中栏、右边条，三根平级的骨头，铺满整个页面宽度。
//
// 左边条里是扫到的参数，中栏是当前名片内容，右边条里是当前项目的前端预览。
// 左右两根边条默认收成 32px 的窄边，只露一个方向箭头；点一下滑出成抽屉，
// 两根边条都 sticky 在视口里，跟着页面滚动。右边条还能放大到平台前端的宽度。
// 中栏内容对齐平台的大容器（max-width 1400px）。
//
// 没有吸底的存盘栏：选引擎 / 扫描或读取 / 保存都在中栏顶部的身份条上。
//
// 视图切换（填表 / JSON）留在中栏里：JSON 是名片的同一份内容的另一种写法，
// 不是第四栏。切到 JSON 时中栏的内容换掉，左栏与右栏不动。
//
// 扫描状态在这一层持有：左栏要显示扫到的参数，中栏要显示自动填的结果，
// 右栏要跟着名片的每一次改动实时更新。三者共用一份名片，改一处三处同步。

export default function ManifestPage ({
  manifest, spec, text, err, setText, onManifest, diag, loading, onSaved, checkpointsPath,
  modelFiles, onRefreshInstall, engineState, onPickEngineTarget, frame, dirs, onDirsReload,
}) {
  const { t } = useT()
  // 步骤大框的头由外层按固定步骤传进来；单测直接渲染本组件时不传，给一份等价兜底。
  const stepFrame = frame || { title: t('Write manifest', '填写名片'), done: false, onClose: () => {} }
  // 「扫描参数」的可用条件：这台引擎在盘上已经有名片，且表单里已经有内容。
  //   没有名片时扫描没有写回的地方，那种情况由身份条上的「新建名片」承担；
  //   有名片但还没读进来时，扫描会在一份空表单上做合并，结果与磁盘那一份不一致。
  const manifestDir = (dirs || []).find((d) => d.id === ((manifest && manifest.id) || ''))
  const canScan = !!(manifestDir && manifestDir.manifestPresent &&
    manifest && (manifest.call || manifest.runtime))
  const [view, setView] = React.useState('form')
  // 哪边的抽屉开着。左栏进来就张开：参数池是这一步接下来要拖的东西。
  //   右栏（预览）默认收着：它现在是浮在中栏之上的，张开就盖住表单右边那一列，
  //   而预览是「想看才看」的东西，不该一进门就挡住正在填的格子。
  //   收着的时候是一条约 32px 的窄边，点箭头就滑出来。
  const [drawer, setDrawer] = React.useState({ left: true, right: false })
  const toggleDrawer = (key) => setDrawer((prev) => ({ ...prev, [key]: !prev[key] }))
  // 右侧预览抽屉是否全屏：提到这一层，全屏时让「检查结果」面板退出抽屉，
  // 抽屉里只留预览本身：全屏是为了按平台真实尺寸查看，不应被诊断条目挤占。
  const [rightFull, setRightFull] = React.useState(false)

  // 当前引擎 id：名片定了用它，没定就是空（还没选引擎）。
  const engineKey = (manifest && manifest.id) || ''

  // ---- 扫描状态 ----
  // 按引擎存会话段：参数池走一次 /wizard/discover 要往返，切页回来不该再等。
  //   guessed 是 Set，会话段里存数组，读回来包成 Set。
  const saved = engineKey ? (loadSession(engineKey) || {}) : {}
  const [scan, setScan] = React.useState(saved.scan || null)
  const [group, setGroup] = React.useState(saved.group || '')
  const [poolAll, setPoolAll] = React.useState(saved.poolAll === true)
  const [busy, setBusy] = React.useState(false)       // 扫描中
  const [scanErr, setScanErr] = React.useState(saved.scanErr || null)
  const [selected, setSelected] = React.useState(saved.selected || null)
  const [autofill, setAutofill] = React.useState(saved.autofill || null)
  // 拖进来时类型是猜的那些参数名：中栏那一行的类型下拉标黄，提醒人确认。
  //   只是界面状态，不写进名片。
  const [guessed, setGuessed] = React.useState(() => new Set(saved.guessed || []))

  // 形态换了（命令行 ⇄ Python 类）：上一种形态的扫描结果全部作废。
  //   参数池、分组、选中项、自动填结果都是按上一种形态扫出来的，留着会让人
  //   在「Python 类」下拖到 --train_data 这类命令行开关。换引擎不算形态变化，
  //   那一份由下面的恢复逻辑接管。
  const kindNow = (manifest && manifest.call && manifest.call.kind) || null
  const kindSeen = React.useRef({ engineKey: null, kind: null })
  React.useEffect(() => {
    const prev = kindSeen.current
    if (prev.engineKey === engineKey && prev.kind && kindNow && kindNow !== prev.kind) {
      setScan(null)
      setGroup('')
      setSelected(null)
      setAutofill(null)
      setScanErr(null)
      // 类型靠猜的参数名也是上一形态的：留着会把新形态的行标黄，误导人去确认。
      setGuessed(new Set())
    }
    kindSeen.current = { engineKey, kind: kindNow }
  }, [engineKey, kindNow])

  // 换引擎：读那台自己的扫描状态，没有存档就清空。
  //   恢复态与写回 effect 同批执行时写回会拿到上一台的 state，
  //   用这个 ref 记下「这一帧在恢复」，写回跳过一次。
  const restoringFor = React.useRef(null)
  React.useEffect(() => {
    if (!engineKey) return
    const s = loadSession(engineKey) || {}
    restoringFor.current = engineKey
    // 存档里的扫描结果按当时的形态扫出来。形态换了以后这批结果整份作废：
    //   cli 的开关表在 python 页里拖到合成参数上，就是「左栏 12 个、表里 100+」的来源。
    //   source 为 both 或缺失时说明是旧版本存的，无法判定，照常恢复（不替人猜）。
    const savedKind = s.scan && (s.scan.source === 'cli' || s.scan.source === 'python')
      ? s.scan.source : null
    const kindAtRestore = (manifest && manifest.call && manifest.call.kind) || null
    const stale = savedKind && kindAtRestore && savedKind !== kindAtRestore
    setScan(stale ? null : (s.scan || null))
    setGroup(stale ? '' : (s.group || ''))
    setSelected(stale ? null : (s.selected || null))
    setAutofill(stale ? null : (s.autofill || null))
    setScanErr(stale ? null : (s.scanErr || null))
    setGuessed(stale ? new Set() : new Set(s.guessed || []))
    setPoolAll(stale ? false : (s.poolAll === true))
  }, [engineKey])

  // 写回会话段：只存扫描派生出来的界面状态，名片本体仍以盘上的为准。
  React.useEffect(() => {
    if (!engineKey) return
    if (restoringFor.current === engineKey) {
      restoringFor.current = null
      return
    }
    saveSession(engineKey, '', {
      scan, group, poolAll, scanErr, selected, autofill,
      guessed: [...guessed],
    })
  }, [engineKey, scan, group, poolAll, scanErr, selected, autofill, guessed])

  // 扫描到的参数按当前分组过滤。没有分组时给全部。
  // 认出推理入口后先收窄到入口文件：训练、微调脚本的参数混在池子里时，
  //   真正属于推理的那十几个要在一百多个里翻。收窄的依据与数量摆在左栏，
  //   由使用者一键切回全量（见 EngineScanZone）。
  const scanned = (scan && scan.params) || []
  const entryCands = (scan && scan.entry_candidates) || []
  const entryForPool = entryFileOf(manifest || {}, entryCands) ||
    ((scan && scan.entry && scan.entry.file) || '')
  // 先按分组过滤再收窄：左栏那句「只列出 N 个」必须与下面真正列出来的条数一致。
  //   两步都是筛选，顺序换过来结果相同，但数量与列表对得上才对得上人的理解。
  const grouped = group ? scanned.filter((p) => p.group === group) : scanned
  const scope = scopeParams(grouped, entryForPool)
  const pool = poolAll ? grouped : scope.params
  const params = pool

  // 「按扫描结果定类型」用的那份清单：入口文件的参数排前面。
  //   同一个开关在多个脚本里各有一份，内容还可能不同：--model-name 在推理入口是
  //   zipvoice / zipvoice_distill，在 runtime/nvidia_triton 的客户端脚本里是另一组模型名。
  //   只按扫描顺序取第一条，会把工具脚本上的那份铺成选项表。
  // 排完入口之后再接全量（含别的子命令）：手敲一个属于别的子命令的开关时，
  //   清单里得有它，类型才补得上。只给「入口 + 当前分组」时，那类开关在清单里
  //   查不到，于是静默停在 text，而它的类型上游明明写了。
  const shapeSource = scope.params.length
    ? [...scope.params, ...scanned.filter((p) => !scope.params.includes(p))]
    : scanned

  // 左栏哪张卡已经有归属：必填参数区的 bind 槽位、可选能力 / 引擎配置的 role 槽位、
  //   合成参数区已经有的那一行。三处与「把列出的参数一起加入」共用同一条判据
  //   （paramDrop.js 的 isParamTaken），不各写一份。
  //   判据不看「call.args 里有没有这条」：扫描会把入口文件的开关全写进 call.args
  //   当命令行映射，那只是映射，不等于已经有了格子。
  //   弱化卡片只为提示，不阻止再次拖动：同一个参数可能同时喂两个槽位（正文与参考文本），
  //   也可能拖错格后要拖走。
  const usedParam = (p) => isParamTaken(manifest, p)

  // text 是 manifest 的纯派生：只有「切进 JSON 视图」这一刻现算，
  //   之后就是用户手里的编辑缓冲。
  //   不用 useEffect 同步：那会形成 manifest→text→manifest 的回环。
  //   只在「之前没编过」(text===null) 时才覆盖，编过就保留缓冲。
  const switchTo = (v) => {
    if (v === 'json' && text === null) {
      setText(JSON.stringify(manifest || {}, null, 2))
    }
    setView(v)
  }

  // 扫描：调 /wizard/discover 自动探测形态，扫出参数表，
  // 同时把能对应的填进名片 call 段。
  //
  // 已有名片的引擎：自动填只填空缺，不覆盖名片里已有的内容。
  // 名片里原有的 call.args 原样保留，扫到的参数只是列在左栏让用户自己挑。
  // 扫描要跨一次 await：回来时用这个读最新名片，不用闭包里点按钮那一刻的旧值。
  const latestManifest = React.useRef(manifest)
  latestManifest.current = manifest
  // writeBack=false：只把扫描结果摆到界面上（参数池、入口候选、位置参数），
  //   不往名片里写。进页面时自动跑的那一次用它，打开就替人改名片不是这里的职责。
  // quiet=true：这是背景里跑的一次，失败不弹错误。人没点扫描，目录还没克隆、
  //   Python 还没装好这类情形都会失败，把红字甩给他只是噪音；他点按钮时同样会看到。
  const doScan = async (opts) => {
    const writeBack = !(opts && opts.writeBack === false)
    const quiet = !!(opts && opts.quiet)
    const id = (manifest && manifest.id) || ''
    if (!id) return
    if (!quiet) { setBusy(true); setScanErr(null) }
    try {
      // 带上当前形态：扫描按它只交一条路的参数。cli 的开关表与 python 的方法签名
      //   是两套东西，混着返回就只能在前端再筛一遍，而那一筛迟早漏。
      const kindAsked = (latestManifest.current && latestManifest.current.call &&
        latestManifest.current.call.kind) || null
      const r = await fetch('/wizard/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, kind: kindAsked }),
      })
      const j = await r.json()
      if (!j.ok) { if (!quiet) setScanErr(j.error || `HTTP ${r.status}`); return }
      setScan(j)
      // 扫到了就把左边条打开：参数是这一步接下来要拖的东西。
      setDrawer((prev) => ({ ...prev, left: true }))
      const inferGroups = (j.groups || []).filter((s) => /synth|infer|tts|generate|call/i.test(s))
      const picked = inferGroups[0] || (j.groups || [])[0] || ''
      setGroup(picked)
      const pickedParams = (j.params || []).filter((p) => !picked || p.group === picked)
      // 位置参数（命令行上没有开关名）：同一套筛法，选中的子命令之外的不接。
      const pickedPositionals = (j.positionals || []).filter((x) => !picked || x.group === picked)
      // 反射器剔掉的 bind 槽位候选（text / output_path / output_dir）：不在 params 里，
      //   但认 call.bind 的槽位靠的就是这些名字。传进去，output_path 才填得出来。
      const bindCands = j.bind_candidates || []
      // 入口嗅探结果：填进 call.argv 的模块名与子命令。为 null 时 argv 里留占位符，
      //   由使用者自己填（扫不出入口的引擎仍然要能配）。
      const entryPick = j.entry || null
      // 可选能力的嗅探建议（音频类输入 / 多权重位 / 输出格式）。只作建议，
      //   名片里已经写了的声明一律不覆盖，见下面写回那一段。
      const declareHints = j.declare_hints || null
      // 扫描回来时名片可能已经变了（等结果期间的代填、使用者的编辑）：
      //   读最新名片算匹配结果，写回也基于最新值合并，不拿点按钮那一刻的快照整份写回。
      const latest = latestManifest.current || {}
      if ((latest.id || '') !== id) return          // 等结果期间换了引擎：这次扫描作废
      // 点扫描这一刻重读盘上现状：页面加载时的快照会过时（权重刚下完、或第 3 步又下了
      //   一个仓库），拿旧快照生成 models.required，会出现「盘上 13 个、只声明 7 个」。
      //   快照带着它是按哪个引擎问来的，换引擎期间留下来的那一份不能当这一台的现状。
      let files = modelFilesOf(modelFiles)
      try {
        const fresh = onRefreshInstall ? await onRefreshInstall(id) : null
        if (Array.isArray(fresh)) files = fresh
      } catch (e) { /* 读不到就用手上这份，不阻断扫描 */ }
      // 两种形态各走自己的填入：cli 填开关与词序，python 填方法参数名与构造参数。
      //   共用一套时每一段都要按形态分支，漏一个字段就是一张自相矛盾的名片。
      const fillFor = (callNow) => ((callNow && callNow.kind) === 'python'
        ? computePythonFill(pickedParams, callNow, j.python_entries, j.python_entry_suggested, files)
        : computeCliFill(pickedParams, callNow, bindCands, entryPick, id, declareHints, files, pickedPositionals))
      const result = fillFor(latest.call || null)
      // 生成器方法由扫描定返回方式，但采样率来自引擎配置，静态读不到（有些引擎把它
      //   写在构造时的 configs 里）。这里只说清要填哪一格，不替人猜一个数。
      const entryPicked = withPythonEntryFromScan(result ? result.call : (latest.call || null), j.python_entries, j.python_entry_suggested)
      if (entryPicked && entryPicked.returns === 'generator' && !entryPicked.generator_sample_rate) {
        const note = {
          en: 'This method yields chunks, so the return mode is set to generator. Fill call.generator_sample_rate (Hz) under engine settings: without it the host refuses to guess a sample rate.',
          zh: '这个方法逐块产出，返回方式已设为 generator。请在引擎配置里填 call.generator_sample_rate（赫兹）：不填时宿主拒绝猜采样率。',
        }
        setScan((prev) => (prev ? { ...prev, notes: [...(prev.notes || []), note] } : prev))
      }
      if (result) {
        // 扫描认出来的开关要落成「合成参数」的行：扫描写回只写了 call.args 与 params.call_time，
        //   那是命令行映射，界面上没有对应的一格，人于是对着一个空表发愁。
        //   这里补的正是那批开关，走的是「把列出的参数一起加入」同一条路（addParamsFromScan），
        //   类型、英文名、说明取自同一次扫描，因此不靠人再拖一遍才看得见。
        //   收哪些：扫描结果按入口文件筛过的那一份，不是闭包捕获的旧 pool。
        //   闭包的 params 是发起扫描那一刻 render 的值，await 后组件已 re-render，
        //   但闭包里的 params 还是旧的。切形态后重扫时，旧 pool 是上一形态的全部参数
        //   （cli 的 165 条），把它们写进 parameters 就是那 100 多行的来源。
        //   已有且人改过的行一律不动（中文名或说明被人填过就算改过）；
        //   纯扫描生成、本次没扫到的旧行要清掉：那是上一形态留下的参数，
        //   只加不删的话它们会永远躺在表里，越积越多。
        //   已被 bind 槽位与 role 槽位接管的开关由 isParamTaken 判掉，
        //   它们各自在别处有格子，再做一格就是同一个开关摆两处。
        const freshEntry = (j.entry && j.entry.file) || ''
        const freshPool = scopeParams(pickedParams, freshEntry).params
        const shaped = syncParamsFromScan(latest, freshPool)
        if (writeBack) onManifest((cur) => {
          const base = cur || {}
          if ((base.id || '') !== id) return cur
          const merged = fillFor(base.call || null) || result
          // 参数行基于最新名片再算一次：等结果期间使用者可能自己加过行。
          const rows = syncParamsFromScan(base, freshPool)
          // 入口、返回方式、绑定、构造参数都由 fillFor 按形态填好了，这里只取结果。
          const next = { ...base, call: merged.call }
          if (rows.added.length || rows.removed.length) next.parameters = rows.manifest.parameters
          // 参数白名单：host 只把 params.call_time 里的键交给引擎，两个名单缺一个
          //   都会在启动前拒收整张名片（load_time 缺了 / 参数未接入命令行）。
          //   写了 parameters 的新版名片，params 是平台派生的，不能自己写一份；
          //   这一趟刚落了参数行也算写了新版，同样不能再留一份 params
          //   （两份并存会被 parameterDeclaration 当场拒收）。
          if (next.parameters === undefined && merged.call) {
            const params = { ...(base.params || {}) }
            const cur = Array.isArray(params.call_time) ? params.call_time : []
            const add = (merged.callTime || []).filter((k) => !cur.includes(k))
            if (add.length) params.call_time = [...cur, ...add]
            if (params.load_time === undefined) params.load_time = []
            next.params = params
          }
          if (!next.label && id) next.label = id
          if (next.contract_version === undefined) next.contract_version = 2
          // 顶层声明只补空缺：多权重位与输出格式是使用者可改的决定，
          //   已经写过的那份不拿扫描建议覆盖。
          const patch = merged.manifestPatch || {}
          if (base.weights === undefined && Array.isArray(patch.weights) && patch.weights.length) {
            next.weights = patch.weights
          }
          if (base.output_formats === undefined && Array.isArray(patch.output_formats) && patch.output_formats.length) {
            next.output_formats = patch.output_formats
          }
          return next
        })
        // confidence 与 matched 同一趟扫描算出来，界面靠它把自动填值分成确定 / 推测两档。
        setAutofill({ matched: result.matched, argList: result.argList,
          notes: result.notes || [], confidence: result.confidence || null })
        // 这一趟自动落进行里的开关，上游没写明类型的标成推测：中栏那一行的类型框描黄，
        //   与拖入那条路同一套判定，徽标含义不因来路不同而变化。
        if (shaped.added.length) {
          setGuessed((prev) => {
            const next = new Set(prev)
            for (const name of shaped.added) {
              const param = scanParamFor(name, params)
              if (param && !param.kind_certain) next.add(name)
            }
            return next
          })
        }
      } else {
        setAutofill({ matched: null, argList: [], notes: [], confidence: null })
      }
    } catch (e) { if (!quiet) setScanErr(e.message) } finally { if (!quiet) setBusy(false) }
  }

  // 进这一步就该看清这台引擎有什么：参数池、入口候选、位置参数都出自同一次扫描。
  //   有会话存档就直接读，不再跑 /wizard/discover；只有这台从没扫过才静默扫一次，
  //   只摆结果、不写名片。人点「扫描」时才按点击的意思写回。
  const autoScanned = React.useRef('')
  React.useEffect(() => {
    const id = engineKey
    if (!id || autoScanned.current === id) return
    autoScanned.current = id
    const s = loadSession(id)
    if (s && s.scan) return
    doScan({ writeBack: false, quiet: true })
  }, [engineKey])

  // 拖进来一个参数：类型是猜的就记下来，中栏那一行要提醒确认。
  const onParamDropped = (param, name) => {
    if (!param || !name) return
    setGuessed((prev) => {
      const next = new Set(prev)
      if (param.kind_certain) next.delete(name)
      else next.add(name)
      return next
    })
  }
  const onTypeConfirmed = (name) => {
    setGuessed((prev) => { const next = new Set(prev); next.delete(name); return next })
  }

  // 左栏拖拽开始：把参数放进 dataTransfer，中栏的落点读它。
  const onDragStart = (e, param) => {
    // 跟着光标走的那块文字读 text/plain：放命令行上的写法（--emotion-vector），
    //   不放 JSON。整条参数放自定义类型，落点从那里读。
    e.dataTransfer.setData('text/plain', dragLabelOf(param))
    e.dataTransfer.setData(PARAM_MIME, JSON.stringify(param))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    // 容器用 .wz-manifest-layout（editor.css），不用项目的 .workspace-grid：
    // .workspace-grid 自己就是两列 grid（minmax(0,1fr) 380px），
    // 三栏容器放进去会被塞进它的第一列 ⇒ 中栏只剩 958px 里的 302px，
    // 剩下那一大片是右栏的空位。三个栏自己排版，不需要外层再来一列。
    <div className="wz-manifest-layout">
      <Stage
        open={drawer}
        onToggle={toggleDrawer}
        full={rightFull}
        onFull={setRightFull}
        left={
          <EngineScanZone
            params={params} selected={selected} used={usedParam}
            onSelect={setSelected} onDragStart={onDragStart}
            groups={(scan && scan.groups) || []} group={group}
            onGroupChange={setGroup}
            scope={{ basis: scope.basis, outside: scope.outside,
              shown: scope.params.length, total: grouped.length }}
            listAll={poolAll} onListAll={setPoolAll}
            busy={busy} err={scanErr} />
        }
        center={
          <div className="wz-stage-main-inner">
          <StepCard title={stepFrame.title} done={stepFrame.done} onClose={stepFrame.onClose}>
            <div className="wz-stack">
            {/* 身份条在最上面：选引擎、扫描或读取、路径、保存，一行说完。 */}
            <EngineIdentity
              manifest={manifest || {}} onChange={onManifest}
              facts={engineState}
              onScan={doScan} scanBusy={busy} scanned={!!scan}
              diag={diag} onSaved={onSaved}
              onEngineTarget={onPickEngineTarget}
              dirs={dirs} onDirsReload={onDirsReload}
              viewSwitch={
                <div className="wz-view-switch">
                  <button type="button"
                    className={`chip${view === 'form' ? ' chip-on' : ''}`}
                    onClick={() => switchTo('form')}>
                    {t('Form', '填表')}
                  </button>
                  <button type="button"
                    className={`chip${view === 'json' ? ' chip-on' : ''}`}
                    onClick={() => switchTo('json')}>
                    JSON
                  </button>
                </div>
              } />

            {/* 扫描过程的说明：认出了哪个入口、依据是什么、有没有同名冲突。
                这些只回传在 autofill.notes 里，不摆出来就等于没说。 */}
            {Array.isArray(autofill && autofill.notes) && autofill.notes.length > 0 && (
              <div className="msg msg-warn" style={{ marginTop: 8 }}>
                {autofill.notes.map((n, i) => (
                  <div key={i}>{typeof n === 'string' ? n : t(n.en, n.zh)}</div>
                ))}
              </div>
            )}

            {view === 'form'
              ? <ManifestForm manifest={manifest || {}} spec={spec} onChange={onManifest}
                checkpointsPath={checkpointsPath}
                modelFiles={modelFiles}
                autofill={autofill} selectedParam={selected}
                entryCandidates={scan && scan.entry_candidates}
                pythonEntries={scan && scan.python_entries}
                positionals={scan && scan.positionals}
                scanned={shapeSource}
                poolParams={params}
                // 扫描按钮挂在「调用方式」旁边：它决定的就是这一格与入口那一格。
                //   只在这台引擎确实有名片、且表单里已经有内容之后出现：
                //   没有名片时扫了没处放（那种情况身份条上是「新建名片」）。
                canScan={canScan}
                scanBusy={busy}
                onScan={(opts) => doScan(opts)}
                guessed={guessed} onParamDropped={onParamDropped}
                onTypeConfirmed={onTypeConfirmed} />
              : (
                // JSON 逃生口直接用项目的 textarea.control。
                // text 为 null（还没切进来过）时用 manifest 现算兜底，
                //   React 的 value={null} 是非受控输入，切视图时会闪。
                <textarea className="control" style={{ minHeight: 320 }}
                  value={text ?? JSON.stringify(manifest || {}, null, 2)}
                  onChange={(e) => setText(e.target.value)} />
                )}

            {err && view === 'json' && (
              <div className="msg msg-danger">{err}</div>
            )}
            <ModeCards manifest={manifest} onDone={onSaved} />
            </div>
          </StepCard>
          </div>
        }
        right={
          <div className="wz-drawer-stack">
            {/* 预览在前：右边条是「当前项目的前端预览」这一栏，
                诊断是附带的说明，不该把首屏占住。 */}
            {manifest
              ? <PanelPreview manifest={manifest} />
              : (
                // 还没选引擎时右边条是空的。空的时候画一个空态就够了，
                // 不必再套一层带栏头的 .section：
                // 边条自己就是这栏的入口，栏头里的收起按钮是多余的。
                <div className="section">
                  <div className="section-body">
                    <div className="empty-state">
                      <div className="es-title">
                        {t('Nothing to preview yet', '暂无可预览的内容')}
                      </div>
                      <div className="es-sub">
                        {t('Pick an engine to see the preview.',
                          '选一台引擎，这里会实时显示界面。')}
                      </div>
                    </div>
                  </div>
                </div>
                )}
            {/* props 名必须是 result：组件签名是 ({ result, loading })，
                 传成 diag= 的话诊断面板永远不显示。
                 全屏（rightFull）时只留预览，检查结果面板退出抽屉：
                 全屏是按平台真实尺寸看预览，不应被诊断条目挤占。 */}
            {!rightFull && <Diagnostics result={diag} loading={loading} />}
          </div>
        } />

    </div>
  )
}
