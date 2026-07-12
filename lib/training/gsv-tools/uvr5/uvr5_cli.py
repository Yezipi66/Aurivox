#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
uvr5_cli.py — headless vocal separation for the training pipeline.

Why this exists
---------------
`webui.py` in this folder is the STOCK GPT-SoVITS Gradio app: it launches a web
server, reads positional argv (device, is_half, port, share), and at import time
does `os.listdir("tools/uvr5/uvr5_weights")` (a hardcoded relative path). It was
never a batch CLI, yet lib/training/steps/denoise.js invokes it with
`--model/--input/--output`. That mismatch is why the denoise step kept failing.

This script provides the batch interface denoise.js actually expects. It reuses
the real separators (AudioPre / AudioPreDeEcho / MDXNetDereverb / Roformer_Loader)
directly and writes the extracted VOCALS into --output, one file per input.

Diagnostics
-----------
* Everything printed here is also mirrored to `<output>/uvr5_cli.log` so the real
  error survives any truncation Node performs on the captured stderr.
* tqdm progress bars are disabled (they otherwise flood stderr and push the real
  traceback out of any tail window).
* Per-file failures are collected and re-printed as a single `==== UVR5 ERRORS ====`
  block at the very end, so even a short stderr tail shows the actual cause.

Interface (matches denoise.js):
    python uvr5_cli.py --model <path/to/model.(pth|ckpt)> \
                       --input <input_dir> --output <output_dir> \
                       [--device cuda|cpu] [--is_half true|false]  (default fp32) \
                       [--agg 10] [--format wav]

Run it with CWD = this folder (gsv-tools/uvr5), which denoise.js already sets, so
that the sibling modules (vr, mdxnet, bsroformer, lib/) import correctly.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

# Make sibling modules importable even if CWD differs.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


# --------------------------------------------------------------------------- #
# Logging: tee everything to stdout AND a log file inside the output dir.
# --------------------------------------------------------------------------- #
class _Tee:
    def __init__(self, *streams):
        self.streams = [s for s in streams if s is not None]

    def write(self, data):
        for s in self.streams:
            try:
                s.write(data)
                s.flush()
            except Exception:
                pass

    def flush(self):
        for s in self.streams:
            try:
                s.flush()
            except Exception:
                pass


_LOG_FH = None


def log(msg=""):
    print(msg, flush=True)


def _disable_tqdm():
    """Neuter tqdm so progress bars don't flood stderr and bury tracebacks."""
    try:
        import tqdm as _tqdm_mod
        from functools import partialmethod
        _tqdm_mod.tqdm.__init__ = partialmethod(_tqdm_mod.tqdm.__init__, disable=True)
    except Exception:
        pass


def _install_nan_guard():
    """Sanitize NaN/Inf around spec_utils.cmb_spectrogram_to_wave (belt-and-suspenders).

    fp32 already removes the root cause, but a rare corrupt/near-silent input can
    still yield non-finite values. vr.py calls this function by module attribute
    (`spec_utils.cmb_spectrogram_to_wave(...)`), so replacing the attribute wraps
    every call WITHOUT touching any vendor source file. We clean the INPUT spectra
    (so the mirrored high-end `spec *= 0` can't turn Inf*0 into NaN) and the OUTPUT
    wave (so librosa's finite-buffer check never trips downstream)."""
    try:
        import numpy as np
        from lib.lib_v5 import spec_utils
    except Exception:
        log("[uvr5] WARNING: could not install NaN guard:")
        log(traceback.format_exc())
        return

    _orig = spec_utils.cmb_spectrogram_to_wave

    def _clean(a):
        if a is None:
            return None
        try:
            return np.nan_to_num(a, nan=0.0, posinf=0.0, neginf=0.0)
        except Exception:
            return a

    def _guarded(spec_m, mp, input_high_end_h=None, input_high_end_=None):
        wav = _orig(_clean(spec_m), mp, input_high_end_h, _clean(input_high_end_))
        return _clean(wav)

    spec_utils.cmb_spectrogram_to_wave = _guarded
    log("[uvr5] NaN/Inf guard installed on spec_utils.cmb_spectrogram_to_wave")


def _str2bool(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "y", "on")


def _resolve_device(device):
    import torch
    if device and device != "auto":
        return device
    return "cuda" if torch.cuda.is_available() else "cpu"


def _build_separator(model_path, model_name, device, is_half, agg):
    """Instantiate the right separator, mirroring webui.uvr()'s selection."""
    weights_dir = os.path.dirname(model_path)
    if model_name == "onnx_dereverb_By_FoxJoy":
        from mdxnet import MDXNetDereverb
        return MDXNetDereverb(15)
    if "roformer" in model_name.lower():
        from bsroformer import Roformer_Loader
        config_path = os.path.join(weights_dir, model_name + ".yaml")
        if not os.path.exists(config_path):
            log(f"[uvr5] WARNING: roformer config not found: {config_path}; "
                f"the loader will fall back to its default config.")
        return Roformer_Loader(
            model_path=os.path.join(weights_dir, model_name + ".ckpt"),
            config_path=config_path,
            device=device,
            is_half=is_half,
        )
    from vr import AudioPre, AudioPreDeEcho
    func = AudioPre if "DeEcho" not in model_name else AudioPreDeEcho
    return func(agg=int(agg), model_path=model_path, device=device, is_half=is_half)


def _needs_reformat(inp_path):
    """True unless the file is already 2ch / 44100 Hz (probed via ffmpeg-python)."""
    try:
        import ffmpeg
        info = ffmpeg.probe(inp_path, cmd="ffprobe")
        st = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"),
                  info["streams"][0])
        return not (st.get("channels") == 2 and str(st.get("sample_rate")) == "44100")
    except Exception:
        # If probing fails, force a reformat pass (safest, mirrors webui.py).
        log("[uvr5] probe failed, forcing reformat:")
        log(traceback.format_exc())
        return True


def _reformat(inp_path, tmp_dir):
    """Transcode to stereo/44100 wav so the VR separators read it reliably."""
    tmp_path = os.path.join(tmp_dir, os.path.basename(inp_path) + ".reformatted.wav")
    cmd = ["ffmpeg", "-i", inp_path, "-vn", "-acodec", "pcm_s16le",
           "-ac", "2", "-ar", "44100", tmp_path, "-y"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not os.path.exists(tmp_path):
        raise RuntimeError(
            "ffmpeg reformat failed (code %s):\n%s"
            % (proc.returncode, (proc.stderr or b"").decode("utf-8", "replace")[-1500:])
        )
    return tmp_path


AUDIO_EXTS = (".wav", ".mp3", ".flac", ".m4a", ".ogg")


def _clean_output_name(stem, ext, out_dir, taken):
    """A short, human-readable output name derived from the ORIGINAL input file.

    The vendor separator writes `vocal_<basename-of-temp>_<agg>.<fmt>`, and because
    we feed it a reformatted temp (`<orig>.mp3.reformatted.wav`), the name balloons
    into e.g. `vocal_生命值低·其二.mp3.reformatted.wav_10.wav`. That ugly name then
    propagates into the slice filenames and slicer_opt.list (shown in the proofread
    UI). We rename the produced file to just `<orig-stem><ext>` here; collisions get
    a numeric suffix. Downstream (slicer2.py / asr.js) simply reads whatever files
    exist, so this is safe."""
    candidate = stem + ext
    n = 2
    while candidate in taken or os.path.exists(os.path.join(out_dir, candidate)):
        candidate = "%s_%d%s" % (stem, n, ext)
        n += 1
    taken.add(candidate)
    return candidate


def main():
    global _LOG_FH
    ap = argparse.ArgumentParser(description="Headless UVR5 vocal separation.")
    ap.add_argument("--model", required=True, help="Full path to the UVR5 model (.pth/.ckpt).")
    ap.add_argument("--input", required=True, help="Input directory of audio files.")
    ap.add_argument("--output", required=True, help="Output directory for extracted vocals.")
    ap.add_argument("--device", default="auto", help="cuda | cpu | auto (default: auto).")
    ap.add_argument("--is_half", default=None,
                    help="true/false half precision. Default: false (fp32). "
                         "fp16 makes the HP2 VR model emit NaN/Inf on many GPUs, "
                         "which corrupts the spectrogram and yields no valid output.")
    ap.add_argument("--agg", type=int, default=10, help="Vocal extraction aggressiveness 0-20 (default: 10).")
    ap.add_argument("--format", default="wav", choices=["wav", "flac", "mp3", "m4a"],
                    help="Output audio format (default: wav).")
    ap.add_argument("--max-fail-ratio", dest="max_fail_ratio", type=float, default=0.2,
                    help="Failure tolerance (default: 0.2 = 20%%). If the fraction of "
                         "files that fail is <= this AND at least one succeeded, the run "
                         "still exits 0 (success): the bad files are DROPPED, not fed "
                         "downstream, and are listed prominently. A NaN/garbage separation "
                         "has no usable vocal, so one bad clip should not kill an otherwise "
                         "good batch. Set 0 for strict mode (any failure fails the step).")
    args = ap.parse_args()

    os.makedirs(args.output, exist_ok=True)

    # Start tee logging into the output dir.
    try:
        _LOG_FH = open(os.path.join(args.output, "uvr5_cli.log"), "w", encoding="utf-8")
        sys.stdout = _Tee(sys.__stdout__, _LOG_FH)
        sys.stderr = _Tee(sys.__stderr__, _LOG_FH)
    except Exception:
        pass  # logging to file is best-effort

    _disable_tqdm()
    _install_nan_guard()

    if not os.path.isfile(args.model):
        log(f"[uvr5] ERROR: model file not found: {args.model}")
        return _finish(1, ["model file not found: %s" % args.model])
    if not os.path.isdir(args.input):
        log(f"[uvr5] ERROR: input directory not found: {args.input}")
        return _finish(1, ["input directory not found: %s" % args.input])

    device = _resolve_device(args.device)
    # Default to fp32. fp16 (is_half) makes the HP2 VR model produce NaN/Inf on
    # many GPU/driver combos: the mirrored high-end multiply (spec *= 0) turns
    # Inf*0 into NaN, and librosa then raises "Audio buffer is not finite
    # everywhere" or the wave comes out empty. fp32 costs almost nothing for this
    # tiny model and eliminates the instability. denoise.js never passes
    # --is_half, so this makes the whole pipeline fp32.
    is_half = _str2bool(args.is_half) if args.is_half is not None else False

    model_name = os.path.basename(args.model)
    for ext in (".pth", ".ckpt"):
        if model_name.endswith(ext):
            model_name = model_name[: -len(ext)]
            break
    is_hp3 = "HP3" in model_name

    files = sorted(f for f in os.listdir(args.input)
                   if f.lower().endswith(AUDIO_EXTS)
                   and os.path.isfile(os.path.join(args.input, f)))
    if not files:
        log(f"[uvr5] ERROR: no audio files in {args.input}")
        return _finish(1, ["no audio files in %s" % args.input])

    log(f"[uvr5] model={model_name} device={device} is_half={is_half} "
        f"agg={args.agg} format={args.format} files={len(files)}")

    try:
        pre_fun = _build_separator(args.model, model_name, device, is_half, args.agg)
    except Exception as e:
        log("[uvr5] ERROR: failed to load model:")
        log(traceback.format_exc())
        return _finish(1, ["failed to load model: %s" % e])

    # Instruments are written to a scratch dir we discard, so --output holds only
    # vocals (slice.js consumes every audio file it finds there).
    ins_scratch = tempfile.mkdtemp(prefix="uvr5-ins-")
    reformat_tmp = tempfile.mkdtemp(prefix="uvr5-reformat-")
    ok = 0
    errors = []  # (filename, short_reason)
    out_taken = set()  # clean output names already committed (collision guard)
    try:
        for name in files:
            inp_path = os.path.join(args.input, name)
            work_path = inp_path
            try:
                if _needs_reformat(inp_path):
                    log(f"[uvr5] reformatting {name} -> stereo/44100 wav")
                    work_path = _reformat(inp_path, reformat_tmp)
                before = set(os.listdir(args.output))
                pre_fun._path_audio_(work_path, ins_scratch, args.output, args.format, is_hp3)
                after = set(os.listdir(args.output))
                new_files = [f for f in (after - before) if f != "uvr5_cli.log"]
                if not new_files:
                    raise RuntimeError("separation produced no output file for this input")
                # Rename the produced vocal file(s) to a clean, short name derived
                # from the ORIGINAL input filename (drops the vocal_/agg/temp cruft).
                stem = os.path.splitext(name)[0]
                final_names = []
                for produced in new_files:
                    src = os.path.join(args.output, produced)
                    ext = os.path.splitext(produced)[1] or ("." + args.format)
                    clean = _clean_output_name(stem, ext, args.output, out_taken)
                    if clean != produced:
                        os.replace(src, os.path.join(args.output, clean))
                    final_names.append(clean)
                ok += 1
                log(f"[uvr5] {name} -> OK ({', '.join(final_names)})")
            except Exception as e:
                short = "%s: %s" % (type(e).__name__, e)
                errors.append((name, short))
                log(f"[uvr5] {name} -> FAILED: {short}")
                log(traceback.format_exc())
    finally:
        # Free GPU/model memory.
        try:
            if model_name == "onnx_dereverb_By_FoxJoy":
                del pre_fun.pred.model
                del pre_fun.pred.model_
            else:
                del pre_fun.model
                del pre_fun
        except Exception:
            pass
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        shutil.rmtree(ins_scratch, ignore_errors=True)
        shutil.rmtree(reformat_tmp, ignore_errors=True)

    log(f"[uvr5] done: {ok} ok, {len(errors)} failed (of {len(files)})")

    # Failure tolerance: a NaN/garbage separation yields no usable vocal, so a few
    # bad clips should not nuke an otherwise good batch. If the failure fraction is
    # within --max-fail-ratio (and something succeeded), we DROP the bad files and
    # still succeed — but always list exactly what was dropped, so nothing is lost
    # silently. Above the threshold (systemic breakage) we fail the whole step.
    total = len(files)
    fail_ratio = (len(errors) / total) if total else 0.0
    error_lines = ["%s -> %s" % (n, r) for (n, r) in errors]
    tolerated = bool(errors) and ok > 0 and fail_ratio <= args.max_fail_ratio

    if tolerated:
        log("")
        log("==== UVR5 DROPPED FILES (tolerated, %.0f%% <= %.0f%% threshold) ===="
            % (fail_ratio * 100, args.max_fail_ratio * 100))
        log("These inputs produced no valid separation and were SKIPPED (not passed "
            "downstream). Their audio is missing from the training set:")
        for (n, r) in errors:
            log("  - %s   (%s)" % (n, r))
        log("==== END DROPPED FILES ====")
        log(f"[uvr5] continuing with {ok} good file(s); {len(errors)} dropped.")
        return _finish(0, [])  # success; drops already reported above

    # Strict failure (no success at all, or too many failures).
    return _finish(0 if (not errors and ok > 0) else 1, error_lines)


def _finish(code, error_lines):
    """Print a consolidated error block LAST so short stderr tails still show it."""
    if error_lines:
        log("")
        log("==== UVR5 ERRORS ====")
        for line in error_lines:
            log("  " + line)
        log("==== END UVR5 ERRORS ====")
    if _LOG_FH is not None:
        try:
            _LOG_FH.flush()
            _LOG_FH.close()
        except Exception:
            pass
    return code


if __name__ == "__main__":
    sys.exit(main())
