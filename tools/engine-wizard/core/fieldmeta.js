'use strict'
// ============================================================================
//  FIELD META —— 名片每个键的「说明 / 危险等级 / 怎么填」
//
//  ⛔⛔ 纪律（照平台的第一条纪律来）
//  本文件里**不许出现任何具体引擎名**。判据：
//    装一台谁都没见过的引擎，这个文件一个字都不用改。
//    node test/fieldmeta.node.test.js 里有一台假引擎守着这条。
//
//  ⭐ 这个文件是「文档」，不是「规则」。
//    真正的校验规则在 lib/engines/profile.js（平台自己的 60 处抛错），
//    这里只负责把它的错误翻成人话 + 提前警告它**管不到**的那些坑。
//
//  为什么要分开：
//    平台有一类错误是**静默失效**—— 填错了不报错，只是「设了没效果」。
//    profile.js 拦不住（那是它管不了的），但用户在这里必须看见。
//    ⇒ danger: 'silent' 的键 = 填错不报错，是最需要提醒的一类。
// ============================================================================

// 危险等级，三档：
//   'block'  ── 平台会抛错，不改就跑不起来
//   'silent' ── ⛔ 平台不拦，但会「设了没效果」。最阴的一档
//   'info'   ── 填错顶多体验差，平台会兜住
const DANGER = Object.freeze({
  BLOCK: 'block',
  SILENT: 'silent',
  INFO: 'info',
})

// --- 顶层段：17 个。howto 说明这一段整体是干什么的 -------------------
const SECTIONS = Object.freeze([
  { key: 'contract_version', group: 'basics', danger: DANGER.BLOCK,
    howto: '声明这张名片按哪一版契约解析。平台用它决定认哪些字段。' },
  { key: 'id', group: 'basics', danger: DANGER.BLOCK,
    howto: '引擎的**唯一标识**。⛔ 必须与 engines/ 下的目录名逐字相同，否则装不上。' },
  { key: 'label', group: 'basics', danger: DANGER.INFO,
    howto: '界面上给人看的名字。随便写，不参与任何逻辑。' },
  { key: 'upstream', group: 'source', danger: DANGER.SILENT,
    howto: '上游信息：仓库地址、commit、许可证。',
    warn: 'commit 填错 ⇒ 装出来的版本与开发时不同 ⇒ **声音不对且不报错**。' },
  { key: 'local_changes', group: 'source', danger: DANGER.INFO,
    howto: '本地改过上游哪些文件的说明。写「无」也要写，它是有无之别的物证。' },
  { key: 'install', group: 'install', danger: DANGER.INFO,
    howto: '怎么装这台引擎的环境。平台**不代劳**，只照这里打印命令。' },
  { key: 'models', group: 'models', danger: DANGER.INFO,
    howto: '底模放在哪、哪几个文件算齐、从哪取。',
    warn: '只写 checkpoints 而不写 required，平台就没法帮你确认权重文件齐不齐（不填也能用）。' },
  { key: 'weights', group: 'models', danger: DANGER.SILENT,
    howto: '用户要选几个模型位、各叫什么。',
    warn: 'applies_at 填错 ⇒ **不报错**，下拉能选、声音不变。' },
  { key: 'max_chars', group: 'runtime', danger: DANGER.INFO,
    howto: '单次请求最长多少字符。' },
  { key: 'max_chars_source', group: 'runtime', danger: DANGER.INFO,
    howto: '上面那个数**从哪来的**（实测 / 估的）。平台强制要求写。' },
  { key: 'timeout_ms', group: 'runtime', danger: DANGER.INFO,
    howto: '超时毫秒数。' },
  { key: 'timeout_ms_source', group: 'runtime', danger: DANGER.INFO,
    howto: '上面那个数从哪来的。' },
  { key: 'base_url_env', group: 'runtime', danger: DANGER.INFO,
    howto: '哪个环境变量能改这台引擎的地址。⛔ 平台不认识任何具体变量名，全靠这里声明。' },
  { key: 'capabilities', group: 'capabilities', danger: DANGER.INFO,
    howto: '这台引擎支持什么：要不要参考音频、流式、采样率、能否微调。',
    warn: 'requires_reference_audio 只有一个开关 ⇒ 多方法的引擎表达不了「这个方法要、那个不要」。' },
  { key: 'runtime', group: 'runtime', danger: DANGER.BLOCK,
    howto: '怎么把进程拉起来：解释器目录、入口脚本、就绪端点、超时。',
    warn: 'python 填引擎自己的环境目录（如 engines/<id>/.venv），填绝对路径存不了。' },
  { key: 'call', group: 'call', danger: DANGER.BLOCK,
    howto: '怎么调这台引擎：模块/类/方法，或命令行 argv；三个槽位怎么绑。',
    warn: '缺 call 段 ⇒ 平台走不了通用宿主，得另有一套实现（这本身就是一种「形状」，见 README）。' },
  { key: 'parameters', group: 'parameters', danger: DANGER.INFO,
    howto: '界面参数面板的来源，一份声明派生出 5 份视图。',
    warn: '⚠ 不得与旧字段（param_keys / payload_keys / params / defaults / defaults_env）并存 —— 平台会抛错（两份会漂移的事实）。' },
  { key: 'maps', group: 'parameters', danger: DANGER.INFO,
    howto: '平台词表 → 引擎方言的翻译。没映射的词 = 这台引擎没这个概念，不发。' },
  { key: 'output_formats', group: 'output', danger: DANGER.INFO,
    howto: '这引擎能输出哪些格式。' },
])

// --- parameters[] 条目的键（UI_KEYS + 归属键）----------------------
// UI_KEYS 是平台 paramTypes.js 定的 16 个，一个不多一个不少。
// 这里只加**说明与危险等级**，不重复定义「合法取值」——
//   那由 profile.js 的白名单负责，我们不维护第二份。
const PARAM_FIELDS = Object.freeze([
  { key: 'name', required: true, danger: DANGER.BLOCK,
    howto: '参数名。⛔ 不得与 maps.text 绑定的那个同名，也不得重复。' },
  { key: 'type', required: true, danger: DANGER.BLOCK,
    howto: '五种之一：text / number / select / boolean / file。',
    warn: '⚠ 别写 enum / path / string / integer —— 那是旧叫法，新写必须用新名。' },
  { key: 'phase', default: 'call', danger: DANGER.SILENT,
    howto: 'call（每次调用都能改，默认）还是 load（装引擎时定一次）。',
    warn: '该 load 写成 call ⇒ **改了不生效、不报错**。' },
  { key: 'tier', default: 'advanced', danger: DANGER.SILENT,
    howto: 'Advanced Settings 容器**内部**的那一档：common / advanced。',
    structure:
      '主区域（永远可见：Voice / Text / 参考音频 / 权重下拉…）\n' +
      '└─ 🔒 Advanced Settings（默认折叠）\n' +
      '     ├─ Common 档   ← tier: "common"\n' +
      '     └─ Advanced 档 ← 什么都不写（默认落这里）\n' +
      '⚠ ⛔ parameters[] 里的参数**全部**住在折叠容器里，主区域一个都不渲染。\n' +
      '   所以 tier 不是「常用 vs 冷门」，而是「折叠层里再分两排」。\n' +
      '   ⚠ 想让某个参数出现在主区域 —— 名片做不到，那是平台的固定区域。',
    warn: '⚠ 没写 tier ⇒ 落进 advanced（web/src/lib/engines.js:164）。' },
  { key: 'applies_to', danger: DANGER.INFO,
    howto: '只在这些方法名下显示。多方法引擎的必备字段。' },
  { key: 'label', danger: DANGER.INFO,
    howto: '界面上的名字。可写字符串，也可写 {en, zh} 双语对象。' },
  { key: 'help', danger: DANGER.INFO,
    howto: '鼠标悬停说明。同样支持 {en, zh}。',
    warn: '反射拿不到这一项 ⇒ **必然要人填**。' },
  { key: 'suggested_value', danger: DANGER.INFO,
    howto: '格子的初值。⚠ 读入时会被映射成 default，出口叫 default。' },
  { key: 'min', danger: DANGER.INFO,
    howto: '滑块下限。⛔ **只是画范围，不是校验闸门** —— 抄错会拦住引擎其实能接受的值。' },
  { key: 'max', danger: DANGER.INFO, howto: '滑块上限。同上，不是闸门。' },
  { key: 'step', danger: DANGER.INFO, howto: '滑块步长。' },
  { key: 'choices', danger: DANGER.INFO,
    howto: '下拉的选项（这台引擎自己的词汇）。与 source 二选一。' },
  { key: 'source', danger: DANGER.INFO,
    howto: '下拉选项从平台托管库来：voices（音色）/ weights（权重）/ audio（音频）。' },
  { key: 'allow_custom', danger: DANGER.INFO, howto: '下拉是否允许用户填自己的值。' },
  { key: 'multi', danger: DANGER.INFO, howto: '是否多选。' },
  { key: 'repeat', default: 1, danger: DANGER.SILENT,
    howto: '这一格要重复几格。',
    warn: '⚠ 写 1 或不写 = **标量**；「一格」与「一格装在数组里」是两件事，且不报错。' },
  { key: 'dim_labels', danger: DANGER.INFO, howto: 'repeat 展开后每格的标签。' },
  { key: 'tier_note', danger: DANGER.INFO, howto: '（编辑器内部用，不写进名片）' },
  { key: 'group', danger: DANGER.INFO, howto: '界面分组名。同组的参数会挨在一起。' },
  { key: 'order', danger: DANGER.INFO, howto: '组内排序。' },
  { key: 'width', danger: DANGER.INFO, howto: '占多宽（full = 整行）。' },
  { key: 'only_when', danger: DANGER.INFO,
    howto: '「这个输入框依赖那个开关」——引擎的语义，反射拿不到。' },
  { key: 'int', danger: DANGER.INFO,
    howto: '把 number 降级成整数那一味（收取侧要 parseInt）。' },
])

const SECTIONS_BY_KEY = Object.freeze(
  SECTIONS.reduce((m, s) => { m[s.key] = s; return m }, {})
)
const PARAM_FIELDS_BY_KEY = Object.freeze(
  PARAM_FIELDS.reduce((m, f) => { m[f.key] = f; return m }, {})
)

// ----------------------------------------------------------------------------
//  ⭐⭐ 平台词表（第 2 步的「人话」库）
// ----------------------------------------------------------------------------
//  这是 payload.js 的 CANONICAL_KEYS 那 10 个词，**平台唯一认识的一组概念**。
//  反射出来的参数草稿里，凡是名字落在这一张表上的（或映射候选勾上的），
//  平台上就显示这里的**中文人话**；⛔ 表外的一个字都不翻译。
//
//  ⚠ 为什么单独一张表而不并进 PARAM_FIELDS：
//    PARAM_FIELDS 说的是「parameters[] 这一条有哪些**格**」（name/type/tier…），
//    说的是**卡片的字段**；这里说的是**平台那 10 个概念分别是什么意思**。
//    两件事，混在一张表里就会有人以为改一个是改另一个。
//
//  ⛔ 纪律（与文件头同一条）：这张表里不许出现任何具体引擎名 ——
//    它描述的是**平台的词**，跟装哪台引擎无关。
//
//  ⭐ 文案来源：payload.js 里 CORE_KEYS / OPTIONAL_KEYS 的头注（「空值发不发」
//    的区分是它写的），加上 profile.js 对 parameters[] / maps 的抛错原句。
//    ⇒ 搬运已有文案，不是新写。
// ----------------------------------------------------------------------------
const PLATFORM_WORDS = Object.freeze([
  // ── CORE：只要名片映射了就一定发，哪怕值是空字符串（payload.js:39-47）──
  { key: 'text', danger: DANGER.BLOCK,
    label: '要合成的文字',
    help: '念出来的那段话。用户每次合成都会改它。' },
  { key: 'text_lang', danger: DANGER.INFO,
    label: '这段文字的语言',
    help: '要合成的文字是什么语言。它管的是发音，不是音色。',
    warn: '没写这一条的平台不认识什么语言，引擎只能自己判断。' },
  { key: 'reference_audio', danger: DANGER.BLOCK,
    label: '参考音频（音色从哪来）',
    help: '决定「用什么声音念」的那段录音。不填就是引擎的默认音色。',
    warn: '⚠ 这台引擎要是不支持换音色，这一条映射了也不会有效果。' },
  { key: 'reference_text', danger: DANGER.INFO,
    label: '参考音频里念的是什么',
    help: '上面那段录音对应的文字稿。有的引擎靠它把音色对齐得更好。' },
  { key: 'reference_lang', danger: DANGER.INFO,
    label: '参考音频的语言',
    help: '上面那段录音是什么语言。它和「要合成的文字的语言」是两件事。' },
  // ── OPTIONAL：不填就不发，交给引擎自己的默认值（payload.js:44-47）──
  { key: 'aux_reference_audio', danger: DANGER.INFO,
    label: '第二个参考音频',
    help: '再给一段录音，用来混合音色。多数引擎用不到。' },
  { key: 'speed', danger: DANGER.INFO,
    label: '语速',
    help: '念多快。1 是原速，2 是两倍快。' },
  { key: 'seed', danger: DANGER.INFO,
    label: '随机种子',
    help: '同一个种子配同样的输入，出来的声音一致。想让每次结果不同就留空。' },
  { key: 'media_type', danger: DANGER.INFO,
    label: '输出格式',
    help: '合成出来是什么格式，比如 wav / mp3。' },
  { key: 'streaming', danger: DANGER.SILENT,
    label: '流式输出',
    help: '边合成边往回传，不用等整段念完。',
    warn: '⚠ 填错不报错，只是听着不像流式。' },
])

const PLATFORM_WORDS_BY_KEY = Object.freeze(
  PLATFORM_WORDS.reduce((m, w) => { m[w.key] = w; return m }, {})
)

module.exports = {
  DANGER,
  SECTIONS,
  SECTIONS_BY_KEY,
  PARAM_FIELDS,
  PARAM_FIELDS_BY_KEY,
  PLATFORM_WORDS,
  PLATFORM_WORDS_BY_KEY,
}