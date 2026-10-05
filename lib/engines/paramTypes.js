'use strict'

// ---------------------------------------------------------------------------
//  五种预设样式 —— 名片能说出来的全部参数形状（契约 §5.4）
// ---------------------------------------------------------------------------
//
// Owner 2026-08-29 定的五种，一个不多一个不少：
//
//   text     文本   用户打字
//   number   数字   一个数（min/max/step/unit 只是**界面提示**）
//   select   下拉   多选一 / 多选多；选项来自名片(choices) 或平台托管库(source)
//   boolean  勾选   开关
//   file     路径   custom file —— 用户自己指定、平台不认识的任意文件
//
// ⭐ 这五种里**没有一种带业务身份**。没有「情绪参考音频」类型、没有「GPT 权重」
//    类型。那些是名片给格子起的**名字**，不是平台认识的**种类**。
//    判据：装一台谁都没见过的引擎，本文件一个字都不用改。
//
//  ⭐⭐ 界面上这些格子住在**哪儿**（2026-10-03 实测 GetrateTab.jsx 才确认）
//    主区域（永远可见）
//      ├─ Voice / Text / 参考音频 / 权重下拉  ← 平台固定区域，不来自名片
//      └─ 🔒 Advanced Settings（默认折叠 useState(false)）
//           └─ Common / Advanced 两个标签（TIERS）
//                └─ parameters[] 的格子全部渲染在这里
//    ⇒ **parameters[] 里一个参数都不会出现在主区域。**
//      名片做不到「把这个参数提到主区域」—— 那不是 tier 能控制的。
//
// ⭐ repeat 不是第六种类型，是**正交修饰**（见下面 REPEAT 那段）。
//    八维情绪向量 = number × repeat 8；辅助参考音频 = select × repeat N。
//    把「向量」做成一种类型，等于平台开始认识「情绪有几维」——那是引擎的事。
//
// ⛔ 只传不校验（契约 §5.5「平台是搬运工，不是翻译」）。min/max/step 是名片
//    作者**手抄**上游文档抄来的；抄错了就会拦住引擎其实能接受的值，而且在界面上
//    看起来像「这台引擎不支持」。所以它们画滑块范围，不当闸门。
//
// ---------------------------------------------------------------------------
//  为什么要改名（enum→select / path→file / integer→number）
// ---------------------------------------------------------------------------
//
// 老名字里藏着两处会咬人的具象：
//
//   path  以前既指「从平台扫到的模型库里挑一个」又指「用户自己指一个文件」，
//         两件事被糊成同一个 `path + datalist`。可它们的区别是**候选从哪来**：
//         前者平台扫得出列表（⇒ select + source），后者平台根本不认识这个文件
//         （⇒ file，没有候选）。web/src/components/broker/BrokerTab.jsx:53 那个
//         custom 判据写得很清楚：custom = 值不在平台扫到的列表里。
//
//   integer / number  是同一个输入框的两种数，不是两种样式。合并成 number，
//         「是不是整数」降级成条目上的 int 标记（保留是因为收取侧要 parseInt，
//         不保留会把 7.5 悄悄发给一个只吃整数的引擎）。
//
// ⚠ 老名字**永远收得进来**：三张名片不必一次性全改完，第三方名片更不该因为
//   我们改了个词就装不上。别名只在读入的那一刻折叠，出口只有五种。
const PARAM_TYPES = Object.freeze(['text', 'number', 'select', 'boolean', 'file'])

const TYPE_ALIASES = Object.freeze({
  integer: 'number',
  enum: 'select',
  path: 'file',
  string: 'text',
})

// ---------------------------------------------------------------------------
//  下拉的选项从哪来
// ---------------------------------------------------------------------------
//
// 两种，二选一：
//   choices  名片自己写死的选项（["wav","ogg"] 这种，引擎自己的词汇）
//   source   平台托管库，运行时扫盘才知道有哪些 —— 名片**列不出来**
//
// ⭐ source 的这三个词是**平台的词汇**，不是任何一台引擎的参数名：一台引擎都
//    没装的时候，「这台机器上有哪些音色 / 权重 / 音频」依然有意义（同
//    paramTable.js 的 PLATFORM_REQUEST_KEYS 那段的理由）。
//
// ⛔ 名片没写 source，平台就**不主动**把资产库挂上去（Owner 2026-08-29：
//    「不要随便接入我们现有的容器」）。
const SELECT_SOURCES = Object.freeze(['voices', 'weights', 'audio'])

/** 名片写的那个词 → 五种之一。不认识的返回 null（由调用方决定怎么抱怨）。 */
function canonicalType (raw) {
  if (typeof raw !== 'string') return null
  if (PARAM_TYPES.includes(raw)) return raw
  return TYPE_ALIASES[raw] || null
}

/** 名片写的是不是「整数」那一味（合并进 number 之后仍需记住）。 */
function isIntFlavor (raw) {
  return raw === 'integer'
}

/**
 * 一个条目要重复几格。
 *
 * ⭐ 这是修饰，不是类型：repeat 8 的 number 就是八个数字框，值是长度 8 的数组。
 *    没写 / 写 1 = 一格，值是标量 —— ⛔ 不是长度 1 的数组。
 *    「一格」和「一格但装在数组里」发给引擎是两件事，而这个差别不报错。
 */
function repeatOf (entry) {
  const n = entry && entry.repeat
  if (n === undefined || n === null) return 1
  const i = Number(n)
  if (!Number.isInteger(i) || i < 1) return 1
  return i
}

/** 这一格是不是「重复的一排」。 */
function isRepeated (entry) {
  return repeatOf(entry) > 1
}

module.exports = {
  PARAM_TYPES,
  TYPE_ALIASES,
  SELECT_SOURCES,
  canonicalType,
  isIntFlavor,
  repeatOf,
  isRepeated,
}
