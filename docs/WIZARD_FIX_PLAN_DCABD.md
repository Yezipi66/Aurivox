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

## 1. 现状

范围 tools/engine-wizard/ 下 core、editor、test 三个目录共 70 个源文件
（加统计脚本自身为 71）。超 20% 的共 52 个，全部列出，按比例降序：

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

其中 env.js、wizardbridge.js、StepVerify.jsx 三个文件同时归第 4 节的其他路，
第一路 D2 不碰，见第 4 节排除说明。第一路实际删注释的文件数是 49 个。

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

完成记录（已通过三次独立验收）：

改动文件：tools/engine-wizard/test/styleguard.node.test.js 一个文件，无其他。
提交：e124670 首版立守卫（经独立验收判不通过，抽取用逐字符状态机，
      把正则字面量与源码中的反引号当字符串起点，两个引号之间整段吞掉）；
      da86fb4 抽取改用 @babel/parser 的 ast.comments，重跑债务台账为 babel 真值
      并对账（台账 2105 行，与 babel 真值逐文件相等）；
      94a5465 修两处必修项（单位混用表述、覆盖率断言静默缺口）。
状态：通过。三条存量失败（引擎名两条、界面 emoji 一条）为既有问题，不属本项。
      验证发现的两个要点记此备查：其一，旧状态机在 hardware.js 上是漏扫 4 行
      （旧集合为 babel 集合的真子集），在本文件上则多抽 2 行代码（正则字面量里的
      斜杠被误判），两者方向不同；其二，计数必须同单位，节点数与行数相减无意义。
      债务台账 2105 行为 D2 的基线。

### D2 注释只解释代码

目标一句话：注释只解释文件、代码块、代码行。不解释代码的删掉，该解释而没解释的补上。

怎么改：逐行读代码与它的注释，一行一行判断。判断标准只有一条：
这行注释在解释代码吗？
  在解释，留着（哪怕它提到了某条规则、某个约束、某个坑，那也是解释代码为什么这样写）。
  不在解释（记录谁在哪天做了什么、复述代码已经写明的、同义反复、纯强调标记），删掉。
  该解释而没有（代码里有不显然的约束、边界、坑，注释没说），补一句。
四类归属性内容（现场经过、归属叙述、纪律宣告、加粗）是典型违规，出现即删。

不设比例靶子。注释都干正事，比例自然低；比例高说明废话多，那是症状不是目标。
按比例删会走偏：把注释删光得 0% 也算达标，那是错的。

验收：逐文件读一遍，能回答三件事就算过：
它做什么、为什么这样写、什么输入会出问题。答不上来就是没做好。

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

### D5 安全白名单

这是本计划此前最大的缺口：D3 收敛真理、D4 收 i18n，却没有一条管安全。
铁律「平台不猜装法」的后果是名片里写什么平台就 spawn 什么，
而名片是人写的或被自动生成填进去的，一条错误或恶意的 env_command 会被原样执行。

动文件：core/env.js、core/clone.js、core/save.js

怎么改：
env.js 的 readEnvCommand 现在只校验非空字符串数组（约 76 行），
不看 argv[0] 是什么。增加可执行文件白名单，只允许 uv、python、pip、uvx、conda
五种，超出的直接返回 BAD_ENV_COMMAND 并不执行。
白名单要可测，并写清为什么是这五种：它们是声明跨平台 Python 依赖安装事实的最小集。
clone.js 与 save.js 的 OUT_OF_SCOPE 现在用 path.relative 判前缀，
加 fs.realpathSync 再判一次真实路径，挡符号链接穿透。

验收：
名片 env_command 为 rm -rf 形态时返回 BAD_ENV_COMMAND 且不执行；
五种白名单内命令照常执行；符号链接指向 engines 之外时读与写都被拒。
风险：白名单过严会让正常引擎装不上，所以白名单要随新增合法装法演进，
且拒绝时给的文案必须说清缺什么、怎么补。

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
现状（已体检核实）：
  fetchRaw 第 137 行把分支写死为 main，不接受参数。
  非 200 一律 resolve(null)，403（限流）与 404（不存在）不区分。
  handleProbe 最多串行发 18 次请求（5 依赖 + 7 许可 + 5 下载脚本 + README），
  每次 20 秒超时，全打到 main 上。
  全仓库没有 api.github.com 调用，没有共享 HTTP 封装，也没有缓存。

怎么改：走 GitHub API 取 default_branch，取不到再回退 main 与 master。
不引入新依赖，用 node 内置 https。

本项与 D3 的 fetchRaw 改动是同一处，合并做：
  fetchRaw 签名加分支参数（D3 要求「分支可传入」），
  再把 handleProbe 的所有调用点改成分支从探测结果来。
  不再分两次改同一个函数。

可复用：hardware.js 的缓存模式（_cache / _cacheAt / CACHE_MS 5 分钟）照搬。

缓存：同一个 owner 与 repo 组合的分支结果缓存 5 分钟，
第 1 步要扫多个候选文件，不能每个文件都调一次 API。
速率失败：API 返回 403 或速率限制时如实报 RATE_LIMITED 并立刻回退
main 再到 master，不重试不等待，整个探测不得因此多花 10 秒。

验收：只读 master、只读 trunk、只读 main 三种仓库都能读到 pyproject 与 LICENSE；
连续扫多个候选文件时 API 调用次数为 1；
API 403 时探测总耗时不显著增加，且结果来自回退分支而非假装读到。

C 块完成记录：

改动文件：core/wizardbridge.js、core/probe.js、test/licenseText.node.test.js。
提交：09dae82（C2 分支探测 + fetchRaw 加 branch 参数，合并 D3 的同源改动）、
      e8e0a27（C1 LICENSE 正文识别 + 14 条测试 + 变异验证）。
状态：不通过（独立验收抓到缓存命中路径的形状缺陷），已修复见 c2dcf01。
      四个真实仓库验证结果：两台的 Apache-2.0 与一台的 AGPL-3.0 从 LICENSE 正文识别出，
      一台的自定义协议由 pyproject 字段给出。三种来源（pyproject 字段、
      LICENSE 正文、认不出时 file-only）各自工作，没有一处靠相似度猜。
      全量 2324 条测试、39 失败，与基线一致（新增 14 条全绿）。

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

回滚：取消后 .venv 里是一半的依赖，下次 uv sync 会以为环境是好的。
取消时在 .venv 里写一个标记文件标明环境不完整，重跑先删掉整个 .venv 再建，
或用 uv sync --reinstall 重建，接着用半个环境不在允许范围内。

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
注意：暂停不是立即停当前文件。界面文案写死这一句：
当前文件下载中，暂停将在当前文件完成后生效。
不写清楚就是欺骗用户。

### A4 名片存盘有备份

动文件：core/save.js
怎么改：覆盖前把原文件存成 manifest.json.bak，只保留一份；
写入失败不动原文件，rename 失败从 bak 恢复。
验收：覆盖后 bak 内容等于覆盖前；二次覆盖 bak 是上一次的；
故意让写入失败，原文件未被破坏。
注意：engines 下的文件本就被忽略，不需要额外加忽略规则。

完成记录（已通过独立验收）：
改动文件：core/save.js、test/saveBackup.node.test.js。
提交：774f843（覆盖前留备份，只留一份）、d97a873（测试加真目录哨兵）。
状态：通过。

### A5 断点续传认引擎 id

动文件：core/installState.js
怎么改：跳过判据加引擎 id 一致性检查，与进度文件里记录的不一致则整段作废重来，
不继承别人的完成记录。这是 44068e0 那一笔的同源另一面：那笔修 id 从哪来，
这笔修别人的记录不算我的。
验收：构造 A 引擎的进度文件后请求装 B，全部重跑不跳过；
同引擎同命令照旧跳过，断点续传本身不废。

完成记录（已通过独立验收）：
改动文件：core/installState.js、test/installStateEngineId.node.test.js。
提交：b7c3ee7（readProgress 比对 data.engine；同一笔修了 writeProgress 与
      resetProgress 不建目录的连带缺陷）。
状态：通过。

已完成（提前于本项，做 D 期间修掉的，此处记账以免重复）：

core/env.js 的 stepArtifactExists 在生产代码里是变异态：函数体只有
return true 加一行「变异」注释，真实产物检查从未落地，调用点与
sitePackagesNonEmpty 辅助函数都在，唯独主函数是桩。引入于 9d0e457
（那笔的提交信息写的是「断点续传加产物检查」，实际交付的是桩）。
改为真实判断，并加四条测试加反向验证。提交 6ba17aa。

为什么提前修：D 的独立审查把「注释与代码矛盾」列为本轮最严重问题之一，
该条即在其列。按顺序它属本项，故在此记账，本项执行时不再重复。

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

### B2 第 5 步验证不再留给占位

第 4 步做完向导仍然不能出声，第 5 步此前只有占位说明，
StepVerify.jsx 现在 46 行、注释占 26 行，全是解释为什么没做。

动文件：editor/StepVerify.jsx、core/verify.js
怎么改：三项各自独立、各自报状态，不绑成一个必须全过的门：
第一项 ffprobe 读音频信息（时长、采样率、声道）；
第二项波形可视化，复用 web/src/components/common/Player.jsx 已有的能力，
根因在 verify_audio.py 只回报字节数就丢掉音频本体，要先让它把音频带出来；
第三项 ASR 反向识别，可选，命中已有逻辑。
做不到的项如实写未实现并说明卡在哪一项，不用占位注释糊弄。

验收：三项各有实现或各有明确的未实现说明与卡点；
ffprobe 一项能对一台已装引擎产出的音频给出真实信息。

## 4. 文件归属锁（并行前先定，防撞车）

同一文件同一时间只归一路。按本条核对 scope，冲突就调整归属，不是靠自觉。

| 文件 | 归属路 |
|---|---|
| core/env.js | 第三路（A1、A2、A5）与 D5 |
| core/installState.js | 第三路 |
| core/download.js、editor/StepsExtra.jsx | 第四路 |
| core/save.js | 第四路（D5 的 save 部分同路） |
| core/clone.js | 第三路 |
| core/wizardbridge.js | 第二路（C1、C2）与 D3 的 fetchRaw 部分 |
| core/cliHelp.js 等第 1 节清单里的剩余文件 | 第一路（排除下方三个共用文件） |
| core/probe.js | 第二路 |
| editor/StepVerify.jsx、core/verify.js | 第五路 |

以下三个文件同时出现在第 1 节清单与第 4 节归属表里，属于多路共用，
第一路 D2 期间一律不碰，它们的注释归位在各自那一路做：

core/env.js 归第三路（A1、A2、A5）与 D5。
core/wizardbridge.js 归第二路（C1、C2）与 D3 的 fetchRaw 部分。
editor/StepVerify.jsx 归第五路。

D3 的 fetchRaw 改动并入第二路，因为 C2 就是改 fetchRaw 的分支参数。
第一路 D2 清单从第 1 节排除上述三个文件，剩余 49 个。
比例验收按剩余 49 个统计，三个共用文件的比例在各自那一路收口时一并验。

## 5. 执行编排

四路加一条收尾，文件互不交叠：

第一路 D1、D2。内部串行，先立守卫再删注释。与其他路并行。
第二路 C1、C2、D3 的 fetchRaw 部分。C1 与 C2 同源必须同路。
第三路 A1、A2、A5、D5 的 env 部分。都要动 editor 的对应步骤组件，串行。
第四路 A3、A4、D5 的 save 部分。三项文件不交叠，可并行。

D5 安全白名单横跨两路，不是一路的活：env.js 白名单归第三路，
save.js 的 realpath 判越界归第四路。两路都要做，各做各的那一半。

第五路 B1、B2。最后做，理由：逃生口没补上前，第 4 步出错用户仍无路可走，
第 5 步要在第 4 步能存盘之后才验得了出声。

每一路的通用验收：
测试按第 3 节口径归类，我的部分为零；
改动文件逐个语法解析通过；
D1 守卫零违规；
提交只含本范围文件，动工前与提交前各核一次暂存区清单。

## 6. 每一步的验收流程（硬闸门，不许跳）

```mermaid
flowchart LR
    A[派实现子 Agent] -->|实现，过程中原子化提交| B[实现完成]
    B --> C[派独立子 Agent 验收]
    C --> D{验收通过}
    D -->|否| A
    D -->|是| E[更新计划]
    E --> F[提交计划变动并推送远端]
```

三条不可协商的部分：

一，验收方必须是独立子 Agent，不能是实现它的那个。实现者的自述不作为验收依据。
二，未通过时不更新计划、不推送，回到实现。不许带着未通过的项往下走。
三，通过之后才做计划更新与推送。计划更新要写清三样：这一轮改了哪些文件、
每项实现各是哪个提交、该小节的状态。写完随本计划一起提交并推送。

实现子 Agent 的纪律：实现过程中就原子化提交，一个独立问题一笔，
不许攒到最后；不许 push、不许建分支；实现完成后只读不改，等验收。

独立验收子 Agent 的纪律：不许 commit、不许 push、不许改任何实现文件；
只跑测试、只读代码、只比对 scope 与验收点，输出逐条通过与不通过及证据。

## 7. 验收口径写死

注释比例的口径：注释行数除以非空行数。空行不计入分母。
只有右花括号或右括号的单独一行计入分母，它是一行有效代码。
跨行注释整段计入注释行。统计以随本计划提交的统计脚本输出为准，
口径固定为：只统计 tools/engine-wizard/ 下的 js、jsx、cjs、mjs，
排除后缀为 bak 的文件，空行不计入分母，右花括号或右括号单独一行计入分母。
本机没有 cloc，所以不引入外部依赖，用仓库内脚本固化口径。
目标是每个文件不超 20%，力争 15%。

失败归因的责任与时点：
开工前由该路执行者把自己的 scope 内测试跑一遍，wizard 范围内的失败先归因。
D1 结束时 wizard 相关的失败清零；
D2 结束时全量失败里属于 wizard 与本轮改动范围的清零；
每一路收口时，本路 scope 内的失败归因清零；
平台其他部分与环境导致的失败单独记账，说明为什么不是本轮责任。
归因结论写进当次提交说明，不许只写数字。

下列三项由脚本产出、随提交落库，不接受口头结论：
52 个文件删前删后的比例对照表；
测试锚点 dump 清单及其逐项处置记录；
每次全量测试的失败清单按我的、别人在途的、环境的三分类归因表。

## 8. 派活要求

每路任务书必带：本计划对应小节的原文、scope 文件清单、验收与注意事项、
git 红线、第 6 节的流程说明（实现方与验收方各自能做什么不能做什么），
以及一句：凡涉及具体内容的自己读原文件核实，不复述转述。
