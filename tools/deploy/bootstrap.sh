#!/usr/bin/env bash
# =============================================================================
#  bootstrap.sh - macOS / Linux thin shell. The body lives in
#                  tools/deploy/bootstrap.js
#
#  NO LOGIC HERE ON PURPOSE. Windows runs bootstrap.bat, which calls the SAME
#  Node body - so the two platforms cannot drift apart.
#
#  Steps: locate Python 3.11 -> create venv -> install deps -> torch (delegated)
#         -> ffmpeg -> npm ci -> self-check -> models.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Under Git-bash / MSYS, `pwd` yields an MSYS path like /d/Project/x, which a
# NATIVE node.exe cannot resolve - it resolves against the current drive and
# yields "D:\d\Project\x\..." = module not found. `pwd -W` hands back the
# Windows form. On Linux/macOS there is no -W flag.
if [ -n "${MSYSTEM:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -W)"
fi

BODY="$ROOT/tools/deploy/bootstrap.js"

if [ ! -f "$BODY" ]; then
  echo "[deploy][ERROR] 找不到主体：$BODY" >&2
  echo "        这个脚本只负责调用它，本体不在说明安装包不完整。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[deploy][ERROR] 找不到 node。" >&2
  echo "        主体是 Node 写的，所以装 Node 是部署的前置条件，不是可选项。" >&2
  exit 1
fi

# exec：让主体的退出码与信号原样传出（薄壳不该吞掉失败）
exec node "$BODY" "$@"
