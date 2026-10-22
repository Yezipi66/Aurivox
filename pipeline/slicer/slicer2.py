"""按静音把长音频切成短片段。

判据是帧级音量：按 hop_size 的步长滑动窗口算出每帧的均方根音量，低于阈值的帧
算静音。中间的静音段不短于 min_interval、且当前片段已满 min_length 时才落刀；
开头的静音长过 max_sil_kept 时直接落刀；末尾的静音不短于 min_interval 时切掉。

落刀位置取静音里音量最低的那一帧。中间的静音不长于 max_sil_kept 时在该点切开、
两半都留；长于 max_sil_kept 时切掉中间一段，两端各留 max_sil_kept 的静音。
开头的静音从第一个采样点切到静音里的最低点；末尾的静音从最低点切到最后一个采样点。

时长类参数（min_length、min_interval、hop_size、max_sil_kept）以毫秒给出，内部
按采样率换算成帧数；threshold 是音量阈值（dB），内部换算成幅度阈值。
命令行入口见文件末的 main()。
"""

import os, sys, tempfile

# numba 的编译缓存目录：librosa 依赖 numba，numba 默认把缓存写进 librosa 所在的
# 安装目录，那里只读时会写不进去；这里改指系统临时目录。必须在导入 librosa 之前设好。
os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(tempfile.gettempdir(), "numba_cache"))
os.makedirs(os.environ["NUMBA_CACHE_DIR"], exist_ok=True)

import numpy as np


def get_rms(
    y,
    frame_length=2048,
    hop_length=512,
    pad_mode="constant",
):
    """计算每帧的均方根音量。

    在波形两端各补 frame_length // 2 个采样点，再按 hop_length 的步长滑窗取帧，
    帧内取均方根值。实现取自 librosa 的 RMS 计算。

    :param y: 波形，末轴是采样点
    :param frame_length: 每帧的采样点数
    :param hop_length: 相邻两帧之间的步长（采样点数）
    :param pad_mode: 两端补齐使用的 numpy 填充模式
    :returns: 每帧的均方根音量；一维输入时形状为 (1, 帧数)
    """
    padding = (int(frame_length // 2), int(frame_length // 2))
    y = np.pad(y, padding, mode=pad_mode)

    axis = -1
    out_strides = y.strides + tuple([y.strides[axis]])
    x_shape_trimmed = list(y.shape)
    x_shape_trimmed[axis] -= frame_length - 1
    out_shape = tuple(x_shape_trimmed) + tuple([frame_length])
    xw = np.lib.stride_tricks.as_strided(y, shape=out_shape, strides=out_strides)
    if axis < 0:
        target_axis = axis - 1
    else:
        target_axis = axis + 1
    xw = np.moveaxis(xw, -1, target_axis)
    slices = [slice(None)] * xw.ndim
    slices[axis] = slice(0, None, hop_length)
    x = xw[tuple(slices)]

    power = np.mean(np.abs(x) ** 2, axis=-2, keepdims=True)

    return np.sqrt(power)


class Slicer:
    """按静音把波形切成若干段的切片器。参数单位见模块说明。"""
    def __init__(
        self,
        sr: int,
        threshold: float = -40.0,
        min_length: int = 5000,
        min_interval: int = 300,
        hop_size: int = 20,
        max_sil_kept: int = 5000,
    ):
        """初始化切片参数。

        :param sr: 采样率（Hz）
        :param threshold: 判定静音的音量阈值（dB）
        :param min_length: 最短片段长度（ms）
        :param min_interval: 最短静音间隔（ms），短于此值的静音不落刀
        :param hop_size: 计算音量曲线的帧长（ms）
        :param max_sil_kept: 切分时每侧最多保留的静音长度（ms）
        :raises ValueError: min_length、min_interval、hop_size 不满足
            min_length >= min_interval >= hop_size，或 max_sil_kept 小于 hop_size
        """
        if not min_length >= min_interval >= hop_size:
            raise ValueError("The following condition must be satisfied: min_length >= min_interval >= hop_size")
        if not max_sil_kept >= hop_size:
            raise ValueError("The following condition must be satisfied: max_sil_kept >= hop_size")
        min_interval = sr * min_interval / 1000
        self.threshold = 10 ** (threshold / 20.0)
        self.hop_size = round(sr * hop_size / 1000)
        self.win_size = min(round(min_interval), 4 * self.hop_size)
        self.min_length = round(sr * min_length / 1000 / self.hop_size)
        self.min_interval = round(min_interval / self.hop_size)
        self.max_sil_kept = round(sr * max_sil_kept / 1000 / self.hop_size)

    def _apply_slice(self, waveform, begin, end):
        if len(waveform.shape) > 1:
            return waveform[:, begin * self.hop_size : min(waveform.shape[1], end * self.hop_size)]
        else:
            return waveform[begin * self.hop_size : min(waveform.shape[0], end * self.hop_size)]

    def slice(self, waveform):
        """把波形切成若干段。

        多声道波形按各声道平均成单声道后计算音量，切片本身仍按原声道数取样。

        :param waveform: 1 维（采样点）或 2 维（声道 × 采样点）的波形
        :returns: 片段列表，每项是 [音频, 起始采样点, 终止采样点]；音频比 min_length
            还短时直接返回 [波形]，这一项没有起止采样点
        """
        if len(waveform.shape) > 1:
            samples = waveform.mean(axis=0)
        else:
            samples = waveform
        if samples.shape[0] <= self.min_length:
            return [waveform]
        rms_list = get_rms(y=samples, frame_length=self.win_size, hop_length=self.hop_size).squeeze(0)
        # sil_tags 记的是切分点的帧号：中间的短静音记成一个点（切在该点，两半都留），
        # 长静音记成要删掉的一段（起止两帧）。
        sil_tags = []
        silence_start = None
        clip_start = 0
        for i, rms in enumerate(rms_list):
            if rms < self.threshold:
                if silence_start is None:
                    silence_start = i
                continue
            if silence_start is None:
                continue
            is_leading_silence = silence_start == 0 and i > self.max_sil_kept
            need_slice_middle = i - silence_start >= self.min_interval and i - clip_start >= self.min_length
            if not is_leading_silence and not need_slice_middle:
                silence_start = None
                continue
            if i - silence_start <= self.max_sil_kept:
                pos = rms_list[silence_start : i + 1].argmin() + silence_start
                if silence_start == 0:
                    sil_tags.append((0, pos))
                else:
                    sil_tags.append((pos, pos))
                clip_start = pos
            elif i - silence_start <= self.max_sil_kept * 2:
                pos = rms_list[i - self.max_sil_kept : silence_start + self.max_sil_kept + 1].argmin()
                pos += i - self.max_sil_kept
                pos_l = rms_list[silence_start : silence_start + self.max_sil_kept + 1].argmin() + silence_start
                pos_r = rms_list[i - self.max_sil_kept : i + 1].argmin() + i - self.max_sil_kept
                if silence_start == 0:
                    sil_tags.append((0, pos_r))
                    clip_start = pos_r
                else:
                    sil_tags.append((min(pos_l, pos), max(pos_r, pos)))
                    clip_start = max(pos_r, pos)
            else:
                pos_l = rms_list[silence_start : silence_start + self.max_sil_kept + 1].argmin() + silence_start
                pos_r = rms_list[i - self.max_sil_kept : i + 1].argmin() + i - self.max_sil_kept
                if silence_start == 0:
                    sil_tags.append((0, pos_r))
                else:
                    sil_tags.append((pos_l, pos_r))
                clip_start = pos_r
            silence_start = None
        total_frames = rms_list.shape[0]
        if silence_start is not None and total_frames - silence_start >= self.min_interval:
            silence_end = min(total_frames, silence_start + self.max_sil_kept)
            pos = rms_list[silence_start : silence_end + 1].argmin() + silence_start
            sil_tags.append((pos, total_frames + 1))
        if len(sil_tags) == 0:
            return [[waveform, 0, int(total_frames * self.hop_size)]]
        else:
            chunks = []
            if sil_tags[0][0] > 0:
                chunks.append([self._apply_slice(waveform, 0, sil_tags[0][0]), 0, int(sil_tags[0][0] * self.hop_size)])
            for i in range(len(sil_tags) - 1):
                chunks.append(
                    [
                        self._apply_slice(waveform, sil_tags[i][1], sil_tags[i + 1][0]),
                        int(sil_tags[i][1] * self.hop_size),
                        int(sil_tags[i + 1][0] * self.hop_size),
                    ]
                )
            if sil_tags[-1][1] < total_frames:
                chunks.append(
                    [
                        self._apply_slice(waveform, sil_tags[-1][1], total_frames),
                        int(sil_tags[-1][1] * self.hop_size),
                        int(total_frames * self.hop_size),
                    ]
                )
            return chunks


def main():
    """命令行入口：切分一个音频文件或一个目录里的全部音频，写出 wav 片段。"""
    import os.path
    import glob
    from argparse import ArgumentParser

    import librosa
    import soundfile

    parser = ArgumentParser()
    parser.add_argument("audio", type=str, nargs="?",
                        help="单个音频文件（向后兼容）")
    parser.add_argument("--in_dir", type=str, default=None,
                        help="批处理：输入文件夹，处理其中所有 wav/mp3/flac")
    parser.add_argument("--out", type=str, help="切片输出目录")
    parser.add_argument("--db_thresh", type=float, default=-40)
    parser.add_argument("--min_length", type=int, default=5000)
    parser.add_argument("--min_interval", type=int, default=300)
    parser.add_argument("--hop_size", type=int, default=10)
    parser.add_argument("--max_sil_kept", type=int, default=500)
    args = parser.parse_args()

    if args.in_dir:
        # 大小写两种写法都列：glob 在 POSIX 上区分大小写。
        exts = ("*.wav", "*.mp3", "*.flac", "*.WAV", "*.MP3", "*.FLAC")
        todo = []
        for e in exts:
            todo.extend(glob.glob(os.path.join(args.in_dir, e)))
        todo = sorted(set(todo))
    elif args.audio:
        todo = [args.audio]
    else:
        print("ERROR: 需要提供 audio 或 --in_dir", flush=True)
        sys.exit(2)

    out = args.out or (os.path.dirname(os.path.abspath(todo[0])) if todo else ".")
    if not os.path.exists(out):
        os.makedirs(out)

    total_chunks = 0
    for idx, audio_path in enumerate(todo):
        name = os.path.basename(audio_path)
        print(f"[{idx + 1}/{len(todo)}] slicing {name}", flush=True)

        audio, sr = librosa.load(audio_path, sr=None, mono=False)
        slicer = Slicer(
            sr=sr,
            threshold=args.db_thresh,
            min_length=args.min_length,
            min_interval=args.min_interval,
            hop_size=args.hop_size,
            max_sil_kept=args.max_sil_kept,
        )
        chunks = slicer.slice(audio)
        stem = name.rsplit(".", maxsplit=1)[0]
        for i, chunk_info in enumerate(chunks):
            chunk = chunk_info[0]
            if len(chunk.shape) > 1:
                chunk = chunk.T
            soundfile.write(
                os.path.join(out, "%s_%d.wav" % (stem, i)),
                chunk,
                sr,
            )
        total_chunks += len(chunks)
        print(f"[{idx + 1}/{len(todo)}] done {name} -> {len(chunks)} chunks", flush=True)

    print(f"ALL DONE: {len(todo)} files -> {total_chunks} chunks", flush=True)


if __name__ == "__main__":
    main()
