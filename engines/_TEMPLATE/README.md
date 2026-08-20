# 加一个 TTS 引擎

> 目录名以 `_` 开头 ⇒ 注册表会跳过它（见 `lib/engines/registry.js`）。
> 它是脚手架，不是一个可用引擎。

## 做什么

1. 复制本目录，改名为引擎 id（小写、连字符，如 `indextts2`）
2. 填 `manifest.json`
3. 把引擎源码放进 `infer/`（推理）、`train/`（微调，没有就不建）
4. 写 `LOCAL-CHANGES.md`：我们改了上游哪几行

## 不做什么

**不要改 `lib/` 下任何文件，不要改 `server.js`，不要改 `web/`。**

需要改它们才能跑起来，说明契约还漏了一处抽象 —— 那是要修的 bug，
不是这个引擎的特殊情况。请开 issue 说明卡在哪，不要就地打补丁：
就地打的那一处，下一个引擎还要再打一次。

## 目录形状

```
engines/<id>/
├── manifest.json     必需。没有它，注册表看不见这个目录。
├── setup.bat         可选。怎么装（依赖、独立 conda 环境等）。
├── driver.js         可选。怎么调它。缺省走 manifest.default_base_url 的 HTTP。
├── infer/            推理源码
├── train/            微调源码
└── LOCAL-CHANGES.md  我们改了上游哪几行；没改过的话，这东西该放 vendor/
```

最后一条是判据，不是客套：
**改过上游 ⇒ `engines/` 或 `pipeline/`；一行没改过的第三方成品 ⇒ `vendor/`。**

## manifest.json 各字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 是 | 必须与目录名一致，否则注册表报 `ENGINE_MANIFEST_ID_MISMATCH` |
| `label` | 是 | 界面上显示的名字 |
| `param_keys` | 是 | 这个引擎认识的参数名。**不在表上的键会被拦下并报错**，不是被忽略 |
| `default_base_url` | 否 | 推理服务默认地址 |
| `upstream` | 否 | 上游仓库地址 |
| `local_changes` | 否 | `LOCAL-CHANGES.md` 的相对路径 |

以 `_` 开头的键是注释，注册表会剥掉，不进运行时对象。

## 关于 `param_keys` 为什么必须逐个列

不列白名单、直接把用户给的参数全转发，看起来更省事，但那样
**参数名拼错时不会报错** —— 服务端忽略不认识的键，于是「我明明设了
`temerature`」表现为「设了没效果」，而不是一条错误。这类问题极难查。

所以：宁可多列几个键，也不要放开转发。

## 验收

```
node tools\run_tests.cjs
```

`lib/engines/registry.node.test.js` 会自动把新引擎算进去。若你改了
`lib/` 下的文件，`lib/paths.node.test.js` 的路径权威守卫多半会先拦下你。
