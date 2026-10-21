# 反射实测记录：环境修好后的第一次跑通（2026-10-09）

> 分支：`research/engine-onboarding-complexity`
> 口径：`[实测]` = 在本机跑出来的。
> 环境缺陷的根因见 [`ENGINE_ENV_DEFECTS_2026-10-09.md`](./ENGINE_ENV_DEFECTS_2026-10-09.md)。

## 一句话

**`lib/engines/reflect_params.py` 第一次在真引擎上跑通。**
在此之前它一直失败 —— 不是工具的问题，是**环境坏了**（见缺陷 1 / 2）。

## 实测命令

```bash
# spec
{"module":"indextts.infer_v2_5","class":"IndexTTS2","method":"infer",
 "sys_path":["engines/index-tts"]}

engines/index-tts/.venv/Scripts/python.exe lib/engines/reflect_params.py --spec-file <spec.json>
```

## 实测结果

```
ok: True
class: indextts.infer_v2_5.IndexTTS2 | method: infer
load 参数: 9 个
call 参数: 16 个
warnings: []
```

### load（构造期）—— 9 个

| 参数 | 默认值 | 反射的类型线索 | 名字线索 |
|---|---|---|---|
| `cfg_path` | `'checkpoints/config.yaml'` | text | path? |
| `model_dir` | `'checkpoints'` | text | path? |
| `use_bf16` | `False` | boolean | boolean |
| `device` | `None` | unknown | — |
| `use_cuda_kernel` | `None` | unknown | boolean |
| `use_deepspeed` | `False` | boolean | boolean |
| `use_accel` | `False` | boolean | boolean |
| `use_torch_compile` | `False` | boolean | boolean |
| `use_qwen_emo` | `False` | boolean | boolean |

### call（调用期）—— 16 个

| 参数 | 默认值 | 反射的类型线索 | 名字线索 |
|---|---|---|---|
| `spk_audio_prompt` | `None` | unknown | **audio** |
| `lang` | `None` | unknown | — |
| `emo_audio_prompt` | `None` | unknown | **audio** |
| `emo_alpha` | `1.0` | number | number |
| `emo_vector` | `None` | unknown | **number[]** |
| `use_emo_text` | `False` | boolean | boolean |
| `emo_text` | `None` | unknown | **text** |
| `use_random` | `False` | boolean | boolean |
| `interval_silence` | `200` | integer | number |
| `verbose` | `False` | boolean | — |
| `max_text_tokens_per_segment` | `120` | integer | — |
| `stream_return` | `False` | boolean | — |
| `more_segment_before` | `0` | integer | — |
| `duration_factor` | `1.0` | number | — |
| `text_normalization` | `True` | boolean | text |

⚠️ `text` 本身不在列表里 —— 它是**位置参数**（`def infer(self, spk_audio_prompt, text, output_path, lang, ...)`），
反射工具按设计只收带名字的参数。这符合预期：`text` 是 `call.bind.text` 要绑的东西，
不归 `parameters[]` 管。

## 这次实测证明了什么

### ✅ 证明 1：反射这条路是通的

在环境修好之前，**没有人**能在真引擎上验证反射 —— 所以
`ONBOARDING_PLAN.md` 的欠账 N6（`--help` 解析器）一直没做，
因为「起引擎解释器跑东西」这件事在坏环境上根本做不了。

### ✅ 证明 2：反射的产出正是「用户要对照的东西」

[实测] 反射直接给出**参数名 + 默认值 + 类型线索**。这正是
「把别人项目里可调用的参数提取出来让用户看」所需要的那张表。

⚠️ 但要记住反射的**三条自限**（写在 `reflect_params.py` 头注里）：
它**不猜**取值范围、不猜该是滑块还是下拉、不猜中英文标签、不猜条件依赖。

### ⚠️ 证明 3：反射的类型线索是「弱证据」

[实测] 16 个 call 参数里，**8 个的 `kind` 是 `unknown`**（默认值是 `None`）。
它们靠**名字线索**兜底（`spk_audio_prompt` → audio、`emo_vector` → number[]）。

⇒ 这印证了 A1 当初的设计：**默认值是 `None` 时用参数名给建议，但标 `_needs_review`**，
决定由人下。

## 与「子 Agent 调研」的关系

⚠️ 子 Agent 报告说 IndexTTS2「无独立 CLI，通过 Python API 调用」——
**本机核实：错**。本机就有：

```
engines/index-tts/indextts/cli.py      ← 9 个 add_argument
engines/index-tts/indextts/cli_v2.py   ← 7 个子命令 + 20+ 个参数
  （--voice / --emotion-audio / --emotion-vector / --fp16 / --deepspeed / --torch-compile ...）
```

⇒ **教训（第二次同类）**：子 Agent 读 README 摘要会**低估**项目的接口丰富度。
调研结论可以当「地图」，但**任何具体字段的判定必须在本地读源码核实**。

## 下一步（未做）

1. 在**其余引擎**上跑反射（cosyvoice2 / gpt-sovits），看产出形状是否一致
2. 把反射产出 → `parameters[]` 草稿的链路走通（`tools/scaffold-params.cjs`）
3. 决定「哪些字段自动填、哪些留给用户确认」的分界
