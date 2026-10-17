# P0 拆分计划

> 目标：把两个超限文件（`server.js` 2217 行、`lib/engines/profile.js` 1334 行）
> 拆成职责单一的小模块。判据是「加一个新功能时只需要读一两个文件」，
> 不是「行数小于某个数」。

## 零、动手前必须知道的现状

一、**路由已经拆完了**。`server.js` 第 2043-2053 行挂载的是
`lib/routes/{system,engines,pron,voices,synthesis,outputs,assets,config,training,uvr5,recipes}.js`，
共 11 个路由模块。所以不要再拆路由，剩下的全是**业务逻辑与工具函数**。

二、**`server.js` 目前不可直接 require**。第 2144 行的 `app.listen(PORT, HOST, ...)`
没有 `require.main === module` 守卫，require 它就会起监听。
这是它没有单元测试覆盖的原因，拆之前要先把这条改掉（见任务 0）。

三、**`brokerHarness.node.test.js` 会扫 `server.js` 的全部相对 require**，
检查夹具 app 目录里能不能解析到。拆分后新增的模块文件必须能被夹具覆盖，
否则集成测试会因为 MODULE_NOT_FOUND 起不来。

四、**基线是绿的**：2385 tests / 2381 pass / 1 fail / 3 skipped。
那 1 条失败是 `root_layout` 守卫报项目根多了 `tmp/`（本机临时目录），
与本次拆分无关，但**重构期间要保持 1 fail 不变**，多了就是拆坏了。

## 一、任务 0：让 server.js 可以被 require

动文件：`server.js`

怎么做：把末尾的启动代码（`app.listen` + 启动日志）包进
`if (require.main === module) { ... }`。

为什么先做这一步：**不先做，后面每一步都没法验证**。
require 它才能写测试；`node server.js` 直接跑时行为完全不变。

验收：
- `node server.js` 仍然起监听（`require.main === module` 为真）
- 新增一个测试 require 它，不应当触发 listen

## 二、任务 1-8：拆 server.js

新建 `lib/server/` 目录。每拆一个模块一笔提交，模块之间不并行。

| 任务 | 新模块 | 从 server.js 搬走的函数 |
|---|---|---|
| 1 | `lib/server/middleware.js` | `isLoopback` `validateHost` `requireApiKey` `clientError` `localError` `safeStaticRoot` 与 CORS 配置 |
| 2 | `lib/server/text.js` | `splitJapaneseText` `forceSplitLong` `isPlaceholder` |
| 3 | `lib/server/paths.js` | `resolveRefPath` `toProjectRelative` `normalizeModelPath` `safeId` `importCustomRefToAsset` |
| 4 | `lib/server/synthesis.js` | `buildTtsPayload` `switchModels` `generateOneSegment` `_inferOneSegment` `resolveSeed` `resolveReference` |
| 5 | `lib/server/params.js` | `defaultAdvancedParams` `loadAdvancedParams` `saveAdvancedParams` `pronLexiconPath` `loadPronLexicon` `savePronLexicon` |
| 6 | `lib/server/genDir.js` | `newGenId` `genBaseName` `writeGenMeta` `resolveGenDir` `genItemFromMeta` |
| 7 | `lib/server/baseVoice.js` | `_mvFirstExisting` `normModelVersion` `checkBaseModelsForVersion` `isBaseVoice` `_baseS1Path` `baseCheckpoints` `baseModelsAll` `baseVoiceMeta` `baseVoiceReg` `collectTakenVoiceIds` `pickLatestByEpoch` `knownVoice` |
| 8 | `lib/server/migration.js` | `renameDirWithRetry` `renameVoiceFolder` `runMigrationJob` `readTranscriptListRows` `sanitizeCustomParams` `sleepSyncMs` |

搬完后 `server.js` 只留：require、中间件注册、静态目录、`ctx` 组装、
路由挂载、启动、`shutdown`。目标 400 行以内。

### ctx 对象怎么处理

第 2042 行的 `ctx` 是一个几百键的对象字面量，把上面这些函数传给路由模块。
搬走函数后，`ctx` 里对应的值改成从新模块 require 进来即可，
**键名一个都不许改**（路由模块按名字取值）。

### 硬性验收

- 每拆一个模块：`node --check server.js` 与 `node --check lib/server/<新模块>.js` 通过
- 每拆一个模块：全量 `node tools/run_tests.cjs` 跑一遍，
  目标 `2385 / 2381 / 1 fail / 3 skipped`，失败数不许涨
- 每拆一个模块：`node server.js` 能起到监听（手动起一次，确认没崩）
- **行为零变化**：不改任何路由路径、请求/响应形状、环境变量名、错误码

## 三、任务 9-13：拆 lib/engines/profile.js

新建 `lib/engines/profile/` 目录。同样每拆一个模块一笔提交。

| 任务 | 新模块 | 从 profile.js 搬走的函数 |
|---|---|---|
| 9 | `lib/engines/profile/fields.js` | `profileError` `required` `positiveInt` `requiredBool` `parseClipSeconds` `plainObject` `stringArray` `relPath` |
| 10 | `lib/engines/profile/maps.js` | `parseMethods` `parseMaps` `checkSlotSwitching` `retireHotSwap` `checkSlotParams` |
| 11 | `lib/engines/profile/models.js` | `parseModelsSource` `parseModelsExternal` `parseModels` `parseUpstream` |
| 12 | `lib/engines/profile/topkeys.js` | `editDistance` `nearestKey` `checkTopKeys` `sourceOf` `checkMeasuredSources` |
| 13 | `lib/engines/profile/paramSchema.js` | `schemaEntry` `parseParamSchema` `applyDefaultsEnv` |

搬完后 `profile.js` 只留 `resolveBaseUrl` `parseRuntime` `parseVerify`
和入口 `resolveEngineProfile`，加上 re-export。

### 硬性验收

- `profile.js` 的导出接口一个都不许变：
  `{ resolveEngineProfile, parseParamSchema, parseRuntime, parseUpstream, parseModels }`
- 外部引用方（`lib/engines/paramTable.js` 等）一行都不用改
- 全量测试保持 `2385 / 2381 / 1 fail / 3 skipped`
- **不改任何函数签名与返回值**

## 四、通用纪律

- 每个任务只动自己范围内的事，不做顺手重构
- 每完成一个模块就提交一次，commit message 用中文 + conventional commits
- 提交前用 `git diff --cached --name-only` 核对范围
- 不许 push、不许建分支、不许用 `git stash/checkout/reset/clean`
- 不许按行号区间批量搬移，逐段 patch
- 不许引入新依赖
- 拆分过程中若发现基线测试变色，立刻停下，回退到上一个绿点再查
- 测试命令：`node tools/run_tests.cjs > tmp/xxx.log 2>&1`（重定向可以，不要加管道）
- 临时文件放 `tmp/`，做完删掉（`root_layout` 守卫会因为根目录多东西报红）
