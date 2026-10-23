"""语音识别（ASR）引擎规格表：每个引擎的语种、模型规格、计算精度、执行脚本。

本文件没有任何消费方：改这里的取值不影响运行中的训练管线。
引擎与模型由 lib/training/steps/asr.js 的 runAsr 决定，
各脚本自己的命令行参数才是最终约束。
"""


def get_models():
    """返回 Faster Whisper 可用的模型尺寸名列表。

    同一张表在 asr_utils.py 的 get_asr_models() 里还有一份。
    fasterwhisper_asr.py 的 --model_size 允许值取自那一份，改这一份不影响脚本行为。

    :returns: 模型尺寸名的字符串列表
    """
    model_size_list = [
        "medium",
        "medium.en",
        "large-v2",
        "large-v3",
        "large-v3-turbo",
    ]
    return model_size_list


# 引擎规格表。键为引擎显示名；值为 lang（语种）、size（模型尺寸）、
# path（执行脚本名，与本文件同目录）、precision（计算精度）四个字段。
asr_dict = {
    "达摩 ASR (中文)": {"lang": ["zh", "yue"], "size": ["large"], "path": "funasr_asr.py", "precision": ["float32"]},
    "Faster Whisper (多语种)": {
        "lang": ["auto", "en", "ja", "ko"],
        "size": get_models(),
        "path": "fasterwhisper_asr.py",
        "precision": ["float32", "float16", "int8"],
    },
}
