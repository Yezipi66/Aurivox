#!/usr/bin/env bash
# =============================================================================
#  install-torch.sh — macOS / Linux 薄壳，主体在 tools/cli/install-torch.js
#
#  ⛔ 这里**不放任何逻辑**。逻辑与 Windows 上跑的是同一份 Node 主体，
#     所以两个平台不会行为分叉。
#
#  用法：
#     ./install-torch.sh                     自动探测计算设备
#     ./install-torch.sh --backend cpu       强制 CPU
#     ./install-torch.sh --backend xpu       强制 Intel XPU
#     ./install-torch.sh --backend rocm      强制 AMD ROCm（官方只有 Linux）
#     ./install-torch.sh --dry-run           只打印决策，不下载 2.5 GB
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BODY="$ROOT/tools/cli/install-torch.js"

# Under Git-bash / MSYS (a real environment people deploy from on Windows),
# `pwd` yields an MSYS path like /d/Project/x, which a NATIVE node.exe cannot
# resolve - it resolves it against the current drive and yields
# "D:\d\Project\x\..." = module not found. `pwd -W` hands back the Windows form.
# On Linux/macOS there is no -W flag, so the || fallback keeps the POSIX path.
if [ -n "${MSYSTEM:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -W)"
  BODY="$ROOT/tools/cli/install-torch.js"
fi

if [ ! -f "$BODY" ]; then
  echo "[torch][ERROR] 找不到主体：$BODY" >&2
  echo "        这个脚本只负责调用它，本体不在说明安装包不完整。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[torch][ERROR] 找不到 node。" >&2
  echo "        主体是 Node 写的（和后端、前端同一套运行时），" >&2
  echo "        所以装 Node 是部署的前置条件，不是可选项。" >&2
  echo "        nvm install --lts   或   https://nodejs.org" >&2
  exit 1
fi

# exec：让主体的退出码与信号原样传出（薄壳不该吞掉失败）
exec node "$BODY" "$@"