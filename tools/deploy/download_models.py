#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
download_models.py — 一键下载 / 校验 TTS Broker 所需的全部模型。

模型不随发行包分发(约 9GB),由本脚本引导下载到项目内的真实路径:
    lib/training/gsv-tools/pretrained/          底模 (gsv / v2Pro / sv / hubert / roberta / bigvgan)
    lib/training/gsv-tools/asr/models/          ASR (faster-whisper-large-v3)
    lib/training/gsv-tools/uvr5/uvr5_weights/   UVR5 去人声 (HP2)
    GPT_SoVITS/text/G2PWModel/                  G2PW 多音字 (g2pW.onnx)  ← 同时写入 gsv_code 副本
    lib/training/gsv-tools/pretrained/fast_langdetect/  语言检测 (lid.176.bin) ← 同时写副本

用法:
    python download_models.py --wizard          # 交互式菜单(推荐)
    python download_models.py --check           # 只体检本地是否齐全, 不下载
    python download_models.py --set core         # 只下核心底模
    python download_models.py --set all          # 全部
    python download_models.py --set asr,uvr5     # 多选(逗号分隔)
    python download_models.py --set all --mirror # 走 hf-mirror.com 加速(国内)

可下载组: core  asr  uvr5  g2pw  langdetect  all

来源(标准 HuggingFace,如与你的实际源不同,改 MANIFEST 里的 repo/url 即可):
  * lj1995/GPT-SoVITS                     —— 绝大多数底模 / hubert / roberta / uvr5
  * nvidia/bigvgan_v2_24khz_100band_256x  —— bigvgan 声码器
  * Systran/faster-whisper-large-v3       —— ASR
  * fasttext lid.176 / G2PWModel          —— 直链(见下方 URL, 若失效请更新)
"""

import argparse
import os
import shutil
import sys
import urllib.request

HF_REPO_GSV = "lj1995/GPT-SoVITS"
HF_REPO_BIGVGAN = "nvidia/bigvgan_v2_24khz_100band_256x"
HF_REPO_ASR = "Systran/faster-whisper-large-v3"
# SR (24k->48k audio super-resolution, AP-BWE) — optional post-processing model.
# Official source is a Google Drive folder (not scriptable); this HF mirror hosts
# the same tools/AP_BWE_main/24kto48k/{g_24kto48k.zip,config.json}. Verify with --check.
HF_REPO_SR = "kevinwang676/GPT-SoVITS-v4-new"
MIRROR = "https://hf-mirror.com"

# 直链(如失效, 更新为你的可用源)
URL_LID176 = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin"
# G2PW: 官方以 zip 分发, 这里给出 onnx 直链占位, 需你确认/替换为可用源
URL_G2PW_ONNX = "https://huggingface.co/lj1995/GPT-SoVITS/resolve/main/G2PWModel/g2pW.onnx"

# 相对项目根的目录
PRE = os.path.join("lib", "training", "gsv-tools", "pretrained")
ASR = os.path.join("lib", "training", "gsv-tools", "asr", "models", "faster-whisper-large-v3")
UVR = os.path.join("lib", "training", "gsv-tools", "uvr5", "uvr5_weights")
SR = os.path.join("lib", "inference", "sr", "AP_BWE_main", "24kto48k")

# 每条: (backend, source, local_relpath, min_bytes[, extra_copies])
#   backend = "hf"  -> source=(repo, path_in_repo)
#   backend = "url" -> source=direct_url
MANIFEST = {
    "core": [
        # --- gsv v2 底模 ---
        ("hf", (HF_REPO_GSV, "gsv-v2final-pretrained/s2G2333k.pth"),
         os.path.join(PRE, "gsv-v2final", "s2G2333k.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "gsv-v2final-pretrained/s2D2333k.pth"),
         os.path.join(PRE, "gsv-v2final", "s2D2333k.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"),
         os.path.join(PRE, "gsv-v2final", "s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"), 120_000_000),
        ("hf", (HF_REPO_GSV, "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"),
         os.path.join(PRE, "gsv-v2final", "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"), 120_000_000),
        # --- v1/v2 base 488k ---
        ("hf", (HF_REPO_GSV, "s2G488k.pth"), os.path.join(PRE, "v2Pro", "s2G488k.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "s2D488k.pth"), os.path.join(PRE, "v2Pro", "s2D488k.pth"), 80_000_000),
        # --- v2Pro / v2ProPlus ---
        ("hf", (HF_REPO_GSV, "v2Pro/s2Gv2Pro.pth"), os.path.join(PRE, "v2Pro", "s2Gv2Pro.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "v2Pro/s2Dv2Pro.pth"), os.path.join(PRE, "v2Pro", "s2Dv2Pro.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "v2Pro/s2Gv2ProPlus.pth"), os.path.join(PRE, "v2Pro", "s2Gv2ProPlus.pth"), 80_000_000),
        ("hf", (HF_REPO_GSV, "v2Pro/s2Dv2ProPlus.pth"), os.path.join(PRE, "v2Pro", "s2Dv2ProPlus.pth"), 80_000_000),
        # --- SV ---
        ("hf", (HF_REPO_GSV, "sv/pretrained_eres2netv2w24s4ep4.ckpt"),
         os.path.join(PRE, "sv", "pretrained_eres2netv2w24s4ep4.ckpt"), 20_000_000),
        # --- cnhubert ---
        ("hf", (HF_REPO_GSV, "chinese-hubert-base/config.json"),
         os.path.join(PRE, "chinese-hubert-base", "config.json"), 500),
        ("hf", (HF_REPO_GSV, "chinese-hubert-base/preprocessor_config.json"),
         os.path.join(PRE, "chinese-hubert-base", "preprocessor_config.json"), 100),
        ("hf", (HF_REPO_GSV, "chinese-hubert-base/pytorch_model.bin"),
         os.path.join(PRE, "chinese-hubert-base", "pytorch_model.bin"), 150_000_000),
        # --- roberta ---
        ("hf", (HF_REPO_GSV, "chinese-roberta-wwm-ext-large/config.json"),
         os.path.join(PRE, "chinese-roberta-wwm-ext-large", "config.json"), 500),
        ("hf", (HF_REPO_GSV, "chinese-roberta-wwm-ext-large/tokenizer.json"),
         os.path.join(PRE, "chinese-roberta-wwm-ext-large", "tokenizer.json"), 100_000),
        ("hf", (HF_REPO_GSV, "chinese-roberta-wwm-ext-large/pytorch_model.bin"),
         os.path.join(PRE, "chinese-roberta-wwm-ext-large", "pytorch_model.bin"), 600_000_000),
        # --- bigvgan ---
        ("hf", (HF_REPO_BIGVGAN, "bigvgan_generator.pt"),
         os.path.join(PRE, "bigvgan", "bigvgan_generator.pt"), 100_000_000),
        ("hf", (HF_REPO_BIGVGAN, "config.json"),
         os.path.join(PRE, "bigvgan", "config.json"), 500),
    ],
    "asr": [
        ("hf", (HF_REPO_ASR, "config.json"), os.path.join(ASR, "config.json"), 500),
        ("hf", (HF_REPO_ASR, "preprocessor_config.json"), os.path.join(ASR, "preprocessor_config.json"), 100),
        ("hf", (HF_REPO_ASR, "tokenizer.json"), os.path.join(ASR, "tokenizer.json"), 1_000_000),
        ("hf", (HF_REPO_ASR, "vocabulary.json"), os.path.join(ASR, "vocabulary.json"), 500_000),
        ("hf", (HF_REPO_ASR, "model.bin"), os.path.join(ASR, "model.bin"), 2_500_000_000),
    ],
    "uvr5": [
        ("hf", (HF_REPO_GSV, "uvr5_weights/HP2_all_vocals.pth"),
         os.path.join(UVR, "HP2_all_vocals.pth"), 50_000_000),
    ],
    "g2pw": [
        # 下载一次 g2pW.onnx, 同时写入两个副本(gsv-tools 与 gsv_code 都需要)
        ("url", URL_G2PW_ONNX,
         os.path.join("GPT_SoVITS", "text", "G2PWModel", "g2pW.onnx"), 500_000_000,
         [os.path.join("lib", "training", "gsv_code", "text", "G2PWModel", "g2pW.onnx")]),
    ],
    "langdetect": [
        ("url", URL_LID176,
         os.path.join(PRE, "fast_langdetect", "lid.176.bin"), 100_000_000,
         [os.path.join("lib", "training", "gsv_code", "pretrained_models", "fast_langdetect", "lid.176.bin")]),
    ],
    # SR is OPTIONAL (audio super-resolution 24k->48k, improves muffled output).
    # Keep g_24kto48k.zip as-is (do NOT unzip); config.json must sit beside it.
    "sr": [
        ("hf", (HF_REPO_SR, "tools/AP_BWE_main/24kto48k/g_24kto48k.zip"),
         os.path.join(SR, "g_24kto48k.zip"), 100_000_000),
        ("hf", (HF_REPO_SR, "tools/AP_BWE_main/24kto48k/config.json"),
         os.path.join(SR, "config.json"), 200),
    ],
}
GROUPS = ["core", "asr", "uvr5", "g2pw", "langdetect", "sr"]


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


def hf_url(repo, path, mirror):
    base = MIRROR if mirror else "https://huggingface.co"
    return f"{base}/{repo}/resolve/main/{path}"


def download_url(url, dest, minb, mirror):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
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
            if total:
                pct = done * 100.0 / total
                print(f"\r    {human(done)}/{human(total)} {pct:5.1f}%", end="", file=sys.stderr)
    print("", file=sys.stderr)
    size = os.path.getsize(tmp)
    if size < minb:
        os.remove(tmp)
        raise RuntimeError(f"文件过小 ({human(size)} < 期望 {human(minb)}), 源可能不对: {url}")
    os.replace(tmp, dest)
    return size


def try_hf_download(repo, path, dest, mirror):
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
        return download_url(hf_url(repo, path, mirror), dest, 1, mirror)


def fetch_group(root, group, mirror, force):
    entries = MANIFEST[group]
    log(f"\n==== 组: {group}  ({len(entries)} 文件) ====")
    for entry in entries:
        backend, source, local, minb, copies = _entry_parts(entry)
        dest = os.path.join(root, local)
        if not force and ok_local(root, local, minb):
            log(f"  已存在, 跳过: {local}")
        else:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                if backend == "hf":
                    repo, path = source
                    size = try_hf_download(repo, path, dest, mirror)
                else:
                    size = download_url(source, dest, minb, mirror)
                log(f"  OK ({human(size)}): {local}")
            except Exception as e:
                log(f"  [失败] {local}: {e}")
                continue
        # 写副本
        for c in copies:
            cp = os.path.join(root, c)
            if force or not ok_local(root, c, minb):
                os.makedirs(os.path.dirname(cp), exist_ok=True)
                try:
                    shutil.copy2(dest, cp)
                    log(f"  副本: {c}")
                except Exception as e:
                    log(f"  [副本失败] {c}: {e}")


def check(root):
    log("==================== 模型体检 ====================")
    all_ok = True
    for g in GROUPS:
        miss = []
        for entry in MANIFEST[g]:
            _, _, local, minb, copies = _entry_parts(entry)
            for path in [local] + copies:
                if not ok_local(root, path, minb):
                    miss.append(path)
        status = "齐全" if not miss else f"缺 {len(miss)} 项"
        log(f"  {g:<11} {status}")
        for m in miss:
            log(f"       - {m}")
        all_ok = all_ok and not miss
    log("=" * 50)
    log("  全部齐全 ✅" if all_ok else "  存在缺失, 运行  --wizard  或  --set <组>  下载。")
    return 0 if all_ok else 1


def wizard(root, mirror):
    while True:
        print("\n============================================================")
        print("            TTS Broker 模型下载向导")
        print("============================================================")
        print("  1) 全部 (core + asr + uvr5 + g2pw + langdetect + sr)  ~9GB")
        print("  2) 仅核心底模 core")
        print("  3) 仅 ASR (faster-whisper-large-v3)  ~3GB")
        print("  4) 仅 UVR5 去人声 (HP2)")
        print("  5) 仅 G2PW 多音字")
        print("  6) 仅 语言检测 lid.176")
        print("  7) 仅 SR 音频超分 24k->48k (可选)")
        print("  8) 自定义 (逗号分隔: core,asr,uvr5,g2pw,langdetect,sr)")
        print("  9) 体检 (只检查, 不下载)")
        print(f"  m) 切换镜像 (当前: {'hf-mirror' if mirror else 'huggingface.com'})")
        print("  0) 退出")
        print("------------------------------------------------------------")
        c = input("请选择 [0-9/m]: ").strip().lower()
        if c == "0":
            return 0
        elif c == "1":
            sets = GROUPS
        elif c == "2":
            sets = ["core"]
        elif c == "3":
            sets = ["asr"]
        elif c == "4":
            sets = ["uvr5"]
        elif c == "5":
            sets = ["g2pw"]
        elif c == "6":
            sets = ["langdetect"]
        elif c == "7":
            sets = ["sr"]
        elif c == "8":
            raw = input("输入组(逗号分隔): ").strip()
            sets = [s.strip() for s in raw.split(",") if s.strip() in MANIFEST]
        elif c == "9":
            check(root)
            continue
        elif c == "m":
            mirror = not mirror
            continue
        else:
            print("无效选择。")
            continue
        for g in sets:
            fetch_group(root, g, mirror, force=False)
        print("\n本轮完成。")


def main():
    ap = argparse.ArgumentParser(description="下载/校验 TTS Broker 模型。")
    ap.add_argument("--set", default=None, help="组: core,asr,uvr5,g2pw,langdetect,all")
    ap.add_argument("--wizard", action="store_true", help="交互式菜单")
    ap.add_argument("--check", action="store_true", help="只体检")
    ap.add_argument("--mirror", action="store_true", help="走 hf-mirror.com")
    ap.add_argument("--force", action="store_true", help="已存在也重下")
    ap.add_argument("--dest", default=None, help="项目根(默认脚本所在目录)")
    args = ap.parse_args()

    root = os.path.abspath(args.dest) if args.dest else root_dir()

    if args.check:
        return check(root)
    if args.wizard or (not args.set):
        return wizard(root, args.mirror)

    sets = GROUPS if args.set.strip().lower() == "all" else \
        [s.strip() for s in args.set.split(",") if s.strip()]
    bad = [s for s in sets if s not in MANIFEST]
    if bad:
        log(f"[错误] 未知组: {bad}  可用: {GROUPS + ['all']}")
        return 2
    for g in sets:
        fetch_group(root, g, args.mirror, args.force)
    log("\n完成。运行 --check 可校验。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
