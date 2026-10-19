// AUTO-EXTRACTED from TrainingTab.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { usePersistentState } from '../../usePersistentState'
import { api } from '../../lib/api'
import { Select } from '../common/Select'
import { ConfirmDialog } from '../common/Dialogs'
import { IconTrash } from '../common/Icons'
import { useT } from '../../lib/i18n'
import {
  REBUILD_PARAM_DEFAULTS,
  AGG_DEFAULT,
  VOCAL_PRESETS,
  VOCAL_PRESET_BY_ID,
  EXPERT_META,
  EXPERT_KEYS,
  expertKeysForArch,
  FSTEP_ORDER,
  LANGUAGES,
  TRAIN_PRESETS,
  TRAIN_PRESET_FIELDS,
  pickTrainFields,
  SLICE_PRESET_VALUES,
  TRAIN_STEPS,
} from './trainConstants'
import {
  resolveVocalPipeline,
  buildTrainingParams,
  buildSliceParams,
  buildAsrParams,
  buildStepParams,
  changedStepSet,
  archiveToForm,
} from './trainParams'
import { TrainParamFields } from './ParamCols'
import { PipelineMap, RebuildProgress, LiveLogs } from './TrainPanels'
import { DenoiseReviewPanel, AsrReviewPanel } from './ReviewPanels'
import { PresetNameModal, ConfirmModal, RestoreModal } from './trainModals'
import { NodeDetailPanel } from './NodeDetailPanel'
import { RecoveryBanner } from './RecoveryBanner'
import { RecoverableTasksPanel } from './RecoverableTasksPanel'
import { PreflightSummary } from './PreflightSummary'
import { EssentialsFields } from './EssentialsFields'
import { TrainingPresetPicker } from './TrainingPresetPicker'

function TrainingTab({ engine, voices, loadVoices, activeTaskId, setActiveTaskId, trainPrefill, setTrainPrefill, health }) {
  const { t: tr } = useT()
  const [form, setForm] = usePersistentState('train.form', {
    inputDir: '', language: 'auto', voiceName: '',
    preset: 'default', trainSavedPresets: [], expertUnlocked: false,
    denoise: false, slice: true, asr: true, copyRaw: true,
    keepRawB4Extraction: true,
    trainS1: true, trainS2: true,
    preprocessReview: false,
    pauseAfterDenoise: true,
    keepStaging: false,
    // Advanced params
    gptEpochs: 8, sovitsEpochs: 25, batchSize: 'auto', learningRate: 'default',
    sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
    asrEngine: 'auto', denoiseModel: 'mdx-net',
    denoisePreset: 'bgm', denoisePipeline: [], denoisePresetParams: {}, denoiseAdvUnlocked: false, denoiseSavedPresets: [],
    asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
    modelVersion: 'v2Pro', modelVersions: ['v2Pro'], isHalf: true, inferDevice: 'cuda',
    // S1 advanced
    s1Seed: 1234, s1SaveEvery: 4, s2SaveEvery: 5, s1Precision: '16-mixed', s1GradClip: 1.0,
    s1Lr: 0.01, s1LrInit: 0.00001, s1LrEnd: 0.0001, s1Warmup: 2000, s1Decay: 40000,
    s1MaxSec: 54, s1NumWorkers: 4, s1MaxEval: 8,
    // S2 advanced
    s2Seed: 1234, s2LogInterval: 100, s2EvalInterval: 500, s2Fp16: true,
    s2LrDecay: 0.999875, s2SegmentSize: 20480, s2CMel: 45, s2CKl: 1.0,
    s2TextLowLr: 0.4, s2GradCkpt: false,
  });
  const [localTaskId, setLocalTaskId] = useState(null);
  const [status, setStatus] = useState(null);
  // Base-model availability for the selected training version (drives the gate warning).
  const [baseModelStatus, setBaseModelStatus] = useState(null);
  const _selVersions = (Array.isArray(form.modelVersions) && form.modelVersions.length)
    ? form.modelVersions : [form.modelVersion || 'v2'];
  const _selVersionsKey = _selVersions.join(',');
  useEffect(() => {
    let cancelled = false;
    api(`/api/models/status?versions=${encodeURIComponent(_selVersionsKey)}`)
      .then(r => { if (!cancelled && r.ok) setBaseModelStatus(r.data); })
      .catch(() => { if (!cancelled) setBaseModelStatus(null); });
    return () => { cancelled = true; };
  }, [_selVersionsKey]);


  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  // Vocal-extraction weight availability, reported by VocalExtractionPanel (it owns
  // the UVR5 catalogue fetch + the download job). The primary action below swaps to
  // "Download model" while the enabled pipeline still needs uninstalled weights.
  const [vocalMissingIds, setVocalMissingIds] = useState([]);
  const [uvr5Download, setUvr5Download] = useState(null);
  const startUvr5Download = useCallback((ids) => {
    const models = [...new Set(ids)].filter(Boolean);
    if (!models.length) return;
    setUvr5Download({ status: 'running', models: Object.fromEntries(models.map(m => [m, { status: 'pending', pct: 0 }])) });
    api('/api/uvr5/download', { method: 'POST', body: { models, source: 'auto' } })
      .then(r => {
        if (!r.ok || !r.data?.jobId) { setUvr5Download({ status: 'failed', error: r.data?.error || 'failed to start' }); return; }
        setUvr5Download(d => ({ ...(d || {}), jobId: r.data.jobId, status: 'running' }));
      })
      .catch(e => setUvr5Download({ status: 'failed', error: String(e) }));
  }, []);
  useEffect(() => {
    const jobId = uvr5Download?.jobId;
    if (!jobId || (uvr5Download.status !== 'running')) return;
    let stop = false;
    const tick = () => {
      api(`/api/uvr5/download/${jobId}`).then(r => {
        if (stop || !r.ok) return;
        setUvr5Download(d => ({ ...(d || {}), ...r.data }));
      }).catch(() => {});
    };
    const iv = setInterval(tick, 1200); tick();
    return () => { stop = true; clearInterval(iv); };
  }, [uvr5Download?.jobId, uvr5Download?.status]);
  const [selectedNode, setSelectedNode] = useState(null); // pipeline-map node being configured/inspected
  // Advanced - Common
  // (existing: temperature, topK, topP, repPenalty, splitMethod, speedFactor, seed)
  // Advanced - Advanced
  const [batchSize, setBatchSize] = useState(1);
  const [batchThreshold, setBatchThreshold] = useState(0.75);
  const [splitBucket, setSplitBucket] = useState(true);
  const [fragmentInterval, setFragmentInterval] = useState(0.3);
  const [parallelInfer, setParallelInfer] = useState(true);
  const [sampleSteps, setSampleSteps] = useState(32);
  const [superSampling, setSuperSampling] = useState(false);
  const [mediaType, setMediaType] = useState('wav');
  const [streamingMode, setStreamingMode] = useState(false);
  const [overlapLength, setOverlapLength] = useState(2);
  const [minChunkLength, setMinChunkLength] = useState(16);
  const pollRef = useRef(null);
  const failCountRef = useRef(0);
  // Overwrite confirmation when the target voice id already exists (409 guard).
  const [overwriteConfirm, setOverwriteConfirm] = useState(null); // { existingId, existingDisplay }

  // ── GPU pre-flight (advisory only — we never auto-tune params) ──────────────
  // No NVIDIA GPU → block the start behind an explicit acknowledgement (CPU
  // fine-tuning is punishingly slow and UVR5 is unavailable). Low-VRAM (≤4GB)
  // GPUs still work but risk OOM, so we warn ONCE (persisted) rather than nag.
  const cuda = health?.cuda; // { available, device_name, vram_gb } | undefined until health loads
  const [noGpuConfirm, setNoGpuConfirm] = useState(false);
  const [noGpuAck, setNoGpuAck] = useState(false);
  // ── 管线门控 (G1/G2) ────────────────────────────────────────────────────────
  // G1: 未开启 S1/S2 → 只跑切片/ASR，preprocess 三步无意义，确认后跳过 preprocess。
  // G2: 开启训练却未勾 ASR → 无转写会报错，但用户可能自备 .list：强提醒不阻断，
  //     并给一段 preprocess 前宽限期（默认 30s）让用户投放 .list / segments.json。
  const [gate, setGate] = useState(null);  // null | { type:'g1'|'g2' }
  const [gateGraceSec, setGateGraceSec] = useState(30);
  // 门控放行标记 + 本次放行携带的覆盖项（preprocess 关 / 宽限期秒数）。
  const gateAckRef = useRef({ g1: false, g2: false, preprocessOff: false, graceSec: 30 });
  // FunASR 语言告知门：仅当选了 FunASR 但语言非中文/粤语时提醒（只告知，不阻断）。
  const [asrLangGate, setAsrLangGate] = useState(null);  // null | { lang }
  const asrLangAckRef = useRef(false);
  const [lowVramWarned, setLowVramWarned] = usePersistentState('train.lowVramWarned', false);
  const [showLowVram, setShowLowVram] = useState(false);
  useEffect(() => {
    // Fire the one-time low-VRAM notice only for a real ≤4GB CUDA device.
    if (cuda?.ready && cuda.available && typeof cuda.vram_gb === 'number' && cuda.vram_gb <= 4 && !lowVramWarned) {
      setShowLowVram(true);
    }
  }, [cuda?.available, cuda?.vram_gb, lowVramWarned]);
  const dismissLowVram = () => { setShowLowVram(false); setLowVramWarned(true); };

  // ── Failure-resume (哪里跌倒哪里爬起来) ──────────────────────────────────────
  // Cached failed/interrupted tasks the user can resume. Default-collapsed panel.
  const [recoverList, setRecoverList] = useState([]);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverLoading, setRecoverLoading] = useState(false);
  // Active recovery context once the user clicks "Resume".
  //   { sourceTaskId, failedStep, resumeStep, steps, hasInputDir }
  const [recovery, setRecovery] = useState(null);
  // Baseline step-params captured when resume begins; live form is diffed against it
  // so an upstream param change can auto-pull the restart point back (→ fork).
  const paramSnapshotRef = useRef(null);
  const [restartFailedStep, setRestartFailedStep] = useState(false);

  const loadRecoverable = () => {
    setRecoverLoading(true);
    api('/api/train/recoverable')
      .then(r => { if (r.ok) setRecoverList(r.data.tasks || []); })
      .catch(() => {})
      .finally(() => setRecoverLoading(false));
  };
  // Load the list whenever the page is idle (no active task) so it stays fresh.
  useEffect(() => { if (!activeTaskId && !localTaskId) loadRecoverable(); }, [activeTaskId, localTaskId]);

  // 用 props 中的 activeTaskId，但在 handleStart 后也写一份本地（启动时用）
  const taskId = activeTaskId || localTaskId;
  const isAwaitingReview = status?.status === 'awaiting_review';
  const isRunning = status?.status === 'running';
  const isFinished = status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status);
  const isInterrupted = status?.status === 'interrupted';

  // Fields owned by a training preset — editing any of them by hand means the
  // current values no longer match the named preset, so flip the label to "Custom".
  const PRESET_KEYS = ['gptEpochs', 'sovitsEpochs', 'batchSize', 's1SaveEvery', 's2SaveEvery', 's2GradCkpt', 's2Fp16'];

  // 便捷 form setter
  const setField = (key, val) => setForm(prev => {
    const next = { ...prev, [key]: val };
    if (PRESET_KEYS.includes(key) && prev.preset && prev.preset !== 'custom') {
      next.preset = 'custom';
    }
    return next;
  });

  // Consume a one-shot prefill handed over from the Assets "Rebuild" action:
  // fill in the input folder + voice name, then clear the signal so it fires once.
  useEffect(() => {
    if (!trainPrefill) return;
    setForm(prev => ({ ...prev, ...trainPrefill }));
    if (setTrainPrefill) setTrainPrefill(null);
  }, [trainPrefill]);

  // Slicing presets: convenience that fills the four slice fields (or disables slicing)
  const applySlicePreset = (name) => {
    if (name === 'none') { setField('slice', false); return; }
    const p = SLICE_PRESET_VALUES[name];
    if (p) setForm(prev => ({ ...prev, slice: true, ...p }));
  };

  // Training preset (default-view convenience): overwrite the training fields in one go.
  // Handles built-in presets and user-saved snapshots ("saved:<name>").
  const applyPreset = (name) => {
    if (typeof name === 'string' && name.startsWith('saved:')) {
      const sname = name.slice(6);
      const saved = (form.trainSavedPresets || []).find(s => s.name === sname);
      if (!saved) return;
      setForm(prev => ({ ...prev, preset: name, ...(saved.fields || {}) }));
      return;
    }
    const p = TRAIN_PRESETS.find(x => x.key === name);
    if (!p) return;
    setForm(prev => ({ ...prev, preset: name, ...(p.fields || {}) }));
  };

  // Second-level confirm for irreversible preset deletes. Holds the pending action.
  const [confirmState, setConfirmState] = useState(null);
  const askConfirm = (opts) => setConfirmState(opts);
  const closeConfirm = () => setConfirmState(null);

  // Saved Training Preset management (parallel to the vocal-chain presets).
  const [trainPresetNameOpen, setTrainPresetNameOpen] = useState(false);
  const commitTrainPreset = (rawName) => {
    const name = (rawName || '').trim();
    if (!name) return;
    setForm(f => {
      const rest = (f.trainSavedPresets || []).filter(s => s.name !== name);
      return { ...f, trainSavedPresets: [...rest, { name, fields: pickTrainFields(f) }], preset: `saved:${name}` };
    });
    setTrainPresetNameOpen(false);
  };
  const updateTrainPreset = () => {
    const cur = form.preset || 'default';
    if (!cur.startsWith('saved:')) return;
    const sname = cur.slice(6);
    setForm(f => ({
      ...f,
      trainSavedPresets: (f.trainSavedPresets || []).map(s => s.name === sname ? { name: sname, fields: pickTrainFields(f) } : s),
    }));
  };
  const deleteTrainPreset = () => {
    const cur = form.preset || 'default';
    if (!cur.startsWith('saved:')) return;
    const sname = cur.slice(6);
    askConfirm({
      title: tr('Delete training preset', '删除训练预设'),
      message: tr(`Delete the saved training preset “${sname}”? This can't be undone.`,
                  `确定删除已保存的训练预设“${sname}”吗？此操作不可撤销。`),
      confirmLabel: tr('Delete', '删除'),
      onConfirm: () => {
        setForm(f => ({
          ...f,
          trainSavedPresets: (f.trainSavedPresets || []).filter(s => s.name !== sname),
          preset: 'custom',
        }));
        closeConfirm();
      },
    });
  };

  // 轮询训练状态，有 taskId 就轮询，不依赖本地 training 布尔
  useEffect(() => {
    if (!taskId) return;
    let dead = false; // 标记任务已彻底消失，停止轮询
    const MAX_FAIL = 3;
    const poll = () => {
      if (dead) return;
      api(`/api/train/status/${taskId}`).then(r => {
        if (r.ok) {
          failCountRef.current = 0;
          setStatus(r.data);
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(r.data.status)) {
            if (r.data.status === 'completed') loadVoices();
          }
        } else if (r.status === 404) {
          // 任务已被清理（磁盘 journal 也删了），自愈回到表单
          dead = true;
          failCountRef.current = 0;
          setActiveTaskId(null);
          setLocalTaskId(null);
          setStatus(null);
          setLogs([]);
        } else {
          // 其他错误（5xx 等）计入失败计数
          failCountRef.current++;
          if (failCountRef.current >= MAX_FAIL) {
            dead = true;
            failCountRef.current = 0;
            setActiveTaskId(null);
            setLocalTaskId(null);
            setStatus(null);
            setLogs([]);
          }
        }
      }).catch(() => {
        // 网络错误也计入失败计数
        failCountRef.current++;
        if (failCountRef.current >= MAX_FAIL) {
          dead = true;
          failCountRef.current = 0;
          setActiveTaskId(null);
          setLocalTaskId(null);
          setStatus(null);
          setLogs([]);
        }
      });
      api(`/api/train/logs/${taskId}`).then(r => {
        if (r.ok) setLogs(r.data.logs || []);
      }).catch(() => {});
    };
    poll();
    pollRef.current = setInterval(poll, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [taskId]);

  // "Restoring training state…" 超时兜底：10s 后仍无 status 则回退表单
  const restoreTimeoutRef = useRef(null);
  useEffect(() => {
    if (taskId && !status) {
      restoreTimeoutRef.current = setTimeout(() => {
        setActiveTaskId(null);
        setLocalTaskId(null);
        setStatus(null);
        setLogs([]);
      }, 10000);
    }
    return () => {
      if (restoreTimeoutRef.current) {
        clearTimeout(restoreTimeoutRef.current);
        restoreTimeoutRef.current = null;
      }
    };
  }, [taskId, status]);

  const submitTraining = async (overwrite) => {
    let cleanDir = form.inputDir.trim();
    if ((cleanDir.startsWith('"') && cleanDir.endsWith('"')) ||
        (cleanDir.startsWith("'") && cleanDir.endsWith("'"))) {
      cleanDir = cleanDir.slice(1, -1);
    }
    const gAck = gateAckRef.current;
    const steps = recovery
      ? buildRecoverySteps()
      : {
          denoise: form.denoise, slice: form.slice, asr: form.asr, copyRaw: form.copyRaw,
          keepRawB4Extraction: form.keepRawB4Extraction !== false,
          train_s1: form.trainS1 !== false, train_s2: form.trainS2 !== false,
          pauseAfterAsr: !!form.preprocessReview, pauseAfterDenoise: form.pauseAfterDenoise !== false,
          keepStaging: !!form.keepStaging,
          // G1：无训练时跳过 preprocess 三步。G2：透传宽限期给后端。
          ...(gAck.preprocessOff ? { preprocess: false } : {}),
          ...(gAck.g2 ? { asrGraceSec: gAck.graceSec } : {}),
        };
    const recoveryFields = recovery
      ? (recoveryMode === 'modify'
          ? { forkFromTaskId: recovery.sourceTaskId }
          : { resumeTaskId: recovery.sourceTaskId, restartFailedStep: !!restartFailedStep })
      : {};
    const r = await api('/api/train/start', {
      method: 'POST',
      body: {
        displayName: form.voiceName.trim(),
        language: form.language,
        inputDir: cleanDir,
        overwrite: !!overwrite,
        ...recoveryFields,
        steps,
        customParams: {
          training: buildTrainingParams(form),
          steps: {
            slice: { params: buildSliceParams(form) },
            asr: { params: buildAsrParams(form) },
            denoise: { params: { pipeline: resolveVocalPipeline(form) } },
          },
        },
      },
    });
    // Existing-voice guard: server refuses without explicit overwrite. Surface a
    // confirm showing the DISPLAY NAME the id currently belongs to.
    if (!r.ok && r.status === 409 && r.data?.code === 'VOICE_EXISTS') {
      setOverwriteConfirm({ existingId: r.data.existingId, existingDisplay: r.data.existingDisplay });
      return;
    }
    if (!r.ok) throw new Error(r.data?.error || 'Failed to start training');
    setRecovery(null);
    paramSnapshotRef.current = null;
    setRestartFailedStep(false);
    setLocalTaskId(r.data.taskId);
    setActiveTaskId(r.data.taskId); // 写入持久化 + 触发 App 层重连
    gateAckRef.current = { g1: false, g2: false, preprocessOff: false, graceSec: 30 }; // 重置门控，下次启动重新评估
  };

  const handleStart = async () => {
    // In recovery mode the original audio folder is only needed when the rerun
    // starts at denoise/slice; later steps resume from cached products.
    const needsInput = !recovery || rerunStart === 'denoise' || rerunStart === 'slice';
    if (needsInput && !form.inputDir.trim()) {
      setError(recovery
        ? 'This resume restarts from denoise/slice, which needs the original audio folder. Please re-select it.'
        : 'Please select an audio folder');
      return;
    }
    if (!form.voiceName.trim()) { setError('Please enter a voice name'); return }
    // 管线门控（仅新训练，非恢复流）。命中则弹二级菜单，确认后回到本函数继续。
    if (!recovery) {
      const trainOn = form.trainS1 !== false || form.trainS2 !== false;
      const asrOn = form.asr !== false;
      const ack = gateAckRef.current;
      if (!trainOn && !ack.g1) { setError(null); setGate({ type: 'g1' }); return; }
      if (trainOn && !asrOn && !ack.g2) { setError(null); setGateGraceSec(30); setGate({ type: 'g2' }); return; }
    }
    // FunASR 语言告知门：FunASR 只支持中文/粤语。选了 FunASR 却是其他语言时，
    // 只做告知（继续 / 切换到 Whisper / 取消），不阻断，按用户意愿放行。
    {
      const asrOn = form.asr !== false;
      const lang = String(form.language || 'auto').toLowerCase();
      const funasrLangOk = lang === 'zh' || lang === 'yue' || lang === 'auto';
      if (asrOn && form.asrEngine === 'funasr' && !funasrLangOk && !asrLangAckRef.current) {
        setError(null);
        setAsrLangGate({ lang });
        return;
      }
    }
    // GPU pre-flight: when health has loaded and reports no CUDA device, block
    // behind an explicit acknowledgement instead of silently starting a CPU run.
    // (We only block on a definitive false; while health is still loading we let
    // it proceed rather than gate on unknown state.)
    if (cuda && cuda.ready && cuda.available === false) {
      setNoGpuAck(false);
      setNoGpuConfirm(true);
      return;
    }
    setError(null);
    setStatus(null);
    setLogs([]);
    try {
      await submitTraining(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // Continue a fine-tune after the user acknowledged the no-GPU warning.
  const proceedWithoutGpu = async () => {
    setNoGpuConfirm(false);
    setError(null);
    setStatus(null);
    setLogs([]);
    try {
      await submitTraining(false);
    } catch (err) {
      setError(err.message);
    }
  }

  // 门控确认：记下放行标记 + 覆盖项，关闭菜单，回到 handleStart 继续（GPU 检查 → 提交）。
  const confirmGate = async () => {
    const type = gate?.type;
    if (type === 'g1') {
      gateAckRef.current = { ...gateAckRef.current, g1: true, preprocessOff: true };
    } else if (type === 'g2') {
      const g = Math.max(0, Math.min(600, Math.round(Number(gateGraceSec) || 0)));
      gateAckRef.current = { ...gateAckRef.current, g2: true, graceSec: g };
    }
    setGate(null);
    await handleStart();
  };
  const cancelGate = () => { setGate(null); gateAckRef.current = { g1: false, g2: false, preprocessOff: false, graceSec: 30 }; };

  // FunASR 语言告知门，三选项（只告知，不阻断）。
  // 继续：坚持用 FunASR（后端仍会在失败时自动回退 Whisper 兜底）。
  const asrLangContinue = async () => {
    asrLangAckRef.current = true;
    setAsrLangGate(null);
    await handleStart();
  };
  // 切换到 Whisper：把引擎改成 faster-whisper 再继续（最稳）。
  const asrLangSwitchWhisper = async () => {
    asrLangAckRef.current = true;
    setAsrLangGate(null);
    setField('asrEngine', 'faster-whisper');
    // setField 是异步的；下一轮 handleStart 时 form 已更新，届时不再命中此门。
    setTimeout(() => { handleStart(); }, 0);
  };
  const asrLangCancel = () => { setAsrLangGate(null); asrLangAckRef.current = false; };

  const confirmOverwriteTrain = async () => {
    setOverwriteConfirm(null);
    setError(null);
    try {
      await submitTraining(true);
    } catch (err) {
      setError(err.message);
    }
  }

  const handleCancel = async () => {
    if (!taskId) return;
    await api(`/api/train/cancel/${taskId}`, { method: 'POST' });
  };

  const handleReset = () => {
    setActiveTaskId(null);
    setLocalTaskId(null);
    setStatus(null);
    setLogs([]);
    setError(null);
  };

  // Enter recovery mode for a cached failed/interrupted task: prefill the form with
  // the original params and pin the rerun start to the failed step (Continue mode).
  const beginResume = (task) => {
    const patch = archiveToForm(task);
    setForm(prev => {
      const next = { ...prev, ...patch };
      // Snapshot the loaded params as the baseline for change detection.
      paramSnapshotRef.current = buildStepParams(next);
      return next;
    });
    setRecovery({
      sourceTaskId: task.id,
      failedStep: task.resumeStep || (task.failedAt && task.failedAt.step) || 'preprocess',
      resumeStep: task.resumeStep || (task.failedAt && task.failedAt.step) || 'preprocess',
      steps: task.steps || {},
      hasInputDir: !!task.inputDir,
      failedAt: task.failedAt || null,
    });
    setRestartFailedStep(false);
    setError(null);
    setRecoverOpen(false);
    setSelectedNode(null);
  };

  const cancelRecovery = () => {
    setRecovery(null);
    paramSnapshotRef.current = null;
    setRestartFailedStep(false);
    setError(null);
  };

  // Which upstream steps can be chosen as the rerun start: completed steps up to and
  // including the failed step. Moving earlier than the failed step ⇒ Modify/fork.
  const failedIdx = recovery ? FSTEP_ORDER.indexOf(recovery.failedStep) : -1;
  const resumeStepOptions = recovery
    ? FSTEP_ORDER.filter((s, i) => i <= failedIdx &&
        (s === recovery.failedStep || (recovery.steps[s] && recovery.steps[s].status === 'completed')))
    : [];
  // Detect which steps' params the user changed since resume began. A change to an
  // UPSTREAM step (before the failure point, and selectable/completed) can't be applied
  // by an in-place resume — its cached output would be reused, silently ignoring the
  // edit. So we auto-pull the restart point back to the earliest changed upstream step,
  // which turns the run into a fork (new task) and re-runs from there.
  const changedSteps = recovery ? changedStepSet(buildStepParams(form), paramSnapshotRef.current) : new Set();
  const earliestChangedStep = recovery
    ? (FSTEP_ORDER.find(s => changedSteps.has(s) && resumeStepOptions.includes(s)) || null)
    : null;
  const userResumeStep = recovery ? recovery.resumeStep : null;
  // Effective restart = the earlier of the user's chosen step and the earliest changed step.
  const rerunStart = recovery
    ? ((earliestChangedStep && FSTEP_ORDER.indexOf(earliestChangedStep) < FSTEP_ORDER.indexOf(userResumeStep))
        ? earliestChangedStep : userResumeStep)
    : null;
  const rerunIdx = recovery ? FSTEP_ORDER.indexOf(rerunStart) : -1;
  // A param change forced the fork (vs the user manually dragging the restart earlier).
  const forkByParamChange = !!(recovery && earliestChangedStep && FSTEP_ORDER.indexOf(earliestChangedStep) < failedIdx
    && FSTEP_ORDER.indexOf(earliestChangedStep) <= rerunIdx);
  // Continue = restart exactly at the failed step (in place, same task). Modify =
  // restart at an earlier completed step (fork → new task; only upstream products copied).
  const recoveryMode = recovery ? (rerunIdx < failedIdx ? 'modify' : 'continue') : null;
  const failedIsTrain = recovery && (recovery.failedStep === 'train_s1' || recovery.failedStep === 'train_s2');

  // Compute the step-enable overrides sent on a recovery run: upstream (< rerunStart)
  // is reused (enabled=false → backend marks completed & skips); rerunStart..end run,
  // respecting the user's own enable toggles for optional steps.
  const buildRecoverySteps = () => {
    const idx = FSTEP_ORDER.indexOf(rerunStart);
    const on = (k, formVal) => (FSTEP_ORDER.indexOf(k) >= idx) ? formVal : false;
    return {
      denoise: on('denoise', !!form.denoise),
      slice: on('slice', !!form.slice),
      asr: on('asr', !!form.asr),
      copyRaw: form.copyRaw,
      keepRawB4Extraction: form.keepRawB4Extraction !== false,
      preprocess: on('preprocess', true),
      train_s1: on('train_s1', form.trainS1 !== false),
      train_s2: on('train_s2', form.trainS2 !== false),
      finalize: on('finalize', true),
      promote: on('promote', true),
      pauseAfterAsr: !!form.preprocessReview,
      pauseAfterDenoise: form.pauseAfterDenoise !== false,
    };
  };

  const [clearMsg, setClearMsg] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [cacheConfirm, setCacheConfirm] = useState(false);
  const handleClearStaging = async () => {
    if (clearing) return;
    setCacheConfirm(false);
    setClearing(true);
    setClearMsg(null);
    try {
      const r = await api('/api/train/clear-staging', { method: 'POST' });
      if (!r.ok) throw new Error(r.data?.error || 'Failed to clean cache');
      const mb = (r.data.bytes / (1024 * 1024)).toFixed(1);
      const skipped = r.data.skipped ? `, ${r.data.skipped} running task(s) kept` : '';
      setClearMsg(`Cleaned ${r.data.removed} task workspace(s), freed ${mb} MB${skipped}. Published models and assets are untouched.`);
    } catch (err) {
      setClearMsg(`Clean failed: ${err.message}`);
    } finally {
      setClearing(false);
    }
  };

  const editable = !taskId; // inputs are editable only before a task starts

  // Option A: the input is a DISPLAY NAME (Chinese/Unicode allowed). The canonical
  // ASCII id is decoupled and allocated by the server, once, atomically at task
  // creation. We fetch a PROPOSED preview id here purely for display — it is
  // explicitly non-reserved and the final id may differ. A slug/display-name
  // collision NEVER implies overwrite; every new voice gets a distinct id.
  const displayName = (form.voiceName || '').trim();
  const [proposedId, setProposedId] = useState('');
  useEffect(() => {
    if (!displayName) { setProposedId(''); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await api('/api/assets/derive-id', { method: 'POST', body: { display_name: displayName } });
      if (!cancelled && r.ok && r.data) setProposedId(r.data.proposed_id || '');
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [displayName]);
  // Non-blocking notice: other voices already using this exact display name.
  const dupDisplay = displayName
    ? voices.filter(v => (v.display_name || v.id) === displayName)
    : [];
  const enabledSteps = [
    form.denoise && 'Vocal extraction',
    form.copyRaw && 'Copy to raw', form.slice && 'Slice', form.asr && 'ASR',
    'Preprocess', 'S1 (GPT)', 'S2 (SoVITS)', 'Finalize', 'Publish',
  ].filter(Boolean);

  const renderNodeDetail = () => {
    if (!selectedNode) return null;
    return (
      <NodeDetailPanel
        selectedNode={selectedNode}
        status={status}
        editable={editable}
        form={form}
        setForm={setForm}
        setField={setField}
        applySlicePreset={applySlicePreset}
        onClose={() => setSelectedNode(null)}
        askConfirm={askConfirm}
        closeConfirm={closeConfirm}
        onMissingChange={setVocalMissingIds}
        download={uvr5Download}
        onDownloadChange={setUvr5Download}
        onStartDownload={startUvr5Download}
      />
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="section">
        <div className="section-hdr"><h2>Train New Voice</h2></div>
        <div className="section-body">
          {/* Recover a failed run — default-collapsed list of cached failed/interrupted
              tasks. "Resume" restores the pipeline and continues from the failure point. */}
          <RecoverableTasksPanel
            visible={!taskId}
            recoverOpen={recoverOpen}
            recoverList={recoverList}
            recoverLoading={recoverLoading}
            activeSourceTaskId={recovery && recovery.sourceTaskId}
            onToggle={() => { const n = !recoverOpen; setRecoverOpen(n); if (n) loadRecoverable(); }}
            onResume={beginResume}
          />

          {/* Essentials — one horizontal row so the page reads wide, not narrow */}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            <EssentialsFields
              form={form}
              setField={setField}
              proposedId={proposedId}
              dupDisplay={dupDisplay}
            />

            {/* Training Preset — built-in presets + your own saved snapshots. Custom
                lets you edit any parameter in the pipeline steps below; "Save as preset"
                snapshots the current values into a named, reusable preset you can then
                update or delete. Frontend-only: presets just fill existing form.* fields. */}
            <TrainingPresetPicker
              form={form}
              applyPreset={applyPreset}
              onSaveAsNew={() => setTrainPresetNameOpen(true)}
              onUpdate={updateTrainPreset}
              onDelete={deleteTrainPreset}
            />
          </fieldset>

          {/* Recovery banner — Continue (in place) vs Modify (fork → new task) */}
          <RecoveryBanner
            recovery={recovery}
            recoveryMode={recoveryMode}
            forkByParamChange={forkByParamChange}
            earliestChangedStep={earliestChangedStep}
            rerunStart={rerunStart}
            rerunStepOptions={resumeStepOptions}
            failedIsTrain={failedIsTrain}
            restartFailedStep={restartFailedStep}
            setRestartFailedStep={setRestartFailedStep}
            setRerunStart={e => setRecovery(r => ({ ...r, resumeStep: e }))}
            onCancelRecovery={cancelRecovery}
          />

          {/* Pipeline map — click a step to configure it (or inspect its status during a run) */}
          <div className="field" style={{ marginTop: 10 }}>
            <label className="field-label">{tr('Pipeline — click any step to configure', '流程：点击任意步骤进行配置')}</label>
            <PipelineMap
              statusSteps={status?.steps || (recovery ? recovery.steps : null)}
              enabledMap={recovery
                ? { denoise: rerunIdx <= 0 && form.denoise, slice: FSTEP_ORDER.indexOf('slice') >= rerunIdx && form.slice, asr: FSTEP_ORDER.indexOf('asr') >= rerunIdx && form.asr, train_s1: FSTEP_ORDER.indexOf('train_s1') >= rerunIdx && form.trainS1 !== false, train_s2: FSTEP_ORDER.indexOf('train_s2') >= rerunIdx && form.trainS2 !== false }
                : { denoise: form.denoise, slice: form.slice, asr: form.asr, train_s1: form.trainS1 !== false, train_s2: form.trainS2 !== false }}
              selectedNode={selectedNode}
              onSelect={setSelectedNode}
            />
          </div>
          {renderNodeDetail()}

          {/* Pre-flight summary — reflects live form.* values (advanced params edits flow
              through here too). Shows what is NOT already visible in the dropdowns / map. */}
          <PreflightSummary
            form={form}
            proposedId={proposedId}
            selVersions={_selVersions}
            baseModelStatus={baseModelStatus}
            showLowVram={showLowVram}
            cuda={cuda}
            onDismissLowVram={dismissLowVram}
          />

          {error && <div className="msg msg-error" style={{ marginTop: 8 }}>{error}</div>}

          {!taskId && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {form.denoise && vocalMissingIds.length > 0 ? (
                // The enabled vocal pipeline needs weights that are not installed. The
                // primary action becomes "Download model" until they are provisioned.
                <button className="btn btn-primary"
                  onClick={() => startUvr5Download(vocalMissingIds)}
                  disabled={uvr5Download && uvr5Download.status === 'running'}
                  title={tr('The selected vocal-extraction models are not installed. Download them before tuning.',
                    '所选的人声提取模型未安装，请先下载再开始微调。')}>
                  {uvr5Download && uvr5Download.status === 'running'
                    ? tr('Downloading…', '下载中…')
                    : tr('Download Model', '下载模型')}
                </button>
              ) : (
                <button className="btn btn-primary" onClick={handleStart}
                  disabled={form.trainS2 !== false && !!(baseModelStatus && baseModelStatus.anyBlocking)}
                  title={form.trainS2 !== false && !!(baseModelStatus && baseModelStatus.anyBlocking)
                    ? tr('Some selected SoVITS versions are missing base models — run download_models.py for them first', '所选的部分 SoVITS 版本缺少底模：请先为它们运行 download_models.py')
                    : ''}>{recovery ? (recoveryMode === 'modify' ? 'Fork & Resume' : 'Resume Tuning') : 'Start Tuning'}</button>
              )}
              <button className="btn btn-ghost" onClick={() => setCacheConfirm(true)} disabled={clearing}
                title={tr('Delete finished task workspaces from the .staging cache (running tasks are never touched)', '从 .staging 缓存中删除已完成的任务工作区（运行中的任务永远不会被动到）')}>
                {clearing ? tr('Cleaning…', '清理中…') : 'Clean Cache'}
              </button>
              {clearMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{clearMsg}</span>}
            </div>
          )}

          <ConfirmDialog
            open={cacheConfirm}
            title={tr('Clean training cache', '清理训练缓存')}
            message={tr('Delete all finished task workspaces from the training cache (.staging)? Running tasks are never deleted. Your published models and assets are not affected.',
              '要从训练缓存（.staging）中删除所有已完成的任务工作区吗？运行中的任务永远不会被删除。已发布的模型和资源不受影响。')}
            confirmLabel={tr('Clean cache', '清理缓存')}
            danger
            busy={clearing}
            icon={<IconTrash size={18} color="var(--danger)" />}
            onConfirm={handleClearStaging}
            onCancel={() => setCacheConfirm(false)}
          />

          {taskId && !status && (
            <div className="msg" style={{ marginTop: 10 }}>{tr('Restoring training state…', '正在恢复训练状态…')}</div>
          )}
          {taskId && status && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>
                  {status.status === 'completed' ? tr('Completed', '已完成')
                   : status.status === 'failed' ? tr('Failed', '失败')
                   : status.status === 'cancelled' ? tr('Cancelled', '已取消')
                   : status.status === 'interrupted' ? tr('Interrupted', '已中断')
                   : status.status === 'awaiting_review' ? (status.reviewStage === 'denoise' ? tr('Awaiting audition', '等待试听') : tr('Awaiting proofreading', '等待校对'))
                   : tr('Tuning…', '微调中…')}
                </span>
                {(isRunning || isAwaitingReview) && (
                  <button className="btn btn-sm btn-danger" onClick={handleCancel}>Cancel</button>
                )}
              </div>
              {isAwaitingReview && status?.reviewStage === 'denoise' && (
                <DenoiseReviewPanel taskId={taskId}
                  onResumed={() => setStatus(s => s ? { ...s, status: 'running' } : s)}
                  onCancel={handleCancel} />
              )}
              {isAwaitingReview && status?.reviewStage !== 'denoise' && status?.reviewStage !== 'asr' && (
                <div className="msg msg-warn" style={{ margin: '8px 0' }}>
                  {tr('Paused for review. If this looks stuck, your web build is stale — rebuild the frontend (npm run build) so the audition/proofreading panel loads.',
                      '已暂停等待校对。若卡住无法继续，说明前端构建是旧的：请重新构建前端（npm run build）以加载试听/校对面板。')}
                </div>
              )}
              {isAwaitingReview && status?.reviewStage === 'asr' && (
                <AsrReviewPanel taskId={taskId} engineId={engine?.id} lang={status?.language || form.language} onResumed={() => setStatus(s => s ? { ...s, status: 'running' } : s)} />
              )}
              {isInterrupted && (
                <div className="msg msg-error" style={{ marginBottom: 8 }}>
                  {tr('Tuning was interrupted. Go Back, then use “Recover a failed run” to resume it from where it stopped.',
                      '微调被中断。请点击“返回”，然后用“恢复失败的任务”从中断处继续。')}
                </div>
              )}
              {isFinished && (
                <button className="btn btn-sm btn-primary" style={{ marginTop: 4 }} onClick={handleReset}>{tr('Back', '返回')}</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Logs only appear once a task is running/finished — keeps the idle page clean */}
      {taskId && <LiveLogs logs={logs} />}

      {/* Overwrite confirmation: target voice id already exists on disk. */}
      {overwriteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setOverwriteConfirm(null)}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 360, maxWidth: 460,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Overwrite Existing Voice?</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              The id <strong>{overwriteConfirm.existingId}</strong> already belongs to{' '}
              <strong>&ldquo;{overwriteConfirm.existingDisplay}&rdquo;</strong>.
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
              Training will publish into <code>assets/{overwriteConfirm.existingId}/</code> and
              permanently replace the models and references of that voice. This cannot be undone.
              If you meant to keep both, cancel and give this one a different name.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setOverwriteConfirm(null)}>Cancel</button>
              <button className="btn btn-sm btn-danger" onClick={confirmOverwriteTrain}>Overwrite &amp; Train</button>
            </div>
          </div>
        </div>
      )}

      {/* No-GPU pre-flight: CPU fine-tuning is allowed but must be acknowledged. */}
      {/* 门控 G1：未开启 S1/S2，只跑切片/ASR，跳过 preprocess。 */}
      <ConfirmDialog
        open={gate?.type === 'g1'}
        icon={<span style={{ fontSize: 18 }}>ⓘ</span>}
        title={tr('No fine-tuning steps selected', '未选择微调步骤')}
        confirmLabel={tr('Continue (skip preprocess)', '继续（跳过预处理）')}
        onConfirm={confirmGate}
        onCancel={cancelGate}
        message={
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            {tr(
              'Neither S1 (GPT) nor S2 (SoVITS) training is enabled. This run will only slice / transcribe (with optional proofreading); the three preprocess steps will be skipped since there is nothing to train.',
              '未启用 S1 (GPT) 或 S2 (SoVITS) 训练。本次将只执行切片 / 转写（含可选人工校对），由于没有要训练的模型，将跳过 preprocess 三步。')}
          </div>
        }
      />

      {/* 门控 G2/G3：训练开启但未勾 ASR，强提醒不阻断 + 宽限期投放自备 .list。 */}
      <ConfirmDialog
        open={gate?.type === 'g2'}
        danger
        icon={<span style={{ fontSize: 18 }}>⚠️</span>}
        title={tr('ASR is not enabled', '未启用 ASR')}
        confirmLabel={tr('Continue anyway', '仍然继续')}
        onConfirm={confirmGate}
        onCancel={cancelGate}
        message={
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              {tr(
                'Training is enabled but ASR is off, so no transcript will be produced. Without a transcript, preprocessing will fail — unless you supply your own.',
                '已启用训练但未勾选 ASR，本次不会生成转写。若没有转写，预处理会失败，除非自备转写。')}
            </p>
            <p>
              {tr(
                'Before preprocessing, the system will wait for the seconds below so you can copy your file into the staging folder (its absolute path is printed in the logs).',
                '在预处理前，系统会等待下面设定的秒数，留出时间把文件复制进暂存目录（其绝对路径会打印在日志中）。')}
            </p>
            <p style={{ color: 'var(--muted)', fontSize: 12 }}>
              {tr(
                'Rule: a .list overrides segments.json; or drop segments.json directly. Provide only one.',
                '规则：放 .list 会覆写 segments.json；或直接放 segments.json。二者只放其一。')}
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span>{tr('Grace period (seconds)', '宽限期（秒）')}</span>
              <input type="number" className="control" min={0} max={600} value={gateGraceSec}
                     onChange={e => setGateGraceSec(e.target.value)}
                     style={{ width: 90 }} />
            </label>
          </div>
        }
      />

      {noGpuConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setNoGpuConfirm(false)}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 24, minWidth: 380, maxWidth: 480,
            boxShadow: 'var(--shadow-soft)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>🐢</span>
              <span style={{ fontWeight: 600, fontSize: 14 }}>未检测到 NVIDIA GPU</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
              当前设备没有可用的 CUDA GPU。微调将在 <strong>CPU</strong> 上运行，
              可能<strong>耗时数小时甚至数十倍</strong>，且<strong>人声分离（UVR5）不可用</strong>。
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              推理不受影响，可正常在 CPU 上使用。若只是想生成语音，无需在此训练。
            </p>
            <label className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
              <input type="checkbox" checked={noGpuAck} onChange={e => setNoGpuAck(e.target.checked)} />
              我知道 CPU 微调会非常慢，仍要继续
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setNoGpuConfirm(false)}>取消</button>
              <button className="btn btn-sm btn-primary" disabled={!noGpuAck} onClick={proceedWithoutGpu}>仍要开始</button>
            </div>
          </div>
        </div>
      )}

      {asrLangGate && (() => {
        const LANG_LABEL = {
          auto: tr('Auto-detect', '自动检测'), ja: tr('Japanese', '日语'),
          zh: tr('Chinese', '中文'), en: tr('English', '英语'), ko: tr('Korean', '韩语'),
        };
        const langName = LANG_LABEL[asrLangGate.lang] || asrLangGate.lang;
        return (
          <div className="modal-overlay" onClick={asrLangCancel}>
            <div className="modal-card confirm-card" onClick={e => e.stopPropagation()}>
              <div className="confirm-hdr"><span>{tr('ASR engine / language mismatch', 'ASR 引擎与语言不匹配')}</span></div>
              <div className="confirm-body">
                <p style={{ fontSize: 13, margin: 0, color: 'var(--warning, #e0b341)', fontWeight: 500 }}>
                  {tr(`FunASR only supports Chinese / Cantonese. The current language is ${langName}; continuing may produce errors.`,
                      `FunASR 仅支持中文/粤语，当前语言是${langName}，继续运行可能出错。`)}
                </p>
              </div>
              <div className="confirm-actions">
                <button className="btn btn-sm" onClick={asrLangCancel}>{tr('Cancel', '取消')}</button>
                <button className="btn btn-sm" onClick={asrLangSwitchWhisper}>{tr('Switch to Whisper', '切换到 Whisper')}</button>
                <button className="btn btn-sm btn-primary" onClick={asrLangContinue}>{tr('Continue', '继续')}</button>
              </div>
            </div>
          </div>
        );
      })()}

      <PresetNameModal
        open={trainPresetNameOpen}
        existingNames={(form.trainSavedPresets || []).map(s => s.name)}
        onSave={commitTrainPreset}
        onClose={() => setTrainPresetNameOpen(false)}
        example="my-tune-pipeline"
      />
      <ConfirmModal
        open={!!confirmState}
        title={confirmState?.title}
        message={confirmState?.message}
        confirmLabel={confirmState?.confirmLabel}
        onConfirm={confirmState?.onConfirm}
        onClose={closeConfirm}
      />
    </div>
  )
}

export {
  RebuildProgress,
  TrainingTab,
  RestoreModal,
  // — reused by the Refinement modal so it exposes the exact same training
  // parameter fields / serialiser / defaults as the Training and Restore flows.
  TrainParamFields,
  buildTrainingParams,
  REBUILD_PARAM_DEFAULTS,
  LANGUAGES,
}
