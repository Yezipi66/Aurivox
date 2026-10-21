# tools/dev

一次性 / 辅助性的开发脚本：补丁（`apply-*.py`）、探针（`probe_*`）、
源码采集器（`collect_*`）。

它们 **不是产品的一部分**，不进发行包，也不得被 `lib/` `server.js`
`web/` 引用。放在这里只为了两件事：根目录不再被刷屏，以及下次还找得到。

## 规矩

- 定位项目根一律 **上溯找 `server.js`**，绝不写 `dirname(dirname(...))`。
  数层数的写法一搬就失准，而且**不报错**（r12c batch13 当场抛了两例）。
- 补丁脚本一律：默认 dry-run / `--write` 留 `.bak` / `--restore` / `--selftest`。
- 探针只读。要改盘的写成补丁，不要混在探针里。

## 留下的脚本

还在用、或被代码与测试注释点名的：

| 脚本 | 用途 |
|---|---|
| `check-engine-env.cjs` | 检查一台引擎的环境，`tools/verify-engine.cjs` 与 README 指向它 |
| `audit-comments.cjs` | 注释与文案纪律的全树体检，注释抽取用 `@babel/parser`，不用正则猜 |
| `emit_profile.cjs` | 打印名片解析结果，`lib/engines/host.py` 的报错提示指向它 |
| `run_ab.py` `ab_capture.py` `ab_compare.py` `verify_launch.py` | 启动路径 A/B 对比与真实启动验收 |
| `probe_host.py` `probe_cli_host.py` `probe_profile_contract.py` `probe_verify_audio.py` | 需要起服务的手动探针，单测注释引用 |
| `probe_release_contents.py` | 发行包内容的反向检查，`tools/build/04_pack_release.py` 引用 |
| `clean_marks.cjs` `scrub_tone_safe.cjs` `scrub_tone_safe.py` `scrub_oral.js` | 注释清理工具，D2 期间还在用 |
| `snapshot-venv-packages.py` `reconcile-venv-vs-lock.py` | venv 与锁文件对账 |
| `verify-cache.ps1` | 合成缓存真机验收 |

## 归档

已执行完的补丁（`apply-*`）、变异测试（`mutate_*`）、测量脚本（`measure*`）、
一次性探针和运行产物已从主线删除，原样保存在 `archive/tools-dev` 分支。
需要时 `git checkout archive/tools-dev -- tools/dev/<文件>` 取回。
