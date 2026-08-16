#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
download_models.py — 一键下载 / 校验 TTS Broker 所需的全部模型。

模型不随发行包分发(约 9GB),由本脚本引导下载到项目内的真实路径:
    vendor/gsv-tools/pretrained/          底模 (gsv / v2Pro / sv / hubert / roberta)
    vendor/gsv-tools/asr/faster-whisper-large-v3-turbo/  ASR (faster-whisper large-v3-turbo)
    vendor/gsv-tools/uvr5/uvr5_weights/   UVR5 去人声 (HP2)
    GPT_SoVITS/text/G2PWModel/                  G2PW 多音字 (g2pW.onnx)  ← 同时写入 vendor/gsv_code 副本
    vendor/gsv-tools/pretrained/fast_langdetect/  语言检测 (lid.176.bin) ← 同时写副本

用法:
    python download_models.py --wizard          # 交互式菜单
    python download_models.py --check           # 只体检本地是否齐全, 不下载
    python download_models.py --set default      # 默认集(core+g2pw+langdetect+asr, 基座 v2Pro)
    python download_models.py --set core         # 只下核心底模(含 v2Pro 默认基座)
    python download_models.py --set all          # 全部(含 alt 基座 + funasr + uvr5 全子组)
    python download_models.py --set core,asr,funasr,uvr5_roformer  # 多选(逗号分隔)
    python download_models.py --set all --mirror # 走 hf-mirror.com 加速(国内)
    python download_models.py --set all --jobs 8 # 8 路并行下载(默认 4, 1=串行)

加速: 若 venv 里装了 hf_transfer, 单文件走 rust 并行分块下载(自动启用);
      --jobs N 控制同一组内多个文件的并行数。二者叠加显著缩短下载时间。

可下载组(与 THIRD_PARTY_LICENSES/models/MODEL_SOURCES.json 的 download_group 对齐):
    core          核心底模 + 默认基座 v2Pro (sv / hubert / roberta 等)  [默认]
    asr           ASR faster-whisper large-v3-turbo (~1.6GB, 训练用)     [默认]
    funasr        FunASR 中文/粤语 ASR (Paraformer+VAD+标点, ~2.4GB, 可选)  [按需]
    g2pw          G2PW 多音字 (g2pW.onnx)                                 [默认]
    langdetect    语言检测 lid.176                                        [默认]
    alt_v2        备用基座 v2 (G+D)                                       [按需]
    alt_v2proplus 备用基座 v2ProPlus (G+D)                                [按需]
    uvr5_hp       UVR5 去伴奏 HP (HP2/HP3/HP5, ~0.35GB)                    [按需]
    uvr5_deecho   UVR5 去混响/去回声 DeEcho ×3 (~0.2GB)                     [按需]
    uvr5_mdx      UVR5 MDX 去混响 (FoxJoy onnx, ~0.06GB)                   [按需]
    uvr5_roformer UVR5 Roformer 高质量分离 (BS + Mel-Band, ~1.6GB)          [按需]
    (旧名 uvr5 = 上面 4 个子组的全集, --set uvr5 仍可用)

来源(HF 首选;FunASR 用 ModelScope。如与你的实际源不同,改 MANIFEST 里的 repo/id 即可):
  * lj1995/GPT-SoVITS                     —— 绝大多数底模 / hubert / roberta
  * lj1995/VoiceConversionWebUI           —— uvr5 去人声/去混响权重 (HP/DeEcho/MDX)
  * Eddycrack864/... , KimberleyJSN/...   —— BS-Roformer / Mel-Band Roformer
  * mobiuslabsgmbh/faster-whisper-large-v3-turbo  —— ASR (turbo, ~1.6GB)
  * ModelScope iic/ (paraformer/vad/punc/UniASR) —— FunASR 中文/粤语 (ms 后端整目录)
  * fasttext lid.176                      —— 语言检测直链
  * XXXXRT/GPT-SoVITS-Pretrained          —— G2PW 官方整包(下载 zip 抽出 g2pW.onnx)

注: SR 音频超分(24k->48k, AP-BWE)与 BigVGAN 声码器仅 SoVITS v3 使用, 本项目不支持 v3, 已移除。
"""

import argparse
import concurrent.futures
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

# 若装了 hf_transfer(HF 官方 rust 并行分块下载), 自动启用, 单文件下载显著提速。
try:
    import hf_transfer  # noqa: F401
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
except Exception:
    pass

HF_REPO_GSV = "lj1995/GPT-SoVITS"
# UVR5 去人声权重不在 GPT-SoVITS 仓库, 而在原 RVC 仓库 lj1995/VoiceConversionWebUI
# 的 uvr5_weights/ 下(GPT-SoVITS 官方 README 亦指向此处)。用错仓库会 404。
HF_REPO_UVR5 = "lj1995/VoiceConversionWebUI"
# Mel-Band Roformer 权重的官方 HF 仓库(HF 标注 MIT)。文件名即 MelBandRoformer.ckpt;
# 分离器按文件名自动识别架构并用内置默认配置, 故无需下载配套 yaml。
HF_REPO_MELBAND = "KimberleyJSN/melbandroformer"
# BS-Roformer ep_317 权重: MSST(Music-Source-Separation-Training) 模型库 HF 镜像
# (HF 标注 MIT)。同样无需 yaml(分离器内置该 checkpoint 的默认配置)。
HF_REPO_BSROFORMER = "Eddycrack864/Music-Source-Separation-Training"
# ASR 运行时(asr.js -> fasterwhisper_asr.py, --model_dir=asr, -s large-v3-turbo)
# 期望模型位于 asr/faster-whisper-large-v3-turbo/。turbo 权重在 mobiuslabsgmbh 仓库,
# 非 Systran 的 large-v3。用错仓库/路径会导致运行时 "Unable to open file 'model.bin'"。
HF_REPO_ASR = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
MIRROR = "https://hf-mirror.com"

# FunASR (前端可选的中文/粤语 ASR 引擎; asr.js -> funasr_asr.py) 的模型来自 ModelScope
# 的 iic/。运行时首次使用会经 modelscope.snapshot_download 懒下载到
# gsv-tools/asr/models/<name>/。这里把它们纳入"部署期可选下载", 让前端暴露的 FunASR
# 引擎有对应的离线下载路径 (否则首次训练必须联网、且许可从未在部署同意里披露)。
# 每条: (modelscope_model_id, 本地目录名)。
MS_FUNASR = [
    ("iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
     "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"),
    ("iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
     "speech_fsmn_vad_zh-cn-16k-common-pytorch"),
    ("iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
     "punc_ct-transformer_zh-cn-common-vocab272727-pytorch"),
    ("iic/speech_UniASR_asr_2pass-cantonese-CHS-16k-common-vocab1468-tensorflow1-online",
     "speech_UniASR_asr_2pass-cantonese-CHS-16k-common-vocab1468-tensorflow1-online"),
]

# 直链(如失效, 更新为你的可用源)
URL_LID176 = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin"
# G2PW: 官方以整包 zip 分发(含 g2pW.onnx + 配套字典/字表)。发行包已内置配套文件,
# 只缺权重 g2pW.onnx, 故这里下载官方 zip 后仅抽出 g2pW.onnx 写入既有 G2PWModel/ 目录。
URL_G2PWMODEL_ZIP = "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip"

# 相对项目根的目录
PRE = os.path.join("vendor", "gsv-tools", "pretrained")
ASR = os.path.join("vendor", "gsv-tools", "asr", "faster-whisper-large-v3-turbo")
UVR = os.path.join("vendor", "gsv-tools", "uvr5", "uvr5_weights")
# FunASR 模型的落地目录 (与 funasr_asr.py 的 MODELS_DIR 一致)。
FUNASR_DIR = os.path.join("vendor", "gsv-tools", "asr", "models")

# 每条: (backend, source, local_relpath, min_bytes[, extra_copies])
#   backend = "hf"  -> source=(repo, path_in_repo)
#   backend = "url" -> source=direct_url
#
# 分组按 MODEL_SOURCES.json 的 download_group 对齐, 以支持"默认 v2Pro + 备用基座按需"。
MANIFEST = {
    # ---- 核心底模 + 默认基座 v2Pro (必需) ----
    "core": [
        # S1 GPT (AR) —— 每个版本都需要
        ("hf", (HF_REPO_GSV, "gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
         os.path.join(PRE, "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"), 120_000_000),
        ("hf", (HF_REPO_GSV, "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"),
         os.path.join(PRE, "gsv-v2final", "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"), 120_000_000),
        # v1/v2 base 488k (推理回退基座, 保留)
        ("hf", (HF_REPO_GSV, "s2G488k.pth"), os.path.join(PRE, "v2Pro", "s2G488k.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "s2D488k.pth"), os.path.join(PRE, "v2Pro", "s2D488k.pth"), 80_000_000),
        # v2Pro (默认基座)
        ("hf", (HF_REPO_GSV, "v2Pro/s2Gv2Pro.pth"), os.path.join(PRE, "v2Pro", "s2Gv2Pro.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "v2Pro/s2Dv2Pro.pth"), os.path.join(PRE, "v2Pro", "s2Dv2Pro.pth"), 80_000_000),
        # SV (说话人验证)
        ("hf", (HF_REPO_GSV, "sv/pretrained_eres2netv2w24s4ep4.ckpt"),
         os.path.join(PRE, "sv", "pretrained_eres2netv2w24s4ep4.ckpt"), 20_000_000),
        # cnhubert
        ("hf", (HF_REPO_GSV, "chinese-hubert-base/config.json"),
         os.path.join(PRE, "chinese-hubert-base", "config.json"), 500),
        ("hf", (HF_REPO_GSV, "chinese-hubert-base/preprocessor_config.json"),
         os.path.join(PRE, "chinese-hubert-base", "preprocessor_config.json"), 100),
        ("hf", (HF_REPO_GSV, "chinese-hubert-base/pytorch_model.bin"),
         os.path.join(PRE, "chinese-hubert-base", "pytorch_model.bin"), 150_000_000),
        # roberta
        ("hf", (HF_REPO_GSV, "chinese-roberta-wwm-ext-large/config.json"),
         os.path.join(PRE, "chinese-roberta-wwm-ext-large", "config.json"), 500),
        ("hf", (HF_REPO_GSV, "chinese-roberta-wwm-ext-large/tokenizer.json"),
         os.path.join(PRE, "chinese-roberta-wwm-ext-large", "tokenizer.json"), 100_000),
        ("hf", (HF_REPO_GSV, "chinese-roberta-wwm-ext-large/pytorch_model.bin"),
         os.path.join(PRE, "chinese-roberta-wwm-ext-large", "pytorch_model.bin"), 600_000_000),
    ],
    # ---- 备用基座 v2 (G+D) 按需 ----
    "alt_v2": [
        ("hf", (HF_REPO_GSV, "gsv-v2final-pretrained/s2G2333k.pth"),
         os.path.join(PRE, "gsv-v2final", "s2G2333k.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "gsv-v2final-pretrained/s2D2333k.pth"),
         os.path.join(PRE, "gsv-v2final", "s2D2333k.pth"), 80_000_000),
    ],
    # ---- 备用基座 v2ProPlus (G+D) 按需 ----
    "alt_v2proplus": [
        ("hf", (HF_REPO_GSV, "v2Pro/s2Gv2ProPlus.pth"), os.path.join(PRE, "v2Pro", "s2Gv2ProPlus.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "v2Pro/s2Dv2ProPlus.pth"), os.path.join(PRE, "v2Pro", "s2Dv2ProPlus.pth"), 80_000_000),
    ],
    "asr": [
        ("hf", (HF_REPO_ASR, "config.json"), os.path.join(ASR, "config.json"), 500),
        ("hf", (HF_REPO_ASR, "preprocessor_config.json"), os.path.join(ASR, "preprocessor_config.json"), 100),
        ("hf", (HF_REPO_ASR, "tokenizer.json"), os.path.join(ASR, "tokenizer.json"), 1_000_000),
        ("hf", (HF_REPO_ASR, "vocabulary.json"), os.path.join(ASR, "vocabulary.json"), 500_000),
        ("hf", (HF_REPO_ASR, "model.bin"), os.path.join(ASR, "model.bin"), 1_500_000_000),
    ],
    # FunASR 中文/粤语 ASR 引擎 (前端可选, 中文更准 + 自带标点)。模型在 ModelScope
    # 的 iic/, 用 "ms" 后端整目录下载到 gsv-tools/asr/models/<name>/, 与 funasr_asr.py
    # 运行时懒下载的落地路径一致 —— 预下载后离线首训即可用。
    "funasr": [
        ("ms", mid, os.path.join(FUNASR_DIR, name), 5_000_000)
        for mid, name in MS_FUNASR
    ],
    # UVR5 人声分离全套 (与 lib/.../uvr5/uvr5_models.js 目录一致)。VR 家族 (HP/DeEcho)
    # 与 onnx_dereverb 都在 lj1995/VoiceConversionWebUI; Mel-Band 在 KimberleyJSN;
    # BS-Roformer 的 ep_317 权重在 MSST 模型库 HF 镜像 (Eddycrack864/..., MIT);
    # Mel-Band 在 KimberleyJSN。二者均无需 yaml (分离器内置默认配置)。
    # 去伴奏 HP 家族 (VR)
    "uvr5_hp": [
        ("hf", (HF_REPO_UVR5, "uvr5_weights/HP2_all_vocals.pth"),
         os.path.join(UVR, "HP2_all_vocals.pth"), 50_000_000),
        ("hf", (HF_REPO_UVR5, "uvr5_weights/HP3_all_vocals.pth"),
         os.path.join(UVR, "HP3_all_vocals.pth"), 50_000_000),
        ("hf", (HF_REPO_UVR5, "uvr5_weights/HP5_only_main_vocal.pth"),
         os.path.join(UVR, "HP5_only_main_vocal.pth"), 50_000_000),
    ],
    # 去混响/去回声 DeEcho ×3 (VR)
    "uvr5_deecho": [
        ("hf", (HF_REPO_UVR5, "uvr5_weights/VR-DeEchoNormal.pth"),
         os.path.join(UVR, "VR-DeEchoNormal.pth"), 30_000_000),
        ("hf", (HF_REPO_UVR5, "uvr5_weights/VR-DeEchoAggressive.pth"),
         os.path.join(UVR, "VR-DeEchoAggressive.pth"), 30_000_000),
        ("hf", (HF_REPO_UVR5, "uvr5_weights/VR-DeEchoDeReverb.pth"),
         os.path.join(UVR, "VR-DeEchoDeReverb.pth"), 30_000_000),
    ],
    # MDX 去混响 (FoxJoy onnx, 2 文件)
    "uvr5_mdx": [
        ("hf", (HF_REPO_UVR5, "uvr5_weights/onnx_dereverb_By_FoxJoy/vocals.onnx"),
         os.path.join(UVR, "onnx_dereverb_By_FoxJoy", "vocals.onnx"), 20_000_000),
        ("hf", (HF_REPO_UVR5, "uvr5_weights/onnx_dereverb_By_FoxJoy/other.onnx"),
         os.path.join(UVR, "onnx_dereverb_By_FoxJoy", "other.onnx"), 20_000_000),
    ],
    # Roformer 高质量分离 (体积大头): BS-Roformer + Mel-Band, 均无需 yaml (内置默认配置)。
    "uvr5_roformer": [
        # BS-Roformer (MSST zoo mirror, MIT).
        ("hf", (HF_REPO_BSROFORMER, "model_bs_roformer_ep_317_sdr_12.9755.ckpt"),
         os.path.join(UVR, "model_bs_roformer_ep_317_sdr_12.9755.ckpt"), 200_000_000),
        # Mel-Band Roformer (KimberleyJSN, MIT).
        ("hf", (HF_REPO_MELBAND, "MelBandRoformer.ckpt"),
         os.path.join(UVR, "MelBandRoformer.ckpt"), 200_000_000),
    ],
    "g2pw": [
        # 下载官方 G2PWModel.zip, 仅抽出 g2pW.onnx, 同时写入两个副本
        # (GPT_SoVITS/text 与 vendor/gsv_code/text 的既有 G2PWModel/ 目录都需要该权重)。
        ("g2pzip", URL_G2PWMODEL_ZIP,
         os.path.join("GPT_SoVITS", "text", "G2PWModel", "g2pW.onnx"), 50_000_000,
         [os.path.join("vendor", "gsv_code", "text", "G2PWModel", "g2pW.onnx")]),
    ],
    "langdetect": [
        ("url", URL_LID176,
         os.path.join(PRE, "fast_langdetect", "lid.176.bin"), 100_000_000,
         [os.path.join("vendor", "gsv_code", "pretrained_models", "fast_langdetect", "lid.176.bin")]),
    ],
}
GROUPS = ["core", "alt_v2", "alt_v2proplus", "asr", "funasr",
          "uvr5_hp", "uvr5_deecho", "uvr5_mdx", "uvr5_roformer", "g2pw", "langdetect"]
# UVR5 全套 = 4 个子组 (供 "仅 UVR5" 快捷项与 all 集展开)。
UVR5_ALL = ["uvr5_hp", "uvr5_deecho", "uvr5_mdx", "uvr5_roformer"]
# 默认集: 与 MODEL_SOURCES.json 中 default_selected=true 的 download_group 一致
# (核心底模 + 默认基座 v2Pro + g2pw + langdetect + asr)。备用基座与 uvr5 需显式选择。
DEFAULT_SET = ["core", "g2pw", "langdetect", "asr"]


def root_dir():
    # This script lives under tools/deploy/. Resolve the PROJECT ROOT by walking
    # up to the folder that contains server.js; fall back to two levels up
    # (tools/deploy -> tools -> root). Override with --dest.
    here = os.path.dirname(os.path.abspath(__file__))
    cur = here
    for _ in range(5):
        if os.path.exists(os.path.join(cur, "server.js")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return os.path.dirname(os.path.dirname(here))


def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024 or u == "GB":
            return f"{f:.1f}{u}"
        f /= 1024.0


def log(m):
    print(m, flush=True)


def _entry_parts(entry):
    backend, source, local, minb = entry[0], entry[1], entry[2], entry[3]
    copies = entry[4] if len(entry) > 4 else []
    return backend, source, local, minb, copies


def ok_local(root, local, minb):
    p = os.path.join(root, local)
    return os.path.isfile(p) and os.path.getsize(p) >= minb


def dir_size(d):
    total = 0
    for dp, _dn, fs in os.walk(d):
        for f in fs:
            try:
                total += os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    return total


def dir_ok(root, local, minb):
    """ModelScope 整目录下载的存在性判断: 目录存在且累计体积达标。"""
    p = os.path.join(root, local)
    return os.path.isdir(p) and dir_size(p) >= minb


def ok_entry(root, entry):
    """按 backend 分派: ms=目录级校验, 其余=单文件校验。"""
    backend, _source, local, minb, _copies = _entry_parts(entry)
    if backend == "ms":
        return dir_ok(root, local, minb)
    return ok_local(root, local, minb)


def hf_url(repo, path, mirror):
    base = MIRROR if mirror else "https://huggingface.co"
    return f"{base}/{repo}/resolve/main/{path}"


def download_url(url, dest, minb, mirror, quiet=False):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    if not quiet:
        log(f"  下载: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "tts-broker/models"})
    with urllib.request.urlopen(req, timeout=180) as r, open(tmp, "wb") as fh:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            buf = r.read(1024 * 256)
            if not buf:
                break
            fh.write(buf)
            done += len(buf)
            if total and not quiet:
                pct = done * 100.0 / total
                print(f"\r    {human(done)}/{human(total)} {pct:5.1f}%", end="", file=sys.stderr)
    if not quiet:
        print("", file=sys.stderr)
    size = os.path.getsize(tmp)
    if size < minb:
        os.remove(tmp)
        raise RuntimeError(f"文件过小 ({human(size)} < 期望 {human(minb)}), 源可能不对: {url}")
    os.replace(tmp, dest)
    return size


def apply_mirror(url, mirror):
    """镜像开启时把 huggingface.co 换成 hf-mirror.com。"""
    if mirror and "huggingface.co" in url:
        return url.replace("https://huggingface.co", MIRROR)
    return url


def fetch_g2pw_zip(zip_url, dest_onnx, minb, mirror, quiet=False):
    """下载 G2PWModel.zip, 仅抽出 g2pW.onnx 写到 dest_onnx。"""
    url = apply_mirror(zip_url, mirror)
    with tempfile.TemporaryDirectory() as td:
        zpath = os.path.join(td, "G2PWModel.zip")
        # zip 本身较大, 用 1 作下限(真正的大小校验落在抽出的 onnx 上)
        download_url(url, zpath, 1, mirror, quiet)
        with zipfile.ZipFile(zpath) as zf:
            member = None
            for n in zf.namelist():
                if os.path.basename(n).lower() == "g2pw.onnx":
                    member = n
                    break
            if member is None:
                raise RuntimeError("zip 内未找到 g2pW.onnx, 源结构可能已变。")
            os.makedirs(os.path.dirname(dest_onnx), exist_ok=True)
            with zf.open(member) as src, open(dest_onnx + ".part", "wb") as fh:
                shutil.copyfileobj(src, fh)
    size = os.path.getsize(dest_onnx + ".part")
    if size < minb:
        os.remove(dest_onnx + ".part")
        raise RuntimeError(f"抽出的 g2pW.onnx 过小 ({human(size)} < {human(minb)}), 源可能不对。")
    os.replace(dest_onnx + ".part", dest_onnx)
    return size


def try_hf_download(repo, path, dest, mirror, quiet=False):
    """优先 huggingface_hub, 缺失则回退纯 HTTP。"""
    try:
        from huggingface_hub import hf_hub_download
        if mirror:
            os.environ.setdefault("HF_ENDPOINT", MIRROR)
        got = hf_hub_download(repo_id=repo, filename=path, local_dir=os.path.dirname(dest) + "__hf")
        shutil.move(got, dest)
        # 清理 hf_hub 临时目录
        shutil.rmtree(os.path.dirname(dest) + "__hf", ignore_errors=True)
        return os.path.getsize(dest)
    except Exception:
        return download_url(hf_url(repo, path, mirror), dest, 1, mirror, quiet)


def try_ms_download(model_id, dest_dir, quiet=False):
    """ModelScope 整目录快照下载 (FunASR 模型)。与 funasr_asr.py 运行时一致。"""
    from modelscope import snapshot_download
    os.makedirs(dest_dir, exist_ok=True)
    if not quiet:
        log(f"  下载(ModelScope): {model_id}")
    snapshot_download(model_id, local_dir=dest_dir)
    return dir_size(dest_dir)


def _fetch_one(root, entry, mirror, force, quiet):
    """下载单条 + 写副本。返回日志行列表(并行时统一收集后打印, 避免交错)。"""
    backend, source, local, minb, copies = _entry_parts(entry)
    dest = os.path.join(root, local)
    lines = []
    if not force and ok_entry(root, entry):
        lines.append(f"  已存在, 跳过: {local}")
    else:
        try:
            if backend == "ms":
                # source = ModelScope model id; dest = 整个模型目录
                size = try_ms_download(source, dest, quiet)
            elif backend == "hf":
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                repo, path = source
                size = try_hf_download(repo, path, dest, mirror, quiet)
            elif backend == "g2pzip":
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                size = fetch_g2pw_zip(source, dest, minb, mirror, quiet)
            else:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                size = download_url(apply_mirror(source, mirror), dest, minb, mirror, quiet)
            lines.append(f"  OK ({human(size)}): {local}")
        except Exception as e:
            lines.append(f"  [失败] {local}: {e}")
            return lines
    for c in copies:
        cp = os.path.join(root, c)
        if force or not ok_local(root, c, minb):
            os.makedirs(os.path.dirname(cp), exist_ok=True)
            try:
                shutil.copy2(dest, cp)
                lines.append(f"  副本: {c}")
            except Exception as e:
                lines.append(f"  [副本失败] {c}: {e}")
    return lines


def fetch_group(root, group, mirror, force, jobs=4):
    entries = MANIFEST[group]
    workers = max(1, min(jobs, len(entries)))
    log(f"\n==== 组: {group}  ({len(entries)} 文件, 并行 {workers}) ====")
    if workers <= 1:
        for entry in entries:
            for ln in _fetch_one(root, entry, mirror, force, quiet=False):
                log(ln)
        return
    # 并行下载: 各线程静默进度, 完成后统一打印该文件的结果
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_fetch_one, root, e, mirror, force, True) for e in entries]
        for fut in concurrent.futures.as_completed(futs):
            for ln in fut.result():
                log(ln)


def check(root, groups=None):
    log("==================== 模型体检 ====================")
    all_ok = True
    for g in (groups or GROUPS):
        miss = []
        for entry in MANIFEST[g]:
            backend, _s, local, minb, copies = _entry_parts(entry)
            if not ok_entry(root, entry):
                miss.append(local)
            for path in copies:  # 副本一律单文件校验 (ms 无副本)
                if not ok_local(root, path, minb):
                    miss.append(path)
        status = "齐全" if not miss else f"缺 {len(miss)} 项"
        log(f"  {g:<14} {status}")
        for m in miss:
            log(f"       - {m}")
        all_ok = all_ok and not miss
    log("=" * 50)
    log("  全部齐全 ✅" if all_ok else "  存在缺失, 运行  --wizard  或  --set <组>  下载。")
    return 0 if all_ok else 1


def _expand_sets(raw):
    """把 --set 的值展开为合法组列表。支持 all / default / 逗号分隔。
    兼容旧名 'uvr5' -> 展开为 4 个 UVR5 子组。"""
    v = raw.strip().lower()
    if v == "all":
        return list(GROUPS)
    if v == "default":
        return list(DEFAULT_SET)
    out = []
    for s in raw.split(","):
        s = s.strip()
        if not s:
            continue
        if s.lower() == "uvr5":  # 旧名兼容
            out.extend(UVR5_ALL)
        else:
            out.append(s)
    return out


def wizard(root, mirror, jobs):
    while True:
        print("\n============================================================")
        print("            TTS Broker 模型下载向导")
        print("============================================================")
        print("  1) 默认集 (core + asr + g2pw + langdetect, 基座 v2Pro)  [推荐]")
        print("  2) 全部 (默认集 + 备用基座 v2/v2ProPlus + funasr + uvr5)  ~13GB")
        print("  3) 仅核心底模 core (含 v2Pro 默认基座)")
        print("  4) 仅 ASR (faster-whisper large-v3-turbo)  ~1.6GB")
        print("  5) 仅 UVR5 人声分离全套 (HP+DeEcho+MDX+Roformer 4 子组, ~2.5GB)")
        print("  6) 仅 G2PW 多音字")
        print("  7) 仅 语言检测 lid.176")
        print("  8) 备用基座 (alt_v2 + alt_v2proplus)")
        print("  f) 仅 FunASR 中文/粤语 ASR (Paraformer+VAD+标点, ModelScope, ~2.4GB)")
        print("  9) 自定义 (逗号分隔: %s)" % ",".join(GROUPS))
        print("  c) 体检 (只检查, 不下载)")
        print(f"  m) 切换镜像 (当前: {'hf-mirror' if mirror else 'huggingface.com'})")
        print(f"  j) 设置并行数 (当前: {jobs})")
        print("  0) 退出")
        print("------------------------------------------------------------")
        c = input("请选择 [0-9/f/c/m/j]: ").strip().lower()
        if c == "0":
            return 0
        elif c == "1":
            sets = list(DEFAULT_SET)
        elif c == "2":
            sets = list(GROUPS)
        elif c == "3":
            sets = ["core"]
        elif c == "4":
            sets = ["asr"]
        elif c == "5":
            sets = list(UVR5_ALL)
        elif c == "6":
            sets = ["g2pw"]
        elif c == "7":
            sets = ["langdetect"]
        elif c == "8":
            sets = ["alt_v2", "alt_v2proplus"]
        elif c == "f":
            sets = ["funasr"]
        elif c == "9":
            raw = input("输入组(逗号分隔): ").strip()
            sets = [s.strip() for s in raw.split(",") if s.strip() in MANIFEST]
        elif c == "c":
            check(root)
            continue
        elif c == "m":
            mirror = not mirror
            continue
        elif c == "j":
            raw = input("并行下载数 [1-16]: ").strip()
            if raw.isdigit():
                jobs = max(1, min(16, int(raw)))
            continue
        else:
            print("无效选择。")
            continue
        for g in sets:
            fetch_group(root, g, mirror, force=False, jobs=jobs)
        print("\n本轮完成。")


def main():
    ap = argparse.ArgumentParser(description="下载/校验 TTS Broker 模型。")
    ap.add_argument("--set", default=None,
                    help="组: default,all,core,alt_v2,alt_v2proplus,asr,funasr,"
                         "uvr5_hp,uvr5_deecho,uvr5_mdx,uvr5_roformer,g2pw,langdetect (uvr5=全4子组)")
    ap.add_argument("--wizard", action="store_true", help="交互式菜单")
    ap.add_argument("--check", action="store_true", help="只体检")
    ap.add_argument("--mirror", action="store_true", help="走 hf-mirror.com")
    ap.add_argument("--force", action="store_true", help="已存在也重下")
    ap.add_argument("--jobs", type=int, default=4, help="并行下载数 (默认 4, 1=串行)")
    ap.add_argument("--dest", default=None, help="项目根(默认脚本所在目录)")
    args = ap.parse_args()

    root = os.path.abspath(args.dest) if args.dest else root_dir()
    jobs = max(1, min(16, args.jobs))

    if args.check:
        return check(root)
    if args.wizard or (not args.set):
        return wizard(root, args.mirror, jobs)

    sets = _expand_sets(args.set)
    bad = [s for s in sets if s not in MANIFEST]
    if bad:
        log(f"[错误] 未知组: {bad}  可用: {GROUPS + ['all', 'default']}")
        return 2
    for g in sets:
        fetch_group(root, g, args.mirror, args.force, jobs)
    log("\n完成。运行 --check 可校验。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
