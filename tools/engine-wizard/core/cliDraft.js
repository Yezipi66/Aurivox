'use strict'
//  buildCliDraft：走命令行（cli 形态）的草稿生成
//  输入：cliHelp.collectCliHelp(dir) 的结果 {ok, flags, by_dest, sources}
//  输出：{
//    ok, subcommands,        // 上游有哪些子命令（synth/infer/…）
//    args,                   // 每个 flag 一条 {name, flag, style, help, required, is_tool}
//    suggested_call,         // 建议的 cli 形态 call 段骨架 {kind, argv, bind, args}
//  }

const TOOL_FLAGS = new Set([
  'model_dir', 'model-dir', 'device', 'fp16', 'deepspeed', 'cuda_kernel', 'cuda-kernel',
  'accel', 'torch_compile', 'torch-compile', 'verbose', 'force', 'dry_run', 'dry-run',
  'keep_temp', 'keep-temp', 'stdin', 'text_file', 'text-file', 'config', 'version',
])

// argparse action → cli 形态名片的 style（host.py:_render_cli_arg 认这几种）
function styleOf (f) {
  const a = f.action
  if (a === 'store_true' || a === 'store_false') return 'boolean'
  if (a === 'BooleanOptionalAction') return 'boolean_optional'
  if (a === 'append') return 'repeat'
  return 'value'
}

function buildCliDraft (cliHelp, opts = {}) {
  if (!cliHelp || !cliHelp.ok || !Array.isArray(cliHelp.flags)) {
    return { ok: false, error: (cliHelp && cliHelp.error) || 'CLI 扫描失败', args: [], suggested_call: null }
  }
  const flags = cliHelp.flags

  // 上游有哪些子命令（认不出的 subcommand=null 归到「(根)」）
  const subcommands = [...new Set(flags.map((f) => f.subcommand || '(root)'))]

  // 只取用户指定的子命令；没指定就全保留（标 subcommand）
  const wantSub = opts.subcommand || null
  const picked = wantSub ? flags.filter((f) => (f.subcommand || '(root)') === wantSub) : flags

  const args = []
  for (const f of picked) {
    const flag = f.flags[f.flags.length - 1]
    if (!flag || !flag.startsWith('--')) continue // 只要长开关
    const name = flag.slice(2)
    args.push({
      name,
      flag,
      style: styleOf(f),
      help: f.help || null,          // 官方原话，不改写
      required: f.required === true,
      default: f.default !== undefined ? f.default : null,
      choices: f.choices || null,
      is_tool: TOOL_FLAGS.has(name),
      subcommand: f.subcommand || null,
      source_file: f.source_file || null,
    })
  }

  // 建议的 call 段骨架（只是骨架，人确认后才落盘）
  // argv 第一词用 {engine_python}（host.py 认的占位符）
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
