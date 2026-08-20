# IndexTTS2 —— 尚未接入

## 现状

这个目录目前**只有安装脚本**，没有 `manifest.json`。

因此 `lib/engines/registry.js` **看不见它** —— 注册表只认带 `manifest.json`
的目录。在界面上选 `indextts2` 会得到：

```
这台服务器上没有装引擎 indextts2；已装的是：gpt-sovits
```

这是刻意的。半接上的引擎必须表现为「没装」，而不是「装了但一调就炸」。

## 这个目录为什么现在就存在

`setup.bat`（原 `setup_indextts_env_v2.bat`）此前躺在项目根目录，因为
r12c 之前没有任何地方能放它。它是第二引擎存在过的痕迹，不是垃圾。

顺带一提，`lib/workflow/recipeStore.js` 里的 `emo_vector` 字段注释写着
"Reserved for IndexTTS2 explicit 8-dim vector" —— 同一件事的另一半痕迹。

## 接上它要做什么

按 `engines/_TEMPLATE/README.md` 走：写 `manifest.json`（关键是把
IndexTTS2 认识的参数名逐个列进 `param_keys`），放推理源码，写
`LOCAL-CHANGES.md`。

**不要改 `lib/`、`server.js`、`web/`。** 需要改它们才能跑通，说明
引擎契约还漏了一处抽象 —— IndexTTS2 正是用来验这件事的第一个引擎。
