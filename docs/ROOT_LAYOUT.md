# 根目录准入表

> 权威。`lib/root_layout.node.test.js` 直接解析本文件的表格。
> **根目录只允许出现下表登记过的条目**，多一个就红。

## 为什么是反向白名单

batch13 的第一版守卫列的是**坏名字的形状**（`apply-*` / `probe_*` /
`collect_*` / `sources_*.zip`）。2026-08-20 当场失效一次：助手换了个
`precheck_` 前缀扔进根目录，守卫一声没响，读数仍是「助手产出物：无 ✅」。

**按坏名字认目标 = 只抓我想得到的那几种。**「没检查」和「检查过且干净」
读数相同，是本项目反复付学费的同一种缺陷。

## 表

| 条目 | 类型 | 归属 / 判据（丢了会怎样） | 必须存在 |
|---|---|---|---|
| `server.js` | 文件 | 我们的服务端入口。也是全项目定位项目根的锚点（C7） | 是 |
| `package.json` | 文件 | 依赖与脚本定义 | 是 |
| `package-lock.json` | 文件 | 锁定版本，必须与 package.json 同进退 | 是 |
| `README.md` | 文件 | 项目说明 | 是 |
| `LICENSE` | 文件 | 我们的许可证（MIT） | 是 |
| `NOTICE` | 文件 | 第三方归属声明，合规义务 | 是 |
| `requirements.txt` | 文件 | Python 依赖（torch 三行刻意注释掉，见头部说明） | 是 |
| `start.bat` | 文件 | 启动器 | 是 |
| `stop.bat` | 文件 | 停止器 | 是 |
| `deploy.bat` | 文件 | 部署入口 | 是 |
| `.env.example` | 文件 | 环境变量样例；真 `.env` 不进 git | 是 |
| `.gitattributes` | 文件 | 换行符规则（`*.ps1`/`*.bat` = CRLF），改错会让整份文件在 diff 里变红 | 是 |
| `.gitignore` | 文件 | 哪些东西不进 git。改它必须双向验（D19） | 是 |
| `lib` | 目录 | 我们的服务端代码。上游根本不知道它存在 | 是 |
| `web` | 目录 | 我们的前端 | 是 |
| `engines` | 目录 | 能选的 TTS 引擎，一个目录一个引擎；**换引擎时跟着换** | 是 |
| `pipeline` | 目录 | 打标 / 分离 / 切片，所有引擎共用；换引擎时不换 | 是 |
| `tools` | 目录 | 构建 / 部署 / 检查 / 开发脚本（助手产出物归 `tools/dev/`） | 是 |
| `docs` | 目录 | 契约与决策记录。本文件也在这里 | 是 |
| `data` | 目录 | 用户的东西：改过、删了要不回来 | 是 |
| `vendor` | 目录 | 第三方**成品**（ffmpeg / micromamba）：原封不动就能跑，我们没改过一行 | 否 |
| `models` | 目录 | 全部权重。二进制、能重新下载、不进 git | 否 |
| `assets` | 目录 | 用户音频资产根（`lib/paths.js` 的 `ASSETS_ROOT`，可被环境变量改到别处） | 否 |
| `.staging` | 目录 | 与 `assets` 同盘的原子暂存（`STAGING_ROOT`），保证 rename 不跨盘 | 否 |
| `cache` | 目录 | 全部可再生缓存（`lib/paths.js` 的 `CACHE_DIR`）。补丁备份也归这里 | 否 |
| `outputs` | 目录 | 合成产物 | 否 |
| `logs` | 目录 | 运行日志 | 否 |
| `dist` | 目录 | `tools/build/04_pack_release.py` 的发行产物 | 否 |
| `node_modules` | 目录 | npm 依赖，可重装 | 否 |
| `venv` | 目录 | Python 虚拟环境，可重建 | 否 |
| `THIRD_PARTY_LICENSES` | 目录 | 第三方许可证正文，合规义务 | 否 |
| `.git` | 目录 | git 自己 | 否 |
| `GPT_SoVITS` | 目录 | **空壳，不是权重树**。上游 `engines/gpt-sovits/infer/TTS.py` 的 `TTS_Config.__init__` 有一句无条件的 `os.makedirs("GPT_SoVITS/configs/")`，相对引擎 CWD（= 项目根，`infer_server.py:62` 显式 chdir，`_aurivox_relativise_paths` 依赖它）。本项目走 `lib/inference/tts_infer.yaml` 这条绝对路径，「用默认配置」那个分支永远不进 ⇒ **这个目录从不被读写，删掉毫无影响，下次起引擎会自动重建**。⚠ 放行的只是空壳：`lib/root_layout.node.test.js` 盯着它，里面一旦出现**任何文件**就红（顶层这棵权重树已于 batch14 移出项目，权重归 `models/`） | 否 |
| `.hermes` | 目录 | 已 ignore；`docs/SCOPE_r12c.md` §3 Batch 5 决定它是迁 `cache/hermes/` 还是留 | 否 |

## 改这张表的规矩

1. **先问「它是什么、丢了会怎样」**，答不上来就说明它不该在根目录。
2. 助手产出物（补丁 / 探针 / 采集器 / 源码快照）**永远不登记**，一律 `tools/dev/`。
3. 缓存**永远不登记**，一律走 `lib/paths.js` 的 `CACHE_DIR`。
4. 登记必须写理由。没有理由的豁免等于没有规则 —— 清单会腐烂成
   「加进去就不红」的垃圾场。
