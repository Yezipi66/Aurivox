"""
ASR 工具函数 — 从 GPT-SoVITS 项目解耦
只保留训练+推理真正需要的函数，去掉 gradio/UI 依赖
"""
import ctypes
import os
import sys
from pathlib import Path


def load_cudnn():
    """加载 cuDNN DLL（Windows）"""
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
    """返回支持的 Faster Whisper 模型大小列表"""
    return [
        "medium", "medium.en", "large-v2", "large-v3", "large-v3-turbo",
    ]


def get_asr_config():
    """返回 ASR 引擎配置"""
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
