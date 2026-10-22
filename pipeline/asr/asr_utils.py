"""ASR 侧的共用工具：加载 cuDNN 动态库，给出 ASR 引擎清单与 Faster Whisper 的模型规格。

模块级只导入标准库，torch 在 load_cudnn 内部才导入，所以导入这个模块本身不需要
CUDA 环境。引擎清单与模型规格是写死的常量，调用方要换它们得改这里。

get_asr_config 与 pipeline/asr/config.py 的 asr_dict 是两份内容相近但独立的清单。
"""
import ctypes
import os
import sys
from pathlib import Path


def load_cudnn():
    """把 cuDNN 动态库加载进进程。

    Windows 下加载 torch 自带的 cudnn_cnn*.dll，Linux 下加载 nvidia 包里的
    libcudnn_cnn*.so*；按平台只处理其中一种。CUDA 不可用时直接返回。

    :returns: None
    """
    import torch

    if not torch.cuda.is_available():
        print("[INFO] CUDA not available, skipping cuDNN.")
        return

    if sys.platform == "win32":
        torch_lib_dir = Path(torch.__file__).parent / "lib"
        if torch_lib_dir.exists():
            os.add_dll_directory(str(torch_lib_dir))
            print(f"[INFO] Added DLL dir: {torch_lib_dir}")
            for dll_path in sorted(torch_lib_dir.glob("cudnn_cnn*.dll")):
                try:
                    ctypes.CDLL(os.path.basename(dll_path))
                    print(f"[INFO] Loaded: {os.path.basename(dll_path)}")
                except OSError as e:
                    print(f"[WARN] Failed to load {os.path.basename(dll_path)}: {e}")
        else:
            print(f"[WARN] Torch lib dir not found: {torch_lib_dir}")

    elif sys.platform == "linux":
        site_packages = Path(torch.__file__).resolve().parents[1]
        cudnn_dir = site_packages / "nvidia" / "cudnn" / "lib"
        if not cudnn_dir.exists():
            print(f"[WARN] cudnn dir not found: {cudnn_dir}")
            return
        for so_path in sorted(cudnn_dir.glob("libcudnn_cnn*.so*")):
            try:
                ctypes.CDLL(so_path, mode=ctypes.RTLD_GLOBAL)
                print(f"[INFO] Loaded: {so_path}")
            except OSError as e:
                print(f"[WARN] Failed to load {so_path}: {e}")


def get_asr_models():
    """返回可用的 Faster Whisper 模型规格名列表。

    :returns: 规格名列表
    """
    return [
        "medium", "medium.en", "large-v2", "large-v3", "large-v3-turbo",
    ]


def get_asr_config():
    """返回两种 ASR 引擎的清单。

    :returns: 以 ASR 实现名为键（funasr、faster-whisper）的字典，每项含显示名、
        支持语种与脚本名；faster-whisper 一项另含模型规格列表
    """
    return {
        "funasr": {
            "label": "达摩 ASR (中文)",
            "languages": ["zh", "yue"],
            "script": "funasr_asr.py",
        },
        "faster-whisper": {
            "label": "Faster Whisper (多语种)",
            "languages": ["auto", "en", "ja", "ko"],
            "models": get_asr_models(),
            "script": "fasterwhisper_asr.py",
        },
    }
