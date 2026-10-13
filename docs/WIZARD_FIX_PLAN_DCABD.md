# 向导五步修复计划（DCABD）

本文件是这一轮的技术报告与执行计划。完成后状态记在 docs/ONBOARDING_PLAN.md 台账，
本文件不记状态。

本文件自身遵守它立下的规矩：零符号语气、零 markdown 加粗、零日期体、零决策归属叙述。

## 0. 两条基准

基准一，注释的定位。代码注释只解释文件本身、代码块、代码行：这段在做什么、
为什么这样实现、什么输入会让它坏。以下四类不许出现在代码注释里，各有归属：

| 类型 | 例子 | 归属 |
|---|---|---|
| 现场经过 | 某次报障的过程、试错过程 | skill、git log |
| 归属叙述 | 谁在哪天定了什么 | docs 台账与契约 |
| 纪律宣告 | 本文件不许 X | 契约文档 |
| 情绪标记 | 各类强调符号、加粗 | 删 |

基准二，注释比例。单文件注释占非空行不超过 20%，力争 15%。

## 1. 现状实测

范围 tools/engine-wizard/ 下 core、editor、test 三个目录共 70 个源文件。
超 20% 的共 52 个，全部列出，按比例降序：

| 文件 | 注释/非空行 | 比例 |
|---|---|---|
| editor/folderName.js | 26/31 | 84% |
| editor/StepVerify.jsx | 26/44 | 59% |
| core/tierreview.js | 63/116 | 54% |
| core/paramsFromReflect.js | 343/726 | 47% |
| editor/downloadState.js | 18/38 | 47% |
| core/resolve.js | 144/318 | 45% |
| editor/useInstalled.js | 20/44 | 45% |
| core/env.js | 592/1335 | 44% |
| editor/steps.js | 111/251 | 44% |
| core/hardware.js | 190/473 | 40% |
| core/models.js | 77/196 | 39% |
| editor/useInstallSession.js | 68/175 | 39% |
| core/bridge.js | 27/71 | 38% |
| core/cliHelp.js | 153/403 | 38% |
| core/validate.js | 86/224 | 38% |
| editor/Pipeline.jsx | 37/97 | 38% |
| core/installState.js | 76/207 | 37% |
| core/probe.js | 157/436 | 36% |
| editor/index.jsx | 8/22 | 36% |
| test/clone.node.test.js | 94/280 | 34% |
| core/cliDraft.js | 25/75 | 33% |
| core/specbridge.js | 22/66 | 33% |
| core/wizardbridge.js | 368/1118 | 33% |
| test/folderName.node.test.js | 32/104 | 31% |
| core/clone.js | 68/224 | 30% |
| core/save.js | 58/191 | 30% |
| core/savebridge.js | 29/97 | 30% |
| editor/StepPrepare.jsx | 115/390 | 29% |
| test/asyncHandlerFallback.node.test.js | 82/282 | 29% |
| test/env.node.test.js | 148/502 | 29% |
| editor/App.jsx | 76/267 | 28% |
| test/env-venv.node.test.js | 222/800 | 28% |
| test/persistenceMutation.node.test.js | 93/346 | 27% |
| test/styleguard.node.test.js | 129/478 | 27% |
| core/paramDigest.js | 25/98 | 26% |
| editor/ManifestPage.jsx | 29/110 | 26% |
| test/steps.node.test.js | 51/194 | 26% |
| core/download.js | 133/531 | 25% |
| test/computeAutoFill.node.test.js | 66/263 | 25% |
| test/hardware.node.test.js | 70/277 | 25% |
| core/verify.js | 50/205 | 24% |
| editor/CliGenPanel.jsx | 84/356 | 24% |
| core/fieldmeta.js | 47/205 | 23% |
| core/instances.js | 32/139 | 23% |
| test/models.node.test.js | 56/247 | 23% |
| test/paramsFromReflect.node.test.js | 146/636 | 23% |
| test/validate.node.test.js | 38/164 | 23% |
| test/verify.node.test.js | 26/113 | 23% |
| editor/ManifestForm.jsx | 108/491 | 22% |
| test/cliHelp.node.test.js | 118/537 | 22% |
| test/bridge.node.test.js | 23/111 | 21% |
| test/tierreview.node.test.js | 30/140 | 21% |

folderName.js 是本轮新建文件，7 行代码配 26 行注释，是代码文件被当作草稿纸的样本。

## 2. 待清偿欠账

一笔已清：建 venv 未指定解释器的修复，提交 44068e0，只含 env.js 一个文件。

两笔未清，本计划覆盖：断点续传不认引擎 id，见 A5；全量测试的 stdin 非 tty 静默
退出，已在本轮修在代码里，见 D0。

## 3. 基线口径

全量测试当前 2301 tests，40 fail。这 40 条不是本次引入，也不作为可接受的常态：
每一项开工前先归类，属于我的、别人在途的、还是环境导致的，分类数字写进当次提交
说明。验收口径是分类后的我的部分为零，不是总 fail 数不变。

测试命令的管道与重定向已可用，不必规避。

## D. 注释归位与工程债

### D0 测试运行器不再静默退出

动文件：tools/run_tests.cjs
怎么改：原来写死 stdio 为 inherit，Node 的 test runner 在 stdin 不是 tty 时整体退出，
一条测试都不跑且只报一行 stdin is not a tty。改为按 stdin 是否 tty 分流，
非 tty 时用 pipe 并把子进程输出原样转写。
验收：带管道跑能正常输出 tests 与 fail 汇总；不带管道跑行为不变。
状态：本轮已改，随本计划一并提交。

### D1 守卫先立，且先扫自己

动文件：tools/engine-wizard/test/styleguard.node.test.js
怎么改：新增一条扫描代码注释的断言，判据是基准一那四类归属性内容：
四位年-月-日形态的日期、归属类词（由 D1 落地时在守卫里列出具体词表）、现场经过类词、
强调符号、markdown 加粗。范围限定 tools/engine-wizard/ 下的注释。

关于范围的分阶段处理：wizard 之外同样存在债务，但一次性全树会让报出上千条、
基线失真。分两步走，第一步 wizard，第二步全树，第二步在 D2 完成后单独一轮。
债务数量如实记账，不靠缩小范围让基线好看。

验收：
本计划文件与 D2 的目标文件，扫出来必须归零；故意写一条违规注释，守卫必须报它。
注意事项：判据正则不能误伤正常内容。日期体要避开版本号形态，
加粗只判 markdown 文档，不判代码注释里的乘号或指针语义。

### D2 注释只删不补

动文件：第 1 节列出的 52 个文件。
怎么改：逐文件删掉四类归属性内容。只删，不补写。删完仍超 20% 的继续删到比例以内。
删掉的内容迁往 skill 与 docs 台账，不是销毁。

锚点保护，这是本项最大风险：
测试用源码文本当锚点切片段，删注释删掉锚点会让测试靠找不到而静默通过，
等于守卫失效。做法是先用脚本把全部锚点 dump 成清单存到 docs/，
再逐个文件删，删完跑相关测试，锚点失效的改成不依赖注释的锚点。

动工前先跑脚本统计 tools/engine-wizard/test/ 下的锚点数量与位置，
本轮已统计：18 处。dump 脚本产出随本项提交。

scope：只删注释行，不动任何逻辑行。
验收：52 个文件逐个报比例，全部不超 20%；D1 守卫零违规；全量测试按基线口径归类后
我的部分为零；锚点清单里每一项都有对应处置记录。

派活：单独一个执行者串行做，不与其他项并行。删完补写是另一笔，单独验收。

### D3 双份真理收敛

动文件：core/validate.js、core/fieldmeta.js、core/hardware.js、
core/wizardbridge.js、core/resolve.js
怎么改：MEASURED_PAIRS 与 fieldmeta 的三档定义合成一份导出；
BACKEND_PREFERENCE 与 LICENSE_FILES 只保留 hardware 与 wizardbridge 各一处定义，
需要方 import；resolve.js 的 TAIL_FIRST_WORD 里 releases 写了两遍，合成一个；
wizardbridge.js 的 fetchRaw 把 raw.githubusercontent.com 的 main 写死，
改为分支可传入（与 C2 同源，由 C2 落地）。
验收：每个常量只有一处定义；有单测断言其值，不是只靠 grep 计数为零。
风险：合并时值合错而 grep 依然为零，所以必须补断言再合。

### D4 i18n 兜底

动文件：editor/StepPrepare.jsx、editor/StepDeps.jsx、editor/StepsExtra.jsx
怎么改：core/resolve.js 的全部 code 逐一对照各文件的错误映射表，缺的补齐；
仍缺时不再回落后端原文（会让中英文界面错配），改为未知错误加该 code 本身。
验收：遍历 resolve.js 的 code 断言每个都有映射；造未知 code 断兜底文案；
解析新增 code 而映射没跟上时守卫报错。
风险：code 列表与 resolve 不同步，用守卫测试兜住。

## C. 第 1 步探测缺口

### C1 license 识别

动文件：core/probe.js、core/wizardbridge.js
怎么改：probe.js 加 LICENSE 正文识别，覆盖两种形态：
多行标准头部（Apache License 加 Version 2.0 得 Apache-2.0，
Permission is hereby granted 得 MIT，GPL 三版、BSD、MPL 的标准头），
单行形态（整篇就一行 MIT License 或 SPDX 标识）。
wizardbridge.js 的 probe 分支把 LICENSE 正文取来交给它，分支由 C2 提供。
认不出保持 license 为 null 加 licenseEvidence 为 file-only，不做相似度猜测。
验收：标准头部、单行 MIT、空文件、自定义协议四种输入各有正确结果；
值字段只装标识不装句子。
边界：转录上游自己声明的是本分，推断上游没说的是编造。

### C2 分支探测

动文件：core/wizardbridge.js
怎么改：走 GitHub API 取 default_branch，取不到再回退 main 与 master。
不引入新依赖，用 node 内置 https。
验收：只读 master 的仓库、只读 trunk 的仓库、只读 main 的仓库，
三种都能读到 pyproject 与 LICENSE；API 不可用时如实报并回退，不假装读到。
注意：API 有速率限制，失败回退不能拖慢整个探测。

## A. 四个逃生口

判据：一个步骤可能卡死且没有合理退出方式，即为最高优先级缺陷。

### A1 克隆可取消

动文件：core/clone.js、editor/StepPrepare.jsx
怎么改：同步 spawn 改异步 spawn 加 AbortController；取消时删掉整个目标目录
（只删 .git 会留下残缺目录，下次卡在目录非空；目录由本步创建，删除是撤销本步操作）。
Windows 杀进程树用 taskkill 带 /T，不用 child.kill。
验收：克隆中点取消，进程树被杀、目标目录被删干净或回到创建前状态、
界面回到可重试态且不转圈；不取消的正常克隆不受影响。
注意：凭据管理器弹框会卡住且杀不掉，此时如实报无法取消，不假装成功。

### A2 装依赖可取消且不丢断点

动文件：core/env.js、editor/StepDeps.jsx
怎么改：执行层加 abort；取消时进度文件先落 in_progress 再转 done，
不能等整条命令跑完才写 key（原来那样一取消 key 就没落盘，下次从头）。
界面 busy 态给取消按钮。
验收：装到一半取消，进程真停（不是只断前端流）、结果如实报已取消、
已成功步骤仍在断点记录里、重跑跳过它们。
注意：前端流断开不等于进程停止，必须真的杀进程。

### A3 下载可暂停、可删半截

动文件：core/download.js、editor/StepsExtra.jsx
怎么改：
校验用上已有原料：download.js 已能算本地 sha 且已带上游 sha 字段，
weightsOnDisk 改为有 sha 就校验，没有就只判大小，不假装校验过。
半截定义扩大：大小为 0、sha 不符、或大小介于 0 与上游给的大小之间，都算半截，
提供删除后重下。
暂停：暂停前端逐个文件的循环，界面写明当前文件会跑完才停，
不杀进程（hf 自带缓存，重跑同一条命令只补缺的）。
验收：三种半截都能被标出且可一键删；删后重下只补该文件；暂停后续跑正常；
上游没给 sha 时不报已校验。
注意：暂停不是立即停当前文件，界面必须说清，否则是欺骗。

### A4 名片存盘有备份

动文件：core/save.js
怎么改：覆盖前把原文件存成 manifest.json.bak，只保留一份；
写入失败不动原文件，rename 失败从 bak 恢复。
验收：覆盖后 bak 内容等于覆盖前；二次覆盖 bak 是上一次的；
故意让写入失败，原文件未被破坏。
注意：engines 下的文件本就被忽略，不需要额外加忽略规则。

### A5 断点续传认引擎 id

动文件：core/installState.js
怎么改：跳过判据加引擎 id 一致性检查，与进度文件里记录的不一致则整段作废重来，
不继承别人的完成记录。这是 44068e0 那一笔的同源另一面：那笔修 id 从哪来，
这笔修别人的记录不算我的。
验收：构造 A 引擎的进度文件后请求装 B，全部重跑不跳过；
同引擎同命令照旧跳过，断点续传本身不废。

## B. 第四步核心

### B1 参数池与槽位绑定

动文件：新建 editor/DragBind.jsx；改 editor/CliGenPanel.jsx、editor/CoreBindings.jsx
怎么改：
参数池把 cli 扫出的 flag 与 python 反射出的参数名渲染成可操作项，
按子命令或加载期分组，每项带上游原话说明。
绑定目标为 call.bind 三槽位与 call.args 列表。
绑定不直接写盘：改为内存态，用户显式保存才落盘，
避免拖错一次产生一份错误备份。
三种操作方式都要支持：鼠标拖动、点击选中再点目标、键盘。
触屏与无鼠标环境下点击路径是主路径，拖动是增强。
保留现有扫描预填作为初值，用户可纠正。
验收：三种方式都能建立绑定；JSON 视图看得到真实落点；
不产生平台不认识的键；拖错允许，由存盘校验兜，绑定阶段不拦截；
显式保存前刷新页面，manifest 未被改动。
注意：操作说明按基准一写，不用符号不用破折号；
每个可操作项要说明它是什么、拖到或点到哪、会发生什么。

## 4. 执行编排

四路并行，文件不交叠：

第一路 D1 与 D2，串行内部两步，独立进行，不与其他路并行。
第二路 C1 与 C2，两者同源（都要分支信息），必须同一路。
第三路 A1 与 A2，都要动 editor 的对应步骤组件，串行。
第四路 A3 与 A4，文件不交叠，可并行两项。

D3 与 D4 挂在第一路之后（它们也改注释密集的文件，避免与 D2 抢同一文件）。
B1 最后，理由：逃生口没补上前，第 4 步出错用户仍无路可走。

每一路的通用验收：
测试按第 3 节口径归类，我的部分为零；
改动文件逐个语法解析通过；
D1 守卫零违规；
提交只含本范围文件，动工前与提交前各核一次暂存区清单。

git 红线：禁用会重置工作区的命令；禁用改写历史；
工作区有别人在途文件时只提交自己改的具体路径；
读旧代码用 git show 读临时文件。

## 5. 派活要求

每路任务书必带：本计划对应小节的原文、scope 文件清单、验收与注意事项、
git 红线，以及一句：凡涉及具体内容的自己读原文件核实，不复述转述。
