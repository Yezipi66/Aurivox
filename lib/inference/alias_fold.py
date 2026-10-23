#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把平台侧的键名折成下游引擎认的键名。

例：平台的 `if_sr`（v3 配方的历史键名，被存量配方冻住）折成下游读的
`super_sampling`。折错方向的后果是静默的：宿主模型静默忽略多余字段，
用户在界面上打开了开关、点生成、声音一点不变、没有一处报错。

只做别名折叠。平台词（text / reference_audio 等）由 `lib/engines/payload.js`
与名片的 maps 负责，两份事实不互相抄。

单独成文件的原因：`infer_server.py` 一 import 就拉起整个推理栈，测试起不来。
这里是纯函数、零依赖、import 即用，让这条判断有一个能指着说的产地。
"""

from __future__ import annotations

# 别名表。方向：左是平台/配方侧的规范键，右是下游引擎真正读的键。
# 每一项都要能指着代码说「这两是同一件事」。别加「看起来像」的别名，
# 那等于让某个参数静默变成另一个参数。
ALIASES = {
    # 依据：名片的 params.schema.if_sr（label "Super Sampling (v3)"）、
    # 引擎的 infer/TTS.py 里 super_sampling = inputs.get("super_sampling", False)、
    # 宿主的 infer_server.py 里 super_sampling: bool = False。
    "if_sr": "super_sampling",
}


def fold_aliases(req):
    """把 req 里的平台规范键就地折成下游认的键名，然后摘掉别名本身。

    就地改并返回同一个对象：调用方拿到的就是它传进去的那个 dict。
    tts_handle 之后把整份 req 交给 TTS.py，少一次复制就少一处
    「忘了把折叠结果带过去」的机会。

    规范键（左）优先：它是用户在界面上动过的那个键；右边的键只可能来自
    「有人直接照下游的名字发」，两个值冲突时仍然该听用户的。

    判「给了没有」用 ``is not None`` 而非 truthy：规范键的 False / 0 / ""
    是用户明确设成这样的，不能被另一个键的 True 覆盖掉。写成
    ``if req.get(k):`` 的话，用户在界面上把某个开关关掉的那一刻
    就会被别处的默认值悄悄打开。

    :param req: 一次请求的键值表（会被就地修改）
    :returns: 同一个 req
    """
    if not isinstance(req, dict):
        # 不是 dict 就不是「一次请求」：静默放过等于把这个错误推到更深处，
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


# 给 lib/inference/aliasFold.node.test.js 用的 JSON 探针。
# 只折叠、不合成：测试要在不加载任何模型的前提下问它「你会怎么折」。
if __name__ == "__main__":
    import argparse
    import json
    import sys
    # 输出走 UTF-8：Windows 上 stdout 默认是系统代码页（cp1252/cp936），
    #   而折叠结果里可能有中文 ⇒ 编码不上就 UnicodeEncodeError。
    #   调用方按 utf-8 解码，这边就得按 utf-8 编码。
    sys.stdout.reconfigure(encoding='utf-8')

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
