#!/usr/bin/env bash
# =============================================================================
#  stop.sh - macOS / Linux thin shell. The body lives in tools/cli/stop.js
#
#  NO LOGIC HERE ON PURPOSE. Windows runs stop.bat, which calls the SAME Node
#  body - so the two platforms cannot drift apart.
#
#  Stops the backend and any inference engine that holds a port, then sweeps
#  leftovers whose executable lives inside this install root.
#
#  See the header of tools/cli/stop.js for why that sweep exists at all.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Under Git-bash / MSYS (a real environment people run this from on Windows),
# `pwd` yields an MSYS path like /d/Project/x, which a NATIVE node.exe cannot
# resolve - it resolves against the current drive and yields
# "D:\d\Project\x\..." = module not found. `pwd -W` hands back the Windows form.
# On Linux/macOS there is no -W flag, so MSYSTEM being unset keeps the POSIX path.
if [ -n "${MSYSTEM:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -W)"
fi

BODY="$ROOT/tools/cli/stop.js"

if [ ! -f "$BODY" ]; then
  echo "[stop][ERROR] 找不到主体：$BODY" >&2
  echo "        这个脚本只负责调用它，本体不在说明安装包不完整。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[stop][ERROR] 找不到 node。" >&2
  echo "        主体是 Node 写的（和后端同一套运行时），所以装 Node 是前置条件。" >&2
  exit 1
fi

# exec：让主体的退出码与信号原样传出（薄壳不该吞掉失败）
exec node "$BODY" "$@"