// AUTO-EXTRACTED from TrainingTab.jsx (pure mechanical, zero logic change).
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { usePersistentState } from '../../usePersistentState'
import { api } from '../../lib/api'
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
  FSTEP_LABELS,
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
import { SliceParamFields, AsrParamFields, TrainParamFields } from './ParamCols'
import { PipelineMap, RebuildProgress, LiveLogs } from './TrainPanels'
import { DenoiseReviewPanel, AsrReviewPanel } from './ReviewPanels'
import { PresetNameModal, ConfirmModal, RestoreModal } from './trainModals'

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

  // UVR5 model availability (labels + installed flags) for the Vocal Extraction panel.
  const [uvr5Models, setUvr5Models] = useState(null);   // [{id,label,category,arch,aggApplicable,installed,...}]
  const uvr5ById = useMemo(
    () => Object.fromEntries((uvr5Models || []).map(m => [m.id, m])), [uvr5Models]);
  const loadUvr5Models = useCallback(() => {
    api('/api/uvr5/models')
      .then(r => { if (r.ok && r.data) setUvr5Models(r.data.models || []); })
      .catch(() => {});
  }, []);
  useEffect(() => { loadUvr5Models(); }, [loadUvr5Models]);

  // Download job state for on-demand weight provisioning.
  const [uvr5Download, setUvr5Download] = useState(null); // {jobId,status,models,...}
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
        if (r.data.status === 'completed' || r.data.status === 'failed') {
          loadUvr5Models(); // refresh installed flags
        }
      }).catch(() => {});
    };
    const iv = setInterval(tick, 1200); tick();
    return () => { stop = true; clearInterval(iv); };
  }, [uvr5Download?.jobId, uvr5Download?.status, loadUvr5Models]);

  // Which models the CURRENT vocal pipeline needs, and which are missing.
  const vocalPipelineNow = form.denoise ? resolveVocalPipeline(form) : [];
  const vocalNeededIds = [...new Set(vocalPipelineNow.map(s => s.model))];
  const vocalMissingIds = uvr5Models
    ? vocalNeededIds.filter(id => { const m = uvr5ById[id]; return m && !m.installed; })
    : [];

  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
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

  const NODE_LABELS = {
    denoise: tr('Vocal Extraction', '人声提取'), slice: tr('Slicing', '切片'), asr: tr('ASR Transcription', 'ASR 转写'),
    preprocess: tr('Preprocess', '预处理'), train_s1: tr('S1 Training (GPT)', 'S1 训练 (GPT)'), train_s2: tr('S2 Training (SoVITS)', 'S2 训练 (SoVITS)'),
    finalize: tr('Finalize', '打包完成'), promote: tr('Publish', '发布'),
  };

  // ── Vocal Extraction panel ────────────────────────────────────────────────
  // Preset-first (encodes official domain knowledge), with an Expert reveal that
  // exposes per-stage params, and a Custom second-level chain editor (mirrors the
  // official UVR5 UI) that can be saved back as a preset. Availability + on-demand
  // download are surfaced inline so a missing weight never fails mid-run.
  const modelLabel = (id) => {
    const m = uvr5ById[id];
    if (m) return tr(m.label.en, m.label.zh);
    return id;
  };
  const modelInstalled = (id) => { const m = uvr5ById[id]; return !uvr5Models || (m && m.installed); };
  const modelAggApplicable = (id) => { const m = uvr5ById[id]; return m ? m.aggApplicable : true; };
  // arch drives which expert params apply. Fall back to registry-derived arch when
  // the catalogue hasn't loaded, so the panel still renders offline.
  const modelArch = (id) => {
    const m = uvr5ById[id];
    if (m && m.arch) return m.arch;
    if (id === 'MDX-Net') return 'mdx';
    if (id === 'BS-Roformer') return 'roformer';
    return 'vr';
  };

  // Reusable expert-control block for ONE stage. `stage` supplies current values,
  // `applyPatch({key:val})` persists a change. Renders only the knobs applicable
  // to the stage model's architecture (source-verified per arch).
  const renderStageExpert = (stage, applyPatch) => {
    const keys = expertKeysForArch(modelArch(stage.model));
    if (!keys.length) return null;
    return (
      <div style={{ marginTop: 6, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
        {keys.map(k => {
          const meta = EXPERT_META[k];
          const cur = stage[k] != null ? stage[k] : meta.default;
          const id = `exp-${stage.model}-${k}`;
          return (
            <div key={k} style={{ marginBottom: 6 }}>
              {meta.type === 'bool' ? (
                <label className="toggle-row" style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={!!cur} onChange={e => applyPatch({ [k]: e.target.checked })} />
                  {tr(meta.label[0], meta.label[1])}
                </label>
              ) : (
                <>
                  <label className="field-label" htmlFor={id} style={{ fontSize: 12 }}>{tr(meta.label[0], meta.label[1])}</label>
                  {meta.type === 'enum' ? (
                    <Select id={id} className="control" value={cur} onChange={e => applyPatch({ [k]: e.target.value })}>
                      {meta.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <input id={id} type="number" className="control" min={meta.min} max={meta.max} value={cur}
                      onChange={e => {
                        let v = parseInt(e.target.value, 10);
                        if (!Number.isFinite(v)) v = meta.default;
                        v = Math.min(meta.max, Math.max(meta.min, v));
                        applyPatch({ [k]: v });
                      }} />
                  )}
                </>
              )}
              <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '2px 0 0' }}>{tr(meta.hint[0], meta.hint[1])}</p>
            </div>
          );
        })}
      </div>
    );
  };

  // Grouped <option> list for a stage's model picker (installed status annotated).
  const renderModelOptions = () => {
    if (!uvr5Models) return <option value="">{tr('loading…', '加载中…')}</option>;
    const cats = [
      ['keep_vocals', tr('Keep vocals', '保留人声')],
      ['main_vocal', tr('Only main vocal', '仅保留主人声')],
      ['dereverb', tr('De-reverb / de-echo', '去混响 / 去延迟')],
    ];
    return cats.map(([cat, label]) => {
      const items = uvr5Models.filter(m => m.category === cat);
      if (!items.length) return null;
      return (
        <optgroup key={cat} label={label}>
          {items.map(m => (
            <option key={m.id} value={m.id}>
              {tr(m.label.en, m.label.zh)}{m.installed ? '' : tr(' — not installed', '：未安装')}
            </option>
          ))}
        </optgroup>
      );
    });
  };

  const presetOptions = () => {
    const opts = VOCAL_PRESETS.map(p => {
      const ids = p.pipeline ? p.pipeline.map(s => s.model) : [];
      const missing = uvr5Models ? ids.filter(id => uvr5ById[id] && !uvr5ById[id].installed) : [];
      const suffix = missing.length ? tr(' — needs download', '：需下载') : '';
      return <option key={p.id} value={p.id}>{tr(p.label[0], p.label[1])}{suffix}</option>;
    });
    const saved = (form.denoiseSavedPresets || []).map(s => (
      <option key={`saved:${s.name}`} value={`saved:${s.name}`}>{tr('Saved', '已保存')}: {s.name}</option>
    ));
    return saved.length ? [...opts.slice(0, -1), <optgroup key="saved" label={tr('Saved presets', '已保存预设')}>{saved}</optgroup>, opts[opts.length - 1]] : opts;
  };

  // ---- Selected cleanup preset + the editable-chain abstraction -------------
  // Both "custom" and a "saved:<name>" preset edit the SAME working buffer,
  // form.denoisePipeline. Selecting a saved preset seeds the buffer from it; edits
  // are a draft and DON'T touch the stored preset until you press "Update preset"
  // (mirrors the Training Preset UX). "Save as new preset" branches a fresh copy;
  // "Delete preset" removes it (with confirm).
  const curPreset = form.denoisePreset || 'bgm';
  const curPresetDef = VOCAL_PRESET_BY_ID[curPreset];
  const isCustom = curPreset === 'custom';
  const savedList = Array.isArray(form.denoiseSavedPresets) ? form.denoiseSavedPresets : [];
  const isSaved = typeof curPreset === 'string' && curPreset.startsWith('saved:');
  const savedName = isSaved ? curPreset.slice(6) : null;
  const savedIdx = isSaved ? savedList.findIndex(s => s.name === savedName) : -1;
  const savedPreset = savedIdx >= 0 ? savedList[savedIdx] : null;
  // Whether the second-level chain editor is active (custom OR a saved preset).
  const chainEditable = isCustom || (isSaved && !!savedPreset);

  // Chain mutators always operate on the working buffer (form.denoisePipeline).
  const chain = Array.isArray(form.denoisePipeline) ? form.denoisePipeline : [];
  const setChain = (next) => setField('denoisePipeline', next);
  // Does the draft differ from the stored saved preset? Drives the Update button.
  const savedDirty = isSaved && savedPreset
    ? JSON.stringify(savedPreset.pipeline || []) !== JSON.stringify(chain)
    : false;
  const addStage = () => {
    if (chain.length >= 3) return;
    const firstInstalled = (uvr5Models || []).find(m => m.installed) || (uvr5Models || [])[0];
    const id = firstInstalled ? firstInstalled.id : 'HP2';
    setChain([...chain, modelAggApplicable(id) ? { model: id, agg: AGG_DEFAULT } : { model: id }]);
  };
  const removeStage = (i) => setChain(chain.filter((_, k) => k !== i));
  const updateStage = (i, patch) => setChain(chain.map((s, k) => {
    if (k !== i) return s;
    const next = { ...s, ...patch };
    if (patch.model != null) {
      if (modelAggApplicable(patch.model)) { if (next.agg == null) next.agg = AGG_DEFAULT; }
      else { delete next.agg; }
      // Drop expert knobs that don't apply to the new architecture.
      const keep = new Set(expertKeysForArch(modelArch(patch.model)));
      for (const ek of EXPERT_KEYS) if (!keep.has(ek)) delete next[ek];
    }
    return next;
  }));
  // Cleanup-preset dropdown handler. Selecting a saved preset seeds the working
  // buffer with a fresh COPY of its stored pipeline (so edits are a draft, not a
  // live mutation). Selecting custom keeps whatever's in the buffer; a system
  // preset leaves the buffer untouched (it runs from its template instead).
  const applyDenoisePreset = (value) => {
    if (typeof value === 'string' && value.startsWith('saved:')) {
      const name = value.slice(6);
      const saved = (form.denoiseSavedPresets || []).find(s => s.name === name);
      const copy = saved && Array.isArray(saved.pipeline) ? saved.pipeline.map(s => ({ ...s })) : [];
      setForm(f => ({ ...f, denoisePreset: value, denoisePipeline: copy }));
    } else {
      setField('denoisePreset', value);
    }
  };
  const [presetNameOpen, setPresetNameOpen] = useState(false);
  const saveChainAsPreset = () => setPresetNameOpen(true);
  const commitChainPreset = (rawName) => {
    const name = (rawName || '').trim();
    if (!name) return;
    const rest = (form.denoiseSavedPresets || []).filter(s => s.name !== name);
    setForm(f => ({ ...f, denoiseSavedPresets: [...rest, { name, pipeline: chain }], denoisePreset: `saved:${name}` }));
    setPresetNameOpen(false);
  };
  // Explicit "Update preset": write the current draft buffer back to the selected
  // saved preset. Edits are NOT persisted until this is pressed (parity with the
  // Training Preset's Update action).
  const updateSavedPreset = () => {
    if (!isSaved || !savedName) return;
    setForm(f => ({
      ...f,
      denoiseSavedPresets: (f.denoiseSavedPresets || []).map(
        s => s.name === savedName ? { ...s, name: savedName, pipeline: chain } : s),
    }));
  };
  // Delete the currently-selected saved preset (with confirm) and fall back to Custom.
  const deleteSavedPreset = () => {
    if (!isSaved || !savedName) return;
    askConfirm({
      title: tr('Delete vocal-extraction preset', '删除人声提取预设'),
      message: tr(`Delete the saved preset “${savedName}”? This can't be undone.`,
                  `确定删除已保存的预设“${savedName}”吗？此操作不可撤销。`),
      confirmLabel: tr('Delete', '删除'),
      onConfirm: () => {
        setForm(f => ({
          ...f,
          denoiseSavedPresets: (f.denoiseSavedPresets || []).filter(s => s.name !== savedName),
          denoisePreset: 'custom',
        }));
        closeConfirm();
      },
    });
  };

  const dlModels = uvr5Download?.models || {};

  // Per-preset stage overrides live on form.denoisePresetParams[preset][stageIdx]
  // as an object {agg?, tta?, ...} (page-persistent only). Merge in a patch.
  const presetStageOverride = (i) => {
    const raw = ((form.denoisePresetParams || {})[curPreset] || {})[i];
    return typeof raw === 'number' ? { agg: raw } : (raw || {});
  };
  const patchPresetStage = (i, patch) => setForm(f => {
    const all = { ...(f.denoisePresetParams || {}) };
    const forPreset = { ...(all[curPreset] || {}) };
    const prev = typeof forPreset[i] === 'number' ? { agg: forPreset[i] } : (forPreset[i] || {});
    forPreset[i] = { ...prev, ...patch };
    all[curPreset] = forPreset;
    return { ...f, denoisePresetParams: all };
  });

  // The stages whose ADVANCED knobs the gated block should edit, with a per-stage
  // apply(patch). Custom → the user chain (patched via updateStage); a preset →
  // its template stages (patched as page-persistent overrides). Only stages that
  // actually expose advanced knobs (per arch) are included.
  const advStages = (() => {
    let src;
    if (chainEditable) {
      src = chain.map((stage, i) => ({ stage, i, apply: (patch) => updateStage(i, patch) }));
    } else if (curPresetDef && curPresetDef.pipeline) {
      src = curPresetDef.pipeline.map((stage, i) => ({
        stage: { ...stage, ...presetStageOverride(i) }, i,
        apply: (patch) => patchPresetStage(i, patch),
      }));
    } else {
      src = [];
    }
    return src.filter(({ stage }) => expertKeysForArch(modelArch(stage.model)).length > 0);
  })();

  const renderVocalExtraction = () => (
    <>
      <label className="toggle-row" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={form.denoise} onChange={e => setField('denoise', e.target.checked)} />
        {tr('Enable vocal extraction', '启用人声提取')}
      </label>

      {form.denoise && (
        <>
          {/* GIGO 门 1：人声提取后暂停试听。与 ASR 校对门并列，默认开启，分离质量
              是决定训练成败的第一道关口，值得停下来听一耳朵（不满意可直接取消管线）。
              放在“启用人声提取”正下方，与该步骤的开关相邻，而非埋在高级参数里。 */}
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.pauseAfterDenoise !== false}
                   onChange={e => setField('pauseAfterDenoise', e.target.checked)} />
            {tr('Pause after vocal extraction to audition', '人声提取后暂停以试听校对')}
          </label>
          <p className="field-hint" style={{ marginTop: -2, marginBottom: 8 }}>
            {tr('When enabled the pipeline stops right after separation so you can listen to the extracted vocals. Continue if they sound clean, or cancel the run if the quality is poor — this is the first GIGO gate.',
                '启用后，流程会在分离完成后立即停止，供试听提取出的人声。音质清晰则继续，质量差就取消本次任务：这是决定成败的第一道 GIGO 门。')}
          </p>

          {/* 提取后，分离出的人声才是真正的“raw”（切片/ASR/训练都用它）。提取前的
              原始混音默认归档到资产的 raw_b4_extraction/，便于日后重构或换参重跑。
              个别只想留最终人声、希望节省磁盘的用户可以关掉。 */}
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.keepRawB4Extraction !== false}
                   onChange={e => setField('keepRawB4Extraction', e.target.checked)} />
            {tr('Keep pre-extraction originals (raw_b4_extraction/)', '保留提取前的原始音频（raw_b4_extraction/）')}
          </label>
          <p className="field-hint" style={{ marginTop: -2, marginBottom: 8 }}>
            {tr('After extraction the separated vocals become the asset\u2019s raw/ (they are what slicing, ASR and training use). The original pre-extraction mixdown is archived to raw_b4_extraction/ so the voice folder stays self-contained and can be reconstructed. Turn this off to save disk if you only need the final vocals.',
                '提取完成后，分离出的人声会成为资产的 raw/（切片、ASR、训练都用它）。提取前的原始混音则归档到 raw_b4_extraction/，让音色目录自包含、可随时重构或换参重跑。若只需最终人声、希望节省磁盘空间，可关闭此项。')}
          </p>

          <div className="field">
            <label className="field-label">{tr('Cleanup preset', '清洗方式')}</label>
            <Select className="control" value={curPreset} onChange={e => applyDenoisePreset(e.target.value)}>
              {presetOptions()}
            </Select>
            {curPresetDef && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{tr(curPresetDef.hint[0], curPresetDef.hint[1])}</p>
            )}
          </div>

          {/* NORMAL params (low-impact, routinely adjusted) — shown directly, like
              S1's Epochs/Batch. For presets this is the per-VR-stage aggressiveness. */}
          {!isCustom && curPresetDef && curPresetDef.pipeline &&
            curPresetDef.pipeline.some(s => modelAggApplicable(s.model) && 'agg' in s) && (
            <div className="field" style={{ marginBottom: 8 }}>
              {curPresetDef.pipeline.map((stage, i) => {
                if (!(modelAggApplicable(stage.model) && 'agg' in stage)) return null;
                const merged = { ...stage, ...presetStageOverride(i) };
                return (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <label className="field-label" style={{ fontSize: 12 }}>
                      {curPresetDef.pipeline.length > 1 ? `${i + 1}. ${modelLabel(stage.model)} — ` : ''}
                      {tr('Aggressiveness', '激进度')} ({merged.agg})
                    </label>
                    <input type="range" min={0} max={20} step={1} value={merged.agg} style={{ width: '100%' }}
                      onChange={e => patchPresetStage(i, { agg: parseInt(e.target.value, 10) })} />
                  </div>
                );
              })}
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {tr('Settings are kept on this page only (not saved permanently to the recipe).',
                  '参数仅保存在本页面，不会永久写入配方。')}
              </p>
            </div>
          )}

          {/* Second-level chain editor (mirrors the official UVR5 UI). Used for
              Custom AND for a saved preset — a saved preset is edited in place with
              the same controls, plus Update/Delete management. Model + aggressiveness
              (normal) stay inline; advanced knobs move into the gated 高级参数 block. */}
          {chainEditable && (
            <div className="field" style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {isSaved
                  ? tr(`Editing saved preset “${savedName}”${savedDirty ? ' (unsaved changes)' : ''} — runs top to bottom (each stage feeds the next).`,
                      `正在编辑已保存预设“${savedName}”${savedDirty ? '（有未保存的改动）' : ''}，从上到下逐级串联（上一级输出喂给下一级）。`)
                  : tr('Custom separation chain — runs top to bottom (each stage feeds the next).',
                      '自定义分离链：从上到下逐级串联（上一级输出喂给下一级）。')}
              </div>
              {chain.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>{tr('No stages yet. Add one below.', '还没有分级，请在下方添加。')}</p>
              )}
              {chain.map((stage, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i + 1}</span>
                  <Select className="control" style={{ flex: '1 1 200px' }} value={stage.model} onChange={e => updateStage(i, { model: e.target.value })}>
                    {renderModelOptions()}
                  </Select>
                  {modelAggApplicable(stage.model) && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      {tr('agg', '激进度')}
                      <input type="range" min={0} max={20} step={1} value={stage.agg != null ? stage.agg : AGG_DEFAULT}
                        onChange={e => updateStage(i, { agg: parseInt(e.target.value, 10) })} />
                      <span style={{ width: 18, textAlign: 'right' }}>{stage.agg != null ? stage.agg : AGG_DEFAULT}</span>
                    </span>
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => removeStage(i)} title={tr('Remove', '删除')}><IconTrash /></button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={addStage} disabled={chain.length >= 3}>{tr('+ Add stage', '+ 添加一级')}</button>
                {isSaved && (
                  <button className="btn btn-sm btn-primary" onClick={updateSavedPreset} disabled={!savedDirty}>
                    {tr('Update preset', '更新预设')}
                  </button>
                )}
                <button className="btn btn-sm" onClick={saveChainAsPreset} disabled={chain.length === 0}>
                  {isSaved ? tr('Save as new preset', '另存为新预设') : tr('Save as preset', '保存为预设')}
                </button>
                {isSaved && (
                  <button className="btn btn-sm btn-danger" onClick={deleteSavedPreset}>{tr('Delete preset', '删除预设')}</button>
                )}
              </div>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                {isSaved
                  ? tr('Up to 3 stages. Edits are a draft — press “Update preset” to save them back, “Save as new preset” to branch a copy, or “Delete preset” to remove it.',
                      '最多 3 级。改动仅为草稿：点“更新预设”才会写回，点“另存为新预设”另存副本，点“删除预设”移除。')
                  : tr('Up to 3 stages. Saved presets are kept on this page only.', '最多 3 级。已保存预设仅保留在本页面。')}
              </p>
            </div>
          )}

          {/* ADVANCED params (high-impact / fragile) — collapsible + gated, mirrors
              the S1 "Advanced Parameters" pattern. Named 高级参数 (not 专家). */}
          {advStages.length > 0 && (
            <details className="expert-block" style={{ marginTop: 4, marginBottom: 8 }}>
              <summary className="expert-summary">{tr('Advanced Parameters — separator internals', '高级参数：分离器内部设置')}</summary>
              <div className="msg msg-danger expert-warning">
                <strong>{tr('⚠ Advanced.', '⚠ 高级参数。')}</strong>{' '}
                {tr('These change speed/precision. fp16 makes HP models emit NaN on many GPUs; TTA roughly doubles time. Most users should leave the defaults.',
                  '这些会影响速度/精度。fp16 会让 HP 系列在很多显卡上出 NaN；TTA 大致会让耗时翻倍。多数用户保持默认即可。')}
              </div>
              <label className="toggle-row expert-unlock">
                <input type="checkbox" checked={!!form.denoiseAdvUnlocked} onChange={e => setField('denoiseAdvUnlocked', e.target.checked)} />
                {tr('I understand — let me edit advanced parameters', '我了解，允许我编辑高级参数')}
              </label>
              <fieldset disabled={!form.denoiseAdvUnlocked} className="expert-fields" style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
                {advStages.map(({ stage, apply, i }) => {
                  const body = renderStageExpert(stage, apply);
                  if (!body) return null;
                  return (
                    <div key={i} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{i + 1}. {modelLabel(stage.model)}</div>
                      {body}
                    </div>
                  );
                })}
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {tr('Settings are kept on this page only (not saved permanently to the recipe).',
                    '参数仅保存在本页面，不会永久写入配方。')}
                </p>
              </fieldset>
            </details>
          )}

          {/* Availability + on-demand download. */}
          {vocalMissingIds.length > 0 && (
            <div className="msg" style={{ background: 'rgba(255,180,0,0.12)', padding: 10, borderRadius: 6, marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                {tr('These models are not installed: ', '以下模型未安装：')}
                <strong>{vocalMissingIds.map(modelLabel).join(', ')}</strong>
              </div>
              {uvr5Download && uvr5Download.status === 'running' ? (
                <div style={{ fontSize: 12 }}>
                  {tr('Downloading…', '下载中…')}{' '}
                  {Object.entries(dlModels).map(([id, s]) => `${id} ${s.pct || 0}%`).join(' · ')}
                </div>
              ) : (
                <button className="btn btn-sm btn-primary" onClick={() => startUvr5Download(vocalMissingIds)}>
                  {tr('Download model', '下载模型')}
                </button>
              )}
              {uvr5Download && uvr5Download.status === 'failed' && (
                <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
                  {tr('Download failed: ', '下载失败：')}{uvr5Download.error || ''}
                </div>
              )}
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                {tr('Downloaded from Hugging Face (ModelScope fallback) into uvr5_weights/.',
                  '从 Hugging Face 下载（ModelScope 备用）到 uvr5_weights/。')}
              </p>
            </div>
          )}
        </>
      )}
    </>
  );

  const renderNodeDetail = () => {
    if (!selectedNode) return null;
    const stepSt = status?.steps?.[selectedNode]?.status;
    const stBadge = stepSt && (
      <span className={`badge ${stepSt === 'completed' ? 'badge-ok' : stepSt === 'running' ? 'badge-accent' : stepSt === 'failed' ? 'badge-danger' : 'badge-neutral'}`}>{stepSt}</span>
    );
    let body = null;
    if (selectedNode === 'denoise') {
      body = renderVocalExtraction();
    } else if (selectedNode === 'slice') {
      // Invariant #5: an asset must end up with at least one kind of reference audio.
      // slice → slicer_opt/ ; copyRaw → raw/. Both off would publish an empty asset,
      // so unchecking one auto-forces the other on.
      const toggleSlice = (checked) => {
        setForm(f => ({ ...f, slice: checked, copyRaw: checked ? f.copyRaw : true }));
      };
      const toggleCopyRaw = (checked) => {
        setForm(f => ({ ...f, copyRaw: checked, slice: checked ? f.slice : true }));
      };
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.slice} onChange={e => toggleSlice(e.target.checked)} />
            {tr('Enable slicing', '启用切片')}
          </label>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.copyRaw} onChange={e => toggleCopyRaw(e.target.checked)} />
            {tr('Copy raw audio into the asset (keep originals as reference)', '将原始音频复制进资源（保留原始文件作为参考）')}
          </label>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: -2, marginBottom: 8 }}>
            {tr(
              <>At least one kind of reference audio is required: slicing or copied raw.
              Turning off “Copy raw” forces slicing on, and vice versa (otherwise the asset
              would have no reference audio). When slicing is off, ASR writes <code>raw_opt.list</code>.</>,
              <>至少需要一种参考音频：切片或复制的原始音频。关闭“复制原始音频”会强制开启切片，反之亦然
              （否则资源将没有参考音频）。切片关闭时，ASR 会写入 <code>raw_opt.list</code>。</>)}
          </p>
          <div className="field">
            <label className="field-label">{tr('Slicing preset', '切片预设')}</label>
            <Select className="control" onChange={e => applySlicePreset(e.target.value)} defaultValue="">
              <option value="" disabled>{tr('Choose a preset…', '选择一个预设…')}</option>
              <option value="default">{tr('Default', '默认')}</option>
              <option value="aggressive">{tr('More aggressive split', '更激进的切分')}</option>
              <option value="longer">{tr('Fewer, longer clips', '更少、更长的片段')}</option>
              <option value="none">{tr('Already sliced (no slicing)', '已切片（不再切片）')}</option>
            </Select>
          </div>
          {form.slice && (
            <div style={{ marginTop: 4 }}>
              <SliceParamFields form={form} setField={setField} />
            </div>
          )}
        </>
      );
    } else if (selectedNode === 'asr') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.asr} onChange={e => setField('asr', e.target.checked)} />
            {tr('Enable transcription (ASR)', '启用转写 (ASR)')}
          </label>
          {form.asr && <AsrParamFields form={form} setField={setField} />}
        </>
      );
    } else if (selectedNode === 'train_s1') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.trainS1 !== false} onChange={e => setField('trainS1', e.target.checked)} />
            {tr('Enable S1 (GPT) fine-tuning', '启用 S1 (GPT) 微调')}
          </label>
          {form.trainS1 !== false
            ? <TrainParamFields form={form} setField={setField} part="s1" />
            : <p style={{ fontSize: 11, color: 'var(--muted)' }}>{tr('S1 (GPT) fine-tuning is turned off — this step will be skipped.', 'S1 (GPT) 微调已关闭：此步骤将被跳过。')}</p>}
        </>
      );
    } else if (selectedNode === 'train_s2') {
      body = (
        <>
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.trainS2 !== false} onChange={e => setField('trainS2', e.target.checked)} />
            {tr('Enable S2 (SoVITS) fine-tuning', '启用 S2 (SoVITS) 微调')}
          </label>
          {form.trainS2 !== false
            ? <TrainParamFields form={form} setField={setField} part="s2" versionMode="multi" />
            : <p style={{ fontSize: 11, color: 'var(--muted)' }}>{tr('S2 (SoVITS) fine-tuning is turned off — this step will be skipped.', 'S2 (SoVITS) 微调已关闭：此步骤将被跳过。')}</p>}
        </>
      );
    } else if (selectedNode === 'preprocess') {
      body = (
        <>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>{tr('Extracts text tokens and audio features required for training.', '提取训练所需的文本 token 与音频特征。')}</p>
          <label className="toggle-row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={form.preprocessReview !== false && form.preprocessReview}
                   onChange={e => setField('preprocessReview', e.target.checked)} />
            {tr('Pause after ASR for manual proofreading', 'ASR 之后暂停以进行人工校对')}
          </label>
          <p className="field-hint" style={{ marginTop: 4 }}>
            {tr('When enabled the pipeline stops right after transcription so you can correct the recognised text and pronunciation before preprocessing/training continue.',
                '启用后，流程会在转写完成后立即停止，以便在继续预处理 / 训练之前修正识别出的文本和读音。')}
          </p>
        </>
      );
    } else if (selectedNode === 'finalize') {
      body = <p style={{ fontSize: 12, color: 'var(--muted)' }}>{tr('Packages the trained checkpoints and reference audio into a voice asset. No configuration needed.', '将训练好的 checkpoint 与参考音频打包成一个音色资源。无需配置。')}</p>;
    } else if (selectedNode === 'promote') {
      body = (
        <>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>{tr(
            <>Publishes the finished voice into <code>assets/</code> so it becomes selectable on the Generate page.</>,
            <>将完成的音色发布到 <code>assets/</code>，使其可在 Generate 页面中选择。</>)}</p>
          <label className="toggle-row">
            <input type="checkbox" checked={!!form.keepStaging}
                   onChange={e => setField('keepStaging', e.target.checked)} />
            {tr('Keep task workspace after publish', '发布后保留任务工作区')}
          </label>
          <p className="msg msg-warn" style={{ marginTop: 4, color: 'var(--warning)' }}>
            {tr(
              <>By default this task&rsquo;s staging workspace (<code>.staging/&lt;taskId&gt;</code> — the
              intermediate preprocessing features and checkpoints) is <strong>permanently deleted</strong> once
              the voice is published, since the finished asset no longer needs it. Enable this only when you
              want to <strong>keep</strong> those intermediates for inspection or debugging. It will
              count against your disk space.</>,
              <>默认情况下，本任务的暂存工作区（<code>.staging/&lt;taskId&gt;</code>，内含中间预处理特征与 checkpoint）
              会在音色发布后被<strong>永久删除</strong>，因为完成的资源已不再需要它。只有想<strong>保留</strong>
              这些中间产物用于检查或调试时才开启。它会占用磁盘空间。</>)}
          </p>
          <p className="field-hint">
            {tr(
              <>The retained workspace is <strong>never</strong> reused by later tasks — it lives only so you
              can inspect it. Delete it later from the Train page&rsquo;s cache manager when you no longer need it.</>,
              <>保留的工作区<strong>绝不会</strong>被后续任务复用：仅供检查之用。不再需要时，可在 Train 页面的缓存管理器中删除。</>)}
          </p>
        </>
      );
    }
    return (
      <div className="node-detail">
        <div className="node-detail-hdr">
          <span className="node-detail-title">{NODE_LABELS[selectedNode]}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {stBadge}
            <button className="btn btn-sm" onClick={() => setSelectedNode(null)}>{tr('Close', '关闭')}</button>
          </div>
        </div>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
          {body}
        </fieldset>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="section">
        <div className="section-hdr"><h2>Train New Voice</h2></div>
        <div className="section-body">
          {/* Recover a failed run — default-collapsed list of cached failed/interrupted
              tasks. "Resume" restores the pipeline and continues from the failure point. */}
          {!taskId && (
            <div className="recover-panel">
              <button type="button" className="recover-toggle" onClick={() => { const n = !recoverOpen; setRecoverOpen(n); if (n) loadRecoverable(); }}>
                <span className="recover-caret">{recoverOpen ? '▾' : '▸'}</span>
                {tr('Recover a failed run', '恢复失败的任务')}
                {recoverList.length > 0 && <span className="recover-count">{recoverList.length}</span>}
              </button>
              {recoverOpen && (
                <div className="recover-body">
                  {recoverLoading && <p className="field-hint">{tr('Loading…', '加载中…')}</p>}
                  {!recoverLoading && recoverList.length === 0 && (
                    <p className="field-hint">{tr('No failed or interrupted tasks in the cache. Everything is clean.', '缓存中没有失败或中断的任务。一切正常。')}</p>
                  )}
                  {!recoverLoading && recoverList.length > 0 && (
                    <table className="recover-table">
                      <thead>
                        <tr><th>{tr('Voice', '音色')}</th><th>{tr('Lang', '语言')}</th><th>{tr('Failed at', '失败于')}</th><th>{tr('Reason', '原因')}</th><th>{tr('When', '时间')}</th><th></th></tr>
                      </thead>
                      <tbody>
                        {recoverList.map(t => (
                          <tr key={t.id} className={recovery && recovery.sourceTaskId === t.id ? 'recover-row-active' : ''}>
                            <td>{t.voiceId || <span className="field-hint">—</span>}</td>
                            <td>{t.language || '—'}</td>
                            <td>
                              <span className="badge badge-danger">{FSTEP_LABELS[t.resumeStep] || t.resumeStep || t.status}</span>
                            </td>
                            <td className="recover-reason" title={t.failedAt && t.failedAt.reason || ''}>
                              {(t.failedAt && t.failedAt.reason) || (t.status === 'interrupted' ? tr('Interrupted', '已中断') : tr('Unknown', '未知'))}
                            </td>
                            <td className="recover-when">{t.updatedAt ? new Date(t.updatedAt).toLocaleString() : '—'}</td>
                            <td>
                              <button className="btn btn-sm btn-primary" onClick={() => beginResume(t)}
                                disabled={recovery && recovery.sourceTaskId === t.id}>
                                {recovery && recovery.sourceTaskId === t.id ? tr('Selected', '已选择') : tr('Resume', '恢复')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="field-hint" style={{ marginTop: 6 }}>
                    {tr('Only failed / interrupted tasks appear here. Successful runs are cleaned up automatically after publishing.',
                        '这里只显示失败 / 中断的任务。成功的运行在发布后会被自动清理。')}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Essentials — one horizontal row so the page reads wide, not narrow */}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            <div className="essentials-grid">
              <div className="field">
                <label className="field-label">{tr('Display Name', '显示名称')} *</label>
                <input className="control" value={form.voiceName} onChange={e => setField('voiceName', e.target.value)} placeholder={tr('e.g. MyVoice', '例如：MyVoice')} />
                {displayName && (
                  <p className="field-hint">
                    {tr('Proposed ID:', '建议 ID：')} <code>{proposedId || '…'}</code>
                    <span className="field-note"> {tr('(finalized at creation — may differ)', '（在创建时最终确定，可能与此不同）')}</span>
                    {dupDisplay.length > 0 && (
                      <><br/><span className="pf-warn">{tr(
                        `ⓘ ${dupDisplay.length} existing voice${dupDisplay.length > 1 ? 's' : ''} already use this display name (id${dupDisplay.length > 1 ? 's' : ''}: ${dupDisplay.map(v => v.id).join(', ')}). A new distinct voice will be created.`,
                        `ⓘ 已有 ${dupDisplay.length} 个音色在使用该显示名称（id：${dupDisplay.map(v => v.id).join(', ')}）。将创建一个新的、独立的音色。`)}</span></>
                    )}
                  </p>
                )}
              </div>
              <div className="field">
                <label className="field-label">{tr('Language', '语言')} *</label>
                <Select className="control" value={form.language} onChange={e => setField('language', e.target.value)}>
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </Select>
              </div>
              <div className="field">
                <label className="field-label">{tr('Audio Folder Path', '音频文件夹路径')} *</label>
                <input className="control" value={form.inputDir} onChange={e => setField('inputDir', e.target.value)} placeholder={tr('e.g. D:\\raw_audio\\MyVoice', '例如：D:\\raw_audio\\MyVoice')} />
                <p className="field-hint">{tr('ⓘ Folder path only — point to a folder of audio files. If you have a single audio file, put it inside a folder first, then select that folder.',
                  'ⓘ 仅填文件夹路径：指向一个存放音频文件的文件夹。如果只有单个音频文件，请先把它放进一个文件夹，再选择该文件夹。')}</p>
              </div>
            </div>

            {/* Training Preset — built-in presets + your own saved snapshots. Custom
                lets you edit any parameter in the pipeline steps below; "Save as preset"
                snapshots the current values into a named, reusable preset you can then
                update or delete. Frontend-only: presets just fill existing form.* fields. */}
            <div className="preset-grid preset-grid-single">
              <div className="field">
                <label className="field-label">{tr('Training Preset', '训练预设')}</label>
                {(() => {
                  const curTP = form.preset || 'default';
                  const isSavedTP = curTP.startsWith('saved:');
                  const savedTPName = isSavedTP ? curTP.slice(6) : null;
                  const savedTP = (form.trainSavedPresets || []);
                  const canSnapshot = curTP === 'custom' || isSavedTP;
                  return (<>
                    <Select className="control" value={curTP} onChange={e => applyPreset(e.target.value)}>
                      {TRAIN_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                      {savedTP.length > 0 && (
                        <optgroup label={tr('Saved presets', '已保存预设')}>
                          {savedTP.map(s => <option key={`saved:${s.name}`} value={`saved:${s.name}`}>{tr('Saved', '已存')}: {s.name}</option>)}
                        </optgroup>
                      )}
                    </Select>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                      {canSnapshot && (
                        <button type="button" className="btn btn-sm" onClick={() => setTrainPresetNameOpen(true)}>
                          {isSavedTP ? tr('Save as new preset', '另存为新预设') : tr('Save as preset', '保存为预设')}
                        </button>
                      )}
                      {isSavedTP && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={updateTrainPreset}>{tr('Update preset', '更新预设')}</button>
                      )}
                      {isSavedTP && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={deleteTrainPreset}>{tr('Delete preset', '删除预设')}</button>
                      )}
                    </div>
                    <p className="field-hint">{(() => {
                      if (isSavedTP) return tr(`Saved preset “${savedTPName}”. Edit any parameter below, then Update to save your changes back to it.`,
                        `已保存预设“${savedTPName}”。可在下方修改任意参数，然后点“更新预设”把改动写回该预设。`);
                      const p = TRAIN_PRESETS.find(p => p.key === curTP) || {};
                      return tr(p.hint, p.hintZh);
                    })()}</p>
                  </>);
                })()}
                <p className="field-note">{tr('S1 adapts semantic rhythm and prosody and may overfit earlier on small datasets. S2 receives more training epochs for acoustic and timbre adaptation.',
                  'S1 学习语义层面的节奏与韵律，在小数据集上更容易过拟合。S2 使用更多训练 epoch 来适配音质与音色。')}</p>
                <p className="field-note">{tr('More training does not always produce better results. Keep earlier checkpoints and compare them before choosing a model.',
                  '训练更久不一定效果更好。请保留较早的 checkpoint，先对比再决定用哪个模型。')}</p>
              </div>
            </div>
          </fieldset>

          {/* Recovery banner — Continue (in place) vs Modify (fork → new task) */}
          {recovery && (
            <div className={`resume-banner ${recoveryMode === 'modify' ? 'resume-banner-fork' : 'resume-banner-continue'}`}>
              <div className="resume-banner-hdr">
                <span className="resume-banner-title">
                  {recoveryMode === 'modify' ? tr('↳ Resume as a NEW task (fork)', '↳ 作为新任务恢复（分叉）') : tr('↻ Resume in place', '↻ 原地恢复')}
                </span>
                <button className="btn btn-sm btn-ghost" onClick={cancelRecovery}>{tr('Exit resume', '退出恢复')}</button>
              </div>
              <p className="resume-banner-body">
                {recoveryMode === 'modify'
                  ? <>{forkByParamChange
                        ? tr(
                          <>You changed <strong>{FSTEP_LABELS[earliestChangedStep]}</strong> settings. That step runs <strong>before</strong> the failure point,
                           so its output must be regenerated — an in-place resume would reuse the old cache and silently ignore your change.
                           This therefore launches a <strong>brand-new task</strong> (fork) and re-runs from <strong>{FSTEP_LABELS[rerunStart]}</strong>.</>,
                          <>已修改 <strong>{FSTEP_LABELS[earliestChangedStep]}</strong> 的设置。该步骤在失败点<strong>之前</strong>运行，
                           因此它的输出必须重新生成：原地恢复会复用旧缓存并忽略该修改。
                           所以这里会启动一个<strong>全新任务</strong>（分叉），并从 <strong>{FSTEP_LABELS[rerunStart]}</strong> 重新运行。</>)
                        : tr(
                          <>You moved the restart point to an earlier, already-completed step (<strong>{FSTEP_LABELS[rerunStart]}</strong>).
                           Changing a completed step means it must be re-run, so this launches a <strong>brand-new task</strong> (fork).</>,
                          <>重启点已移到一个更早、已完成的步骤（<strong>{FSTEP_LABELS[rerunStart]}</strong>）。
                           修改已完成的步骤意味着必须重新运行，因此这里会启动一个<strong>全新任务</strong>（分叉）。</>)}
                     {' '}{tr(
                       <>Only the products of steps <strong>before {FSTEP_LABELS[rerunStart]}</strong> are copied to the new task — so make sure you have enough <strong>disk space</strong> for them.
                       The original failed task is kept untouched, and even if this fork succeeds it will publish as a NEW task, not a recovery of the old one.</>,
                       <>只有 <strong>{FSTEP_LABELS[rerunStart]} 之前</strong>步骤的产物会被复制到新任务，所以请确保有足够的<strong>磁盘空间</strong>。
                       原来的失败任务保持不变，即使这个分叉成功，它也会作为一个新任务发布，而不是对旧任务的恢复。</>)}</>
                  : tr(
                    <>Continuing failed task <code>{recovery.sourceTaskId}</code> from the <strong>{FSTEP_LABELS[recovery.failedStep]}</strong> step,
                     reusing everything before it. Same task, same workspace.
                     {recovery.failedAt && recovery.failedAt.reason && <><br/><span className="resume-reason">Why it failed: {recovery.failedAt.reason}</span></>}</>,
                    <>从 <strong>{FSTEP_LABELS[recovery.failedStep]}</strong> 步骤继续失败任务 <code>{recovery.sourceTaskId}</code>，
                     复用它之前的所有产物。同一任务，同一工作区。
                     {recovery.failedAt && recovery.failedAt.reason && <><br/><span className="resume-reason">失败原因：{recovery.failedAt.reason}</span></>}</>)}
              </p>
              <div className="resume-controls">
                <label className="field-label" style={{ margin: 0 }}>{tr('Restart from', '从此处重启')}</label>
                <Select className="control control-inline" value={rerunStart}
                        onChange={e => setRecovery(r => ({ ...r, resumeStep: e.target.value }))}>
                  {resumeStepOptions.map(s => (
                    <option key={s} value={s}>{FSTEP_LABELS[s]}{s === recovery.failedStep ? tr(' (failed step)', '（失败的步骤）') : tr(' (redo completed step)', '（重做已完成的步骤）')}</option>
                  ))}
                </Select>
                {recoveryMode === 'continue' && failedIsTrain && (
                  <label className="toggle-row" style={{ margin: 0 }}>
                    <input type="checkbox" checked={restartFailedStep} onChange={e => setRestartFailedStep(e.target.checked)} />
                    {tr('Restart this training from scratch (ignore saved checkpoint)', '从零重新开始本次训练（忽略已保存的 checkpoint）')}
                  </label>
                )}
              </div>
            </div>
          )}

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
          <div className="preflight">
            <div className="pf-row">
              <span className="pf-key">{tr('Output', '输出')}</span>
              <span className="pf-val pf-path">{proposedId ? `assets/${proposedId}/` : 'assets/<auto-id>/'}</span>
              <span className="field-note">{tr('ⓘ ID allocated by the server at creation', 'ⓘ ID 由服务器在创建时分配')}</span>
            </div>
            <div className="pf-row">
              <span className="pf-key">{tr('Tune', '微调')}</span>
              <span className="pf-chips">
                {form.trainS1 !== false && (
                  <span className="pf-chip">GPT (S1) · {form.gptEpochs ?? 8}ep · save every {form.s1SaveEvery ?? 4}ep</span>
                )}
                {form.trainS2 !== false && _selVersions.map(v => (
                  <span key={v} className="pf-chip">SoVITS {v} · {form.sovitsEpochs ?? 25}ep · save every {form.s2SaveEvery ?? 5}ep</span>
                ))}
                {form.trainS1 === false && form.trainS2 === false && (
                  <span className="pf-chip pf-chip-off">{tr('none (safe pass)', '无（安全跳过）')}</span>
                )}
                {(form.trainS1 !== false || form.trainS2 !== false) && (
                  <span className="pf-chip pf-chip-meta">batch {form.batchSize || 'auto'}</span>
                )}
              </span>
            </div>
            <div className="pf-row">
              <span className="pf-key">{tr('Preprocess', '预处理')}</span>
              <span className="pf-chips">
                {form.denoise && <span className="pf-chip">Vocal Extract</span>}
                {form.slice && <span className="pf-chip">Slice</span>}
                {form.asr && <span className="pf-chip">ASR</span>}
                {!form.denoise && !form.slice && !form.asr && <span className="pf-chip pf-chip-off">{tr('none', '无')}</span>}
              </span>
            </div>
          </div>

          {/* Base-model gate feedback — reports EVERY selected SoVITS version (only when S2 will run).
              S1(GPT)/S2(SoVITS) enable toggles now live inside their pipeline nodes (like slice/ASR). */}
          {form.trainS2 !== false && baseModelStatus && Array.isArray(baseModelStatus.versions) &&
            baseModelStatus.versions.filter(v => !v.ok).map(v => (
              v.blocking
                ? <div key={v.version} className="msg msg-error" style={{ marginTop: 10 }}>
                    {tr(
                      <>⚠ Base models for <strong>{v.version}</strong> are missing ({(v.criticalMissing || []).join(' + ')}) — this
                      version is blocked (it would only produce electrical noise). Run:{' '}</>,
                      <>⚠ <strong>{v.version}</strong> 的底模缺失（{(v.criticalMissing || []).join(' + ')}）：该版本已被阻止
                      （否则只会产生电流噪声）。请运行：{' '}</>)}
                    <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
                  </div>
                : <div key={v.version} className="msg msg-warn" style={{ marginTop: 10 }}>
                    ⚠ <strong>{v.version}</strong>: {(v.missing || []).includes('sv')
                      ? tr('speaker-vector (SV) model missing — training will run but without SV enhancement', 'speaker-vector（SV）模型缺失，训练仍会进行，但没有 SV 增强')
                      : tr('a preferred base model is missing; training will fall back to a lower-quality base', '缺少一个更优的底模；训练将回退到质量较低的底模')}. {tr('Run:', '请运行：')}{' '}
                    <code>python download_models.py --set {String(v.version).toLowerCase()}</code>
                  </div>
            ))}
          {form.trainS1 === false && form.trainS2 === false && (
            <p className="msg msg-warn" style={{ marginTop: 10 }}>{tr('Neither S1 nor S2 is enabled (both pipeline steps off) — this run will only preprocess (slice / ASR) and publish reference audio.',
              'S1 和 S2 都未启用（两个流程步骤均已关闭）：本次运行只会做预处理（切片 / ASR）并发布参考音频。')}</p>
          )}

          {/* One-time low-VRAM (≤4GB) advisory. We never auto-shrink batch_size —
              the user decides; this only points them at the control. */}
          {showLowVram && (
            <div className="msg msg-warn" style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 10, background: 'rgba(255,193,7,0.12)', border: '1px solid rgba(255,193,7,0.35)' }}>
              <span style={{ fontSize: 16, lineHeight: 1.2 }}>⚠️</span>
              <div style={{ flex: 1, fontSize: 12.5 }}>
                检测到显存较小的 GPU（{cuda?.device_name || 'GPU'} · {cuda?.vram_gb}GB）。微调可能因显存不足（OOM）而失败，
                建议<strong>手动把 Batch Size 调小</strong>（如 1–2）后再开始。该提醒只显示一次。
              </div>
              <button className="btn btn-sm" onClick={dismissLowVram}>确认</button>
            </div>
          )}

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
        open={presetNameOpen}
        existingNames={(form.denoiseSavedPresets || []).map(s => s.name)}
        onSave={commitChainPreset}
        onClose={() => setPresetNameOpen(false)}
        example="my-vocal-chain"
      />
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
