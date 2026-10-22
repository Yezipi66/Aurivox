"""按静音切分音频，把每段写成 wav 文件。

命令行用法（位置参数依次为）：
python slice_audio.py <输入> <输出目录> <静音阈值dB> <最短片段ms> <最短静音ms>
    <帧长ms> <保留静音ms> <峰值幅度> <混合系数> <分片序号> <分片总数>

输入可以是单个文件或目录（目录下的条目全部处理，不按扩展名筛选）。音频先重采样
到 32 kHz 再切片，输出文件名里带片段的起止采样点。
"""
import os
import sys
import numpy as np
import traceback
from scipy.io import wavfile

# load_audio 在 engines/gpt-sovits/gsv_code/tools/my_utils.py，
# 导入它需要 engines/gpt-sovits/gsv_code 这一层目录在 sys.path 上。
from tools.my_utils import load_audio
from slicer2 import Slicer


def slice(inp, opt_root, threshold, min_length, min_interval, hop_size, max_sil_kept, _max, alpha, i_part, all_part):
    """按静音切分音频，把每段写成 wav 文件。

    :param inp: 输入文件或目录；目录下的条目全部处理，不按扩展名筛选
    :param opt_root: 输出目录，不存在则创建
    :param threshold: 静音阈值（dB）
    :param min_length: 最短片段长度（ms）
    :param min_interval: 最短静音间隔（ms）
    :param hop_size: 音量曲线的帧长（ms）
    :param max_sil_kept: 切分后每侧最多保留的静音长度（ms）
    :param _max: 峰值目标幅度，与原幅度按 alpha 混合
    :param alpha: 混合系数，取 0 到 1；1 表示完全用目标峰值，0 表示保持原幅度
    :param i_part: 本次处理的分片序号
    :param all_part: 分片总数
    :returns: 一句话说明（完成提示或失败原因）
    """
    os.makedirs(opt_root, exist_ok=True)
    if os.path.isfile(inp):
        input = [inp]
    elif os.path.isdir(inp):
        input = [os.path.join(inp, name) for name in sorted(list(os.listdir(inp)))]
    else:
        return "输入路径存在但既不是文件也不是文件夹"
    slicer = Slicer(
        sr=32000,  # 与重采样后的音频采样率一致
        threshold=int(threshold),  # 静音阈值（dB），按整数取整；低于该值的帧算静音
        min_length=int(min_length),  # 最短片段长度（ms）
        min_interval=int(min_interval),  # 最短静音间隔（ms），短于此值的静音不落刀
        hop_size=int(hop_size),  # 音量曲线的帧长（ms）：帧长越小切分点越密，计算量越大
        max_sil_kept=int(max_sil_kept),  # 切分后每侧最多保留的静音长度（ms）
    )
    _max = float(_max)
    alpha = float(alpha)
    for inp_path in input[int(i_part) :: int(all_part)]:
        try:
            name = os.path.basename(inp_path)
            audio = load_audio(inp_path, 32000)  # 统一重采样到 32 kHz
            for chunk, start, end in slicer.slice(audio):  # start 与 end 是采样点序号
                # 峰值超过 1 时先归一化到 1，再按 _max 与 alpha 混合。
                # 注意除数用的是归一化之前的 tmp_max：原峰值大于 1 的片段会被
                # 归一化两次（第二次除的是原峰值），输出峰值因此低于 _max。
                tmp_max = np.abs(chunk).max()
                if tmp_max > 1:
                    chunk /= tmp_max
                chunk = (chunk / tmp_max * (_max * alpha)) + (1 - alpha) * chunk
                wavfile.write(
                    "%s/%s_%010d_%010d.wav" % (opt_root, name, start, end),
                    32000,
                    (chunk * 32767).astype(np.int16),
                )
        except:
            print(inp_path, "->fail->", traceback.format_exc())
    return "执行完毕，请检查输出文件"


# 模块级执行：导入这个文件就会执行一次切片，命令行参数按位置传给 slice()。
print(slice(*sys.argv[1:]))
