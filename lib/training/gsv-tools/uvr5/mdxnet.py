import os
import logging

logger = logging.getLogger(__name__)

import librosa
import numpy as np
import soundfile as sf
import torch
from tqdm import tqdm

# Windows / Python 3.8+: dependent DLLs of extension modules are NO LONGER resolved
# via %PATH% — only via directories registered with os.add_dll_directory(). Register
# torch's bundled CUDA/cuDNN DLL dir (cudart/cublas/cudnn…) BEFORE onnxruntime is
# imported so its CUDAExecutionProvider can load. torch is imported above, so those
# DLLs are also already mapped into the process. Without this, onnxruntime silently
# falls back to CPU inside the pipeline's clean-env subprocess (even when a manual
# `import torch, onnxruntime` in an interactive shell happens to work). No-op on
# non-Windows and when the dir is absent.
if os.name == "nt":
    try:
        _torch_lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(_torch_lib):
            os.add_dll_directory(_torch_lib)
    except Exception:
        pass

cpu = torch.device("cpu")


class ConvTDFNetTrim:
    def __init__(self, device, model_name, target_name, L, dim_f, dim_t, n_fft, hop=1024):
        super(ConvTDFNetTrim, self).__init__()

        self.dim_f = dim_f
        self.dim_t = 2**dim_t
        self.n_fft = n_fft
        self.hop = hop
        self.n_bins = self.n_fft // 2 + 1
        self.chunk_size = hop * (self.dim_t - 1)
        self.window = torch.hann_window(window_length=self.n_fft, periodic=True).to(device)
        self.target_name = target_name
        self.blender = "blender" in model_name

        self.dim_c = 4
        out_c = self.dim_c * 4 if target_name == "*" else self.dim_c
        self.freq_pad = torch.zeros([1, out_c, self.n_bins - self.dim_f, self.dim_t]).to(device)

        self.n = L // 2

    def stft(self, x):
        x = x.reshape([-1, self.chunk_size])
        x = torch.stft(
            x,
            n_fft=self.n_fft,
            hop_length=self.hop,
            window=self.window,
            center=True,
            return_complex=True,
        )
        x = torch.view_as_real(x)
        x = x.permute([0, 3, 1, 2])
        x = x.reshape([-1, 2, 2, self.n_bins, self.dim_t]).reshape([-1, self.dim_c, self.n_bins, self.dim_t])
        return x[:, :, : self.dim_f]

    def istft(self, x, freq_pad=None):
        freq_pad = self.freq_pad.repeat([x.shape[0], 1, 1, 1]) if freq_pad is None else freq_pad
        x = torch.cat([x, freq_pad], -2)
        c = 4 * 2 if self.target_name == "*" else 2
        x = x.reshape([-1, c, 2, self.n_bins, self.dim_t]).reshape([-1, 2, self.n_bins, self.dim_t])
        x = x.permute([0, 2, 3, 1])
        x = x.contiguous()
        x = torch.view_as_complex(x)
        x = torch.istft(x, n_fft=self.n_fft, hop_length=self.hop, window=self.window, center=True)
        return x.reshape([-1, c, self.chunk_size])


def get_models(device, dim_f, dim_t, n_fft):
    return ConvTDFNetTrim(
        device=device,
        model_name="Conv-TDF",
        target_name="vocals",
        L=11,
        dim_f=dim_f,
        dim_t=dim_t,
        n_fft=n_fft,
    )


class Predictor:
    def __init__(self, args):
        import onnxruntime as ort

        logger.info(ort.get_available_providers())
        self.args = args
        self.model_ = get_models(device=cpu, dim_f=args.dim_f, dim_t=args.dim_t, n_fft=args.n_fft)
        self._ort = ort
        self._onnx_path = os.path.join(args.onnx, self.model_.target_name + ".onnx")
        self._cpu_sess = None      # lazily built CPU session for OOM fallback
        self._force_cpu = False    # flips true after the first CUDA OOM

        # The FoxJoy dereverb ONNX is VRAM-hungry: it pushes [N,4,3072,512] float32
        # tensors through convolutions, and with torch already resident on the GPU a
        # full-batch run easily exhausts VRAM (cudaErrorMemoryAllocation), which then
        # corrupts the cuDNN handle and takes the whole process down (Windows exit
        # code 0xC0000409). We (a) cap the arena so it never over-grabs, (b) force the
        # HEURISTIC conv-algo search so cuDNN doesn't reserve a huge workspace, and
        # (c) run one window at a time (see _ort_run), falling back to CPU on OOM.
        cuda_opts = {
            "arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "HEURISTIC",
            "do_copy_in_default_stream": True,
        }
        # Escape hatch: UVR5_MDX_DEVICE=cpu forces MDX onto CPU (slow but crash-proof).
        force_cpu_env = os.environ.get("UVR5_MDX_DEVICE", "").strip().lower() == "cpu"
        if force_cpu_env:
            providers = ["CPUExecutionProvider"]
            print("[mdxnet] UVR5_MDX_DEVICE=cpu — forcing MDX-Net onto CPU.", flush=True)
        else:
            providers = [("CUDAExecutionProvider", cuda_opts), "CPUExecutionProvider"]

        self.model = ort.InferenceSession(self._onnx_path, providers=providers)
        self._input_name = self.model.get_inputs()[0].name
        # Log the ACTUAL providers bound to the session (not the compiled list from
        # get_available_providers(), which on onnxruntime<1.19 always lists CUDA even
        # when its DLLs failed to load). This is the only reliable signal for whether
        # MDX is really on GPU; printed (flush) so it lands in uvr5_cli.log too.
        active = self.model.get_providers()
        logger.info("ONNX load done; active providers=%s" % (active,))
        print("[mdxnet] onnxruntime active providers: %s" % (active,), flush=True)
        if "CUDAExecutionProvider" in set(active):
            print(
                "[mdxnet] note: MDX-Net is memory-hungry and OOM-prone on GPU. Running one "
                "window per pass with a capped memory arena; the segment length (chunks=%s s) "
                "defaults to a 4 GB GPU and can be raised on larger cards. On CUDA OOM this "
                "falls back to CPU automatically." % getattr(args, "chunks", "?"),
                flush=True,
            )
        if not force_cpu_env and "CUDAExecutionProvider" not in set(active):
            print(
                "[mdxnet] WARNING: no CUDA provider active — MDX-Net is running on CPU "
                "and will be VERY slow (a 3-min song can take many minutes). Likely cause: "
                "onnxruntime-gpu build vs CUDA/cuDNN mismatch. Fix: pin onnxruntime-gpu==1.18.0 "
                "(matches torch cu121's cuDNN 8) and make sure the CUDA runtime DLLs are on PATH.",
                flush=True,
            )

    def _cpu_session(self):
        if self._cpu_sess is None:
            self._cpu_sess = self._ort.InferenceSession(
                self._onnx_path, providers=["CPUExecutionProvider"]
            )
        return self._cpu_sess

    def _run_one(self, chunk):
        # chunk: numpy [1,4,3072,512]. Try GPU; on CUDA OOM permanently fall back to
        # CPU for the rest of the job (so the run COMPLETES instead of crashing).
        if self._force_cpu:
            return self._cpu_session().run(None, {self._input_name: chunk})[0]
        try:
            return self.model.run(None, {self._input_name: chunk})[0]
        except Exception as e:  # noqa: BLE001 — onnxruntime raises a bare Fail
            msg = str(e).lower()
            if "out of memory" in msg or "cudaerrormemoryallocation" in msg or "cudnn" in msg:
                print(
                    "[mdxnet] CUDA out-of-memory during inference — falling back to CPU "
                    "for MDX-Net (much slower, but avoids the crash). To always use CPU, "
                    "set UVR5_MDX_DEVICE=cpu; or use a torch-native model (Mel-Band / "
                    "BS-Roformer / HP / DeEcho) which is lighter on VRAM.",
                    flush=True,
                )
                self._force_cpu = True
                return self._cpu_session().run(None, {self._input_name: chunk})[0]
            raise

    def _ort_run(self, arr):
        # Run [N,4,3072,512] one window at a time to cap peak VRAM, then concat.
        outs = [self._run_one(arr[k : k + 1]) for k in range(arr.shape[0])]
        return np.concatenate(outs, axis=0)

    def demix(self, mix):
        samples = mix.shape[-1]
        margin = self.args.margin
        chunk_size = self.args.chunks * 44100
        assert not margin == 0, "margin cannot be zero!"
        if margin > chunk_size:
            margin = chunk_size

        segmented_mix = {}

        if self.args.chunks == 0 or samples < chunk_size:
            chunk_size = samples

        counter = -1
        for skip in range(0, samples, chunk_size):
            counter += 1

            s_margin = 0 if counter == 0 else margin
            end = min(skip + chunk_size + margin, samples)

            start = skip - s_margin

            segmented_mix[skip] = mix[:, start:end].copy()
            if end == samples:
                break

        sources = self.demix_base(segmented_mix, margin_size=margin)
        """
        mix:(2,big_sample)
        segmented_mix:offset->(2,small_sample)
        sources:(1,2,big_sample)
        """
        return sources

    def demix_base(self, mixes, margin_size):
        chunked_sources = []
        progress_bar = tqdm(total=len(mixes))
        progress_bar.set_description("Processing")
        for mix in mixes:
            cmix = mixes[mix]
            sources = []
            n_sample = cmix.shape[1]
            model = self.model_
            trim = model.n_fft // 2
            gen_size = model.chunk_size - 2 * trim
            pad = gen_size - n_sample % gen_size
            mix_p = np.concatenate((np.zeros((2, trim)), cmix, np.zeros((2, pad)), np.zeros((2, trim))), 1)
            mix_waves = []
            i = 0
            while i < n_sample + pad:
                waves = np.array(mix_p[:, i : i + model.chunk_size])
                mix_waves.append(waves)
                i += gen_size
            mix_waves = torch.tensor(mix_waves, dtype=torch.float32).to(cpu)
            with torch.no_grad():
                spek = model.stft(mix_waves)
                if self.args.denoise:
                    spec_pred = (
                        -self._ort_run(-spek.cpu().numpy()) * 0.5
                        + self._ort_run(spek.cpu().numpy()) * 0.5
                    )
                    tar_waves = model.istft(torch.tensor(spec_pred))
                else:
                    tar_waves = model.istft(torch.tensor(self._ort_run(spek.cpu().numpy())))
                tar_signal = tar_waves[:, :, trim:-trim].transpose(0, 1).reshape(2, -1).numpy()[:, :-pad]

                start = 0 if mix == 0 else margin_size
                end = None if mix == list(mixes.keys())[::-1][0] else -margin_size
                if margin_size == 0:
                    end = None
                sources.append(tar_signal[:, start:end])

                progress_bar.update(1)

            chunked_sources.append(sources)
        _sources = np.concatenate(chunked_sources, axis=-1)
        # del self.model
        progress_bar.close()
        return _sources

    def prediction(self, m, vocal_root, others_root, format):
        os.makedirs(vocal_root, exist_ok=True)
        os.makedirs(others_root, exist_ok=True)
        basename = os.path.basename(m)
        mix, rate = librosa.load(m, mono=False, sr=44100)
        if mix.ndim == 1:
            mix = np.asfortranarray([mix, mix])
        mix = mix.T
        sources = self.demix(mix.T)
        opt = sources[0].T
        if format in ["wav", "flac"]:
            sf.write("%s/%s_main_vocal.%s" % (vocal_root, basename, format), mix - opt, rate)
            sf.write("%s/%s_others.%s" % (others_root, basename, format), opt, rate)
        else:
            path_vocal = "%s/%s_main_vocal.wav" % (vocal_root, basename)
            path_other = "%s/%s_others.wav" % (others_root, basename)
            sf.write(path_vocal, mix - opt, rate)
            sf.write(path_other, opt, rate)
            opt_path_vocal = path_vocal[:-4] + ".%s" % format
            opt_path_other = path_other[:-4] + ".%s" % format
            if os.path.exists(path_vocal):
                os.system('ffmpeg -i "%s" -vn "%s" -q:a 2 -y' % (path_vocal, opt_path_vocal))
                if os.path.exists(opt_path_vocal):
                    try:
                        os.remove(path_vocal)
                    except:
                        pass
            if os.path.exists(path_other):
                os.system('ffmpeg -i "%s" -vn "%s" -q:a 2 -y' % (path_other, opt_path_other))
                if os.path.exists(opt_path_other):
                    try:
                        os.remove(path_other)
                    except:
                        pass


class MDXNetDereverb:
    def __init__(self, chunks):
        self.onnx = "%s/uvr5_weights/onnx_dereverb_By_FoxJoy" % os.path.dirname(os.path.abspath(__file__))
        self.shifts = 10  # 'Predict with randomised equivariant stabilisation'
        self.mixing = "min_mag"  # ['default','min_mag','max_mag']
        self.chunks = chunks
        self.margin = 44100
        self.dim_t = 9
        self.dim_f = 3072
        self.n_fft = 6144
        self.denoise = True
        self.pred = Predictor(self)
        self.device = cpu

    def _path_audio_(self, input, others_root, vocal_root, format, is_hp3=False):
        self.pred.prediction(input, vocal_root, others_root, format)
