#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
请求别名折叠 —— 平台侧的键名 → 下游引擎认的键名。

⭐⭐ 为什么它单独成一个文件（而不是写在 infer_server.py 里）
------------------------------------------------------------------
`infer_server.py` 一 import 就把整个 GPT-SoVITS 推理栈拉起来（TTS、大
模型、配置自检……），**测试里根本起不来**。所以凡是「必须在宿主里做、
又必须能测」的判断，都抽到这里 —— 纯函数、零依赖、import 即用。

这不是为了测试而拆，是为了让这个判断**有一个可以指着说「就是这里」的
产地**。写在 tts_handle 里的话，下一个读代码的人得先读完 600 行、
先确认那堆 import 不会炸，才能知道这条别名规则是什么。

--------------------------------------------------------------------------
这一条具体是什么事（2026-10-01 查出来的，不是推测）
--------------------------------------------------------------------------
平台的 engines/gpt-sovits/manifest.json 里 `param_schema.if_sr` 那一格的
label 是 "Super Sampling (v3)"、help 是 "Run super-resolution on the result.
v3/v4 models only."。`assembleEnginePayload` 按 payload_keys 原样把它发给引擎。

而下游 `engines/gpt-sovits/infer/TTS.py:1229` 读的是

    super_sampling = inputs.get("super_sampling", False)

中间的宿主 `infer_server.py` 的 `TTS_Request` 只有 `super_sampling`，
**pydantic v2 静默忽略多余字段** ⇒ 用户在界面上打开「Super Sampling」、
点生成、声音一点不变、没有一处报错。

⚠️ 这跟「点 2 改对比页」无关：`assembleEnginePayload` 这条平台正规路径
   本来就发 if_sr ⇒ **GenerateTab 今天就有这个毛病**。

--------------------------------------------------------------------------
为什么不能让平台各处去翻译
--------------------------------------------------------------------------
· `if_sr` 是磁盘上 v3 配方的历史键名，被 `lib/recipeStore.js:84` 的
  `V3_PARAM_KEYS` 和 `lib/recipeView.js:40` 冻住了（C11 豁免表登记着，
  理由是「v3 磁盘格式的历史事实，被存量配方冻住，名片变了它也不能变」）。
  改名片会让存量配方读错。
· 在平台侧加一张「历史键名对照表」就是 C11 明令禁止的**第二份参数名清单**，
  而且必然漂移。
⇒ 既成事实让**收件人**认，成本最低、漂移面最小。

--------------------------------------------------------------------------
这个模块不做的事
--------------------------------------------------------------------------
· 不翻译任何**平台词**（text / reference_audio / …）。那些是
  `lib/engines/payload.js` + 名片 `maps` 的事，两份事实不许互相抄。
· 不猜「哪些键是别名」。`ALIASES` 里每一对都必须给出**代码位置**作为
  依据 —— 没有依据的别名不许加进来（那又变成一张凭感觉维护的表）。
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# 别名表 —— 每一项都必须能指着代码说「这两是同一件事」
# ---------------------------------------------------------------------------
#
# 方向：**左 = 平台/配方侧的规范键**，右 = 下游引擎真正读的键。
#
# ⛔ 别往这张表里加「看起来像」的别名。加一条的成本不是一行代码，是
#    「万一它俩不是同一件事，那我刚刚让某个参数静默变成了另一个参数」。
ALIASES = {
    # engines/gpt-sovits/manifest.json → params.schema.if_sr
    #   label "Super Sampling (v3)" / help "Run super-resolution on the result.
    #   v3/v4 models only."
    # engines/gpt-sovits/infer/TTS.py:1229
    #   super_sampling = inputs.get("super_sampling", False)
    # lib/inference/infer_server.py:293
    #   super_sampling: bool = False
    "if_sr": "super_sampling",
}


def fold_aliases(req):
    """把 req 里的平台规范键就地折成下游认的键名，然后摘掉别名本身。

    ⛔ **就地改**并返回同一个对象：调用方拿到的是它传进去的那个 dict，
       不是副本。这是有意的 —— tts_handle 之后把整份 req 交给 TTS.py，
       少一次复制就少一处「忘了把折叠结果带过去」的机会。

    优先级：**规范键（左）赢**。理由：它是用户在界面上动过的那个键；
    右边的键只可能来自「有人直接照下游的名字发」，那种情况下两个值冲突
    仍然该听用户的。

    ⚠️ 判「给了没有」用 ``is not None``，不是 truthy：规范键的
    **False / 0 / "" 是用户明确设成这样的**，不能被另一个键的 True 覆盖掉。
    写成 ``if req.get(k):`` 的话，用户在界面上把某个开关**关掉**的那一刻
    就会被别处的默认值悄悄打开 —— 那正是本次要消灭的那类静默失败。

    :param req: 一次请求的键值表（会被就地修改）
    :returns: 同一个 req
    """
    if not isinstance(req, dict):
        # 不是 dict 就不是「一次请求」——静默放过等于把这个错误推到更深处，
        # 而这里的错误在栈顶，一眼能看见。
        raise TypeError(
            "fold_aliases 需要一个 dict（一次请求的键值表），收到的是 {0}".format(
                type(req).__name__
            )
        )

    for canonical, downstream in ALIASES.items():
        if req.get(canonical) is None:
            continue  # 平台没这个概念 ⇒ 这一格没被用户动过 ⇒ 交给引擎自己的默认值
        req[downstream] = req[canonical]
        # 折叠完摘掉别名：req 整份会被 TTS.py 读，多留一个没人认的键没有好处，
        # 留着只会让「这个键到底被谁读的」更难查。
        del req[canonical]
    return req


# ---------------------------------------------------------------------------
# 给 inferAliasFold.node.test.js 用的 JSON 探针。
# ⭐ 只折叠、不合成 —— 测试要能在不加载任何模型的前提下问它「你会怎么折」。
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    import json
    import sys

    ap = argparse.ArgumentParser(description="request alias folding probe")
    ap.add_argument(
        "--req",
        required=True,
        help='请求体，JSON。例如 \'{"if_sr": true, "text": "hi"}\'',
    )
    ns = ap.parse_args()

    body = json.loads(ns.req)
    result = fold_aliases(body)
    sys.stdout.write(json.dumps({"folded": result}, ensure_ascii=False))
