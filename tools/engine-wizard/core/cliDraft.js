'use strict'
// 命令行形态（call.kind = "cli"）的草稿生成：把上游 CLI 的 flag 整理成名片能用的形状。
// 判据是上游 argparse 的 action 名与开关形态；参数值一个也不替用户决定。
// 边界：只产出草稿，落盘由 save.js 负责，命令行展开由 lib/engines/host.py 负责。

// 工具类开关的名字清单：is_tool 为真的开关在界面上标「工具」，与合成内容参数分开。
const TOOL_FLAGS = new Set([
  'model_dir', 'model-dir', 'device', 'fp16', 'deepspeed', 'cuda_kernel', 'cuda-kernel',
  'accel', 'torch_compile', 'torch-compile', 'verbose', 'force', 'dry_run', 'dry-run',
  'keep_temp', 'keep-temp', 'stdin', 'text_file', 'text-file', 'config', 'version',
])

// 上游 argparse 的 action 名 → 名片 args 段里的 style 写法。
// 这几个词是 lib/engines/host.py 的 _render_cli_arg 认的，拼错它会在展开命令行时抛错。
function styleOf (f) {
  const a = f.action
  if (a === 'store_true' || a === 'store_false') return 'boolean'
  if (a === 'BooleanOptionalAction') return 'boolean_optional'
  if (a === 'append') return 'repeat'
  return 'value'
}

/**
 * 把上游 CLI 的官方说明整理成一份名片草稿。
 * cliHelp 是 collectCliHelp(dir) 的返回值，flags 为上游 argparse 的 flag 列表。
 * 返回 {ok, subcommands, args, suggested_call}：subcommands 是上游有哪些子命令（认不出的归到
 * "(root)"）；args 每条一项，字段为 name / flag / style / help / required / default / choices /
 * is_tool / subcommand / source_file，help 是上游原话；suggested_call 是 cli 形态 call 段骨架。
 */
function buildCliDraft (cliHelp, opts = {}) {
  if (!cliHelp || !cliHelp.ok || !Array.isArray(cliHelp.flags)) {
    return { ok: false, error: (cliHelp && cliHelp.error) || 'CLI 扫描失败', args: [], suggested_call: null }
  }
  const flags = cliHelp.flags

  // 上游有哪些子命令。上游没写 subcommand 的 flag 归到 "(root)"。
  const subcommands = [...new Set(flags.map((f) => f.subcommand || '(root)'))]

  // 只取用户指定的子命令；没指定就全保留（每条 flag 各带自己的 subcommand）
  const wantSub = opts.subcommand || null
  const picked = wantSub ? flags.filter((f) => (f.subcommand || '(root)') === wantSub) : flags

  const args = []
  for (const f of picked) {
    // 名片 args 段只放长开关。取第一个长开关，不取最后一个词：上游常把短别名写在后面
    //   （`add_argument("--text", "-t")`），取最后一个词会拿到 -t，整条被当成「只有短开关」丢掉。
    const flag = f.flags.find((w) => typeof w === 'string' && w.startsWith('--'))
    if (!flag) continue
    const name = flag.slice(2)
    args.push({
      name,
      flag,
      style: styleOf(f),
      help: f.help || null,          // 官方原话，不改写
      required: f.required === true,
      default: f.default !== undefined ? f.default : null,
      choices: f.choices || null,
      // argparse 的 type= 原样递出（int / float / str / Path…）。
      //   没有它，value 形态的 flag 只能一律当 str，界面上的类型就是猜的。
      type: f.type || null,
      is_tool: TOOL_FLAGS.has(name),
      subcommand: f.subcommand || null,
      source_file: f.source_file || null,
    })
  }

  // 建议的 call 段骨架（只是骨架，人确认后才落盘）
  // argv 第一词用 {engine_python}（host.py 认的占位符），__MODULE__ 留给使用者填模块名。
  const suggested_call = wantSub && wantSub !== '(root)'
    ? {
        kind: 'cli',
        argv: ['{engine_python}', '-m', '__MODULE__', wantSub],
        bind: { text: null, ref_audio: null, output_path: null }, // 人从 flag 里选
        args: Object.fromEntries(args.map((a) => [a.name, { flag: a.flag, style: a.style }])),
      }
    : null

  return { ok: true, subcommands, args, suggested_call }
}

module.exports = { buildCliDraft, styleOf, TOOL_FLAGS }
