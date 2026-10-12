# 本轮文案语气问题清单（子 Agent 逐条核对着改）


## T1 App/common/generate/pron

- `web/src/App.jsx:280` — 读不了
- `web/src/App.jsx:309` — — (em dash)
- `web/src/App.jsx:390` — 那张
- `web/src/components/common/Dialogs.jsx:103` — 存不进
- `web/src/components/common/ErrorBoundary.jsx:45` — 这一块
- `web/src/components/common/Fields.jsx:74` — 知道了
- `web/src/components/common/Fields.jsx:99` — — (em dash)
- `web/src/components/common/Fields.jsx:126` — — (em dash)
- `web/src/components/common/Fields.jsx:141` — 随便填
- `web/src/components/common/Fields.jsx:143` — 边合边回
- `web/src/components/common/Fields.jsx:151` — 钉语言
- `web/src/components/common/Fields.jsx:156` — 显存吃紧/富裕
- `web/src/components/common/Fields.jsx:157` — 免重抽/保持热
- `web/src/components/common/Fields.jsx:204` — 知道了
- `web/src/components/common/ParamField.jsx:102` — 从库里挑一个
- `web/src/components/generate/GenerateTab.jsx:836` — 要多等一会儿
- `web/src/components/generate/GenerateTab.jsx:1016` — 重新跑一遍
- `web/src/components/pron/HanReview.jsx:138` — 不会点亮
- `web/src/components/pron/PronProofing.jsx:19` — 跟着…走

## T2 train/assets/broker

- `web/src/components/train/ParamCols.jsx:223` — — (em dash)
- `web/src/components/train/TrainingTab.jsx:767` — — 未安装
- `web/src/components/train/TrainingTab.jsx:779` — — 需下载
- `web/src/components/train/TrainingTab.jsx:783` — 已存
- `web/src/components/train/TrainingTab.jsx:939` — 听着干净就继续
- `web/src/components/train/TrainingTab.jsx:952` — 想省磁盘
- `web/src/components/train/trainConstants.js:57` — ★ 语气标记
- `web/src/components/train/trainConstants.js:58` — 最干净
- `web/src/components/train/trainConstants.js:78` — 最稳/出 NaN
- `web/src/components/train/trainConstants.js:82` — 更干净
- `web/src/components/train/trainConstants.js:91` — 爆显存
- `web/src/components/train/trainConstants.js:98` — 更吃显存
- `web/src/components/train/trainConstants.js:149` — 试跑
- `web/src/components/train/ReviewPanels.jsx:68` — 发糊/发闷
- `web/src/components/assets/RefineModal.jsx:220` — 跑切片

## T3 compare/engines/flowgraph

- `web/src/components/engines/EnginesTab.jsx:78` — 跑没跑
- `web/src/components/engines/EnginesTab.jsx:80` — 拦
- `web/src/components/engines/EnginesTab.jsx:102` — 读不出来
- `web/src/components/engines/EnginesTab.jsx:112` — 拉回来
- `web/src/components/engines/EnginesTab.jsx:132` — 自己起
- `web/src/components/engines/EnginesTab.jsx:206` — 本来就在跑
- `web/src/components/engines/EnginesTab.jsx:207` — 起来了
- `web/src/components/engines/EnginesTab.jsx:208` — 重开了一次
- `web/src/components/engines/EnginesTab.jsx:209` — 没有动它
- `web/src/components/engines/EnginesTab.jsx:210` — 好了
- `web/src/components/compare/ReferenceCompareTab.jsx:554` — — (em dash)
- `web/src/components/compare/CompareRow.jsx:645` — 走哪个/才有得选

## T4 web/src/lib

- `web/src/lib/engineActions.pure.js:47` — 起不了也停不了
- `web/src/lib/engineActions.pure.js:51` — 没装看管人
- `web/src/lib/engineActions.pure.js:55` — 多半/正在跑
- `web/src/lib/engineActions.pure.js:59` — 这一下/不用再点/⛔
- `web/src/lib/engineActions.pure.js:63` — 在跑了
- `web/src/lib/engineActions.pure.js:67` — 干活/半截音频/⛔
- `web/src/lib/engineActions.pure.js:71` — 没在跑
- `web/src/lib/engineActions.pure.js:97` — 还没拿到
- `web/src/lib/engineActions.pure.js:112` — 起起来/不用先点/⭐/内部原则
- `web/src/lib/engineActions.pure.js:123` — 放掉/用到它时
- `web/src/lib/engineActions.pure.js:153` — 还没量过
- `web/src/lib/engines.js:185` — 画不出/补上
- `web/src/lib/engines.js:451` — 没写底模在哪
- `web/src/lib/engines.js:465` — 要先去主页点同意/看着像
- `web/src/lib/engines.js:479` — 底模齐
- `web/src/lib/engines.js:485` — 底模没放
- `web/src/lib/engines.js:536` — 多半/正在跑
- `web/src/lib/engines.js:546` — 没在跑/自动起来
- `web/src/lib/engines.js:563` — 这一下/不用再点/⛔
- `web/src/lib/engines.js:584` — 在跑
- `web/src/lib/engines.js:785` — 读不到
- `web/src/lib/engines.js:787` — 读不到
- `web/src/lib/engines.js:808` — 都没在跑/用到才起
- `web/src/lib/engines.js:812` — 在跑的这些
- `web/src/lib/engines.js:819` — 没量过
- `web/src/lib/engines.js:829` — 在跑
- `web/src/lib/engines.js:870` — 没起来
- `web/src/lib/engines.js:872` — 没活着回来/被赶出来/几只/多半
- `web/src/lib/engines.js:882` — 吃到过
- `web/src/lib/engines.js:889` — 没量到
- `web/src/lib/engines.js:891` — 吃多少内存/没量到过
- `web/src/lib/engines.js:900` — 吃到/大概
- `web/src/lib/engines.js:909` — 吃多少内存/那是假的

## T5 lib/ 后端

- `lib/engines/checkpoints.js:121` — ——/你
- `lib/engines/supervisor.js:571` — ——
- `lib/engines/verifyAudio.js:72` — ——/拿什么合成
- `lib/engines/verifyAudio.js:149` — ——/多半
- `lib/engines/upstreamError.js:131` — — (em dash, 英文)
- `lib/engines/launchPlan.js:318` — ——
- `lib/engines/profile.js:43` — ——/你
- `lib/engines/payload.js:101` — ——
- `lib/flowgraph/qualityNodes.js:243` — 多半/对不上号/攒
- `lib/flowgraph/qualityNodes.js:340` — 多半/身上/读进来
- `lib/flowgraph/engine.js:298` — 你
- `lib/routes/engines.js:374` — 干活/跑完
- `lib/routes/flowgraph.js:145` — 开跑

## T6 tools/cli

- `tools/cli/install-torch.js:322` — 你/多半
- `tools/cli/install-torch.js:259` — ——
- `tools/cli/install-torch.js:392` — 载不进来/——
- `tools/cli/install-torch.js:394` — 最可能是
- `tools/cli/install-torch.js:334` — …(省略号)
- `tools/cli/install-torch.js:330` — ——
- `tools/cli/start.js:247` — ->
- `tools/cli/start.js:442` — 用到才起

共 100 处。
