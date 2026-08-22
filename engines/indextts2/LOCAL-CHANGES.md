# LOCAL-CHANGES — IndexTTS2

**当前：无本地改动。**

## 实证

2026-08-21，在删 `.git` 之前于上游工作树跑：

```
> git -C D:\AI\index-tts status --short
?? checkpoints/config.yaml
```

唯一一条是 `checkpoints/config.yaml`，且是 **untracked（`??`）**。

⇒ 两个结论：
1. **上游代码零改动** —— 没有 `M`、没有 `D`，`indextts/` 整棵是干净的上游。
   因此本次接入**不触发 C5（改动登记）**。
2. `checkpoints/config.yaml` **不在上游 git 里** ⇒ 它是**运行时产物**
   （下载权重时带下来的），不是上游源码的一部分。它跟着 `checkpoints/`
   一起走，不属于本文件的记录范围。

## 这份文件为什么现在就写（而不是等有改动了再写）

`docs/ENGINE_CONTRACT.md` §6 判据 4 是「`vendor/` 下搜不到
`LOCAL-CHANGES.md`」—— 判据是**文件在不在**，不是**内容有没有**。
一棵上游树没有这个文件，和「有这个文件但写着无改动」，是两种不同的状态：
前者是**没人查过**，后者是**查过且当时是干净的**。

⚠ 而且 `vendor\{uvr5,asr,slicer}` 和 `engines\gpt-sovits\gsv_code\` 四棵树
**一个 LICENSE 都没有** —— 那是现成的合规缺口。这次接入是**把这件事做对**
的机会，别再复制那个缺口。

## 改动登记格式（将来真要改上游时用）

| 日期 | 文件:行 | 改了什么 | 为什么非改不可 | 上游能不能接受 |
|---|---|---|---|---|
| | | | | |

⭐ 「为什么非改不可」这一栏是重点：本项目对 IndexTTS2 的既定策略是
**不改上游一行**，靠三招绕开全部路径问题 —— ①不搬 `tests/` `cli_tests/`
`webui.py` `cli.py`；②`IndexTTS2(cfg_path=<abs>, model_dir=<abs>)` 显式传
绝对路径；③spawn 时设 cwd。
⇒ 任何一条新登记，都意味着这三招有一处失效了。**先确认三招真的用尽，
再动上游** —— 一旦开始改，每次上游升级都要重新合并。
