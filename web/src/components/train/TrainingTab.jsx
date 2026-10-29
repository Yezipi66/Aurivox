// 训练页：训练参数表单、管线门控、失败任务恢复与训练状态。
// 表单状态存在本地（usePersistentState），训练进度由 /api/train/status 轮询。
// 恢复流程分两种：原地续跑（Continue）与改参分叉（Modify），由用户改动的步骤决定。
import { useState, useEffect, useRef, useCallback } from 'react'
import { usePersistentState } from '../../usePersistentState'
import { api } from '../../lib/api'
import { ConfirmDialog } from '../common/Dialogs'
import { IconTrash } from '../common/Icons'
import { useT } from '../../lib/i18n'
import {
  REBUILD_PARAM_DEFAULTS,
  FSTEP_ORDER,
  LANGUAGES,
  TRAIN_PRESETS,
  pickTrainFields,
  SLICE_PRESET_VALUES,
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
import { PresetNameModal, ConfirmModal, RestoreModal } from './trainModals'
import { NodeDetailPanel } from './NodeDetailPanel'
import { RecoveryBanner } from './RecoveryBanner'
import { RecoverableTasksPanel } from './RecoverableTasksPanel'
import { PreflightSummary } from './PreflightSummary'
import { EssentialsFields } from './EssentialsFields'
import { TrainingPresetPicker } from './TrainingPresetPicker'
import { TrainingStatusPanel } from './TrainingStatusPanel'
import { TrainingGates } from './TrainingGates'

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
    // 高级参数
    gptEpochs: 8, sovitsEpochs: 25, batchSize: 'auto', learningRate: 'default',
    sliceMinSec: 3, sliceMaxSec: 15, sliceSilenceDb: -40, sliceMinSilenceSec: 0.5,
    asrEngine: 'auto', denoiseModel: 'mdx-net',
    denoisePreset: 'bgm', denoisePipeline: [], denoisePresetParams: {}, denoiseAdvUnlocked: false, denoiseSavedPresets: [],
    asrModelSize: 'large-v3-turbo', asrPrecision: 'float16',
    modelVersion: 'v2Pro', modelVersions: ['v2Pro'], isHalf: true, inferDevice: 'cuda',
    // S1 高级参数
    s1Seed: 1234, s1SaveEvery: 4, s2SaveEvery: 5, s1Precision: '16-mixed', s1GradClip: 1.0,
    s1Lr: 0.01, s1LrInit: 0.00001, s1LrEnd: 0.0001, s1Warmup: 2000, s1Decay: 40000,
    s1MaxSec: 54, s1NumWorkers: 4, s1MaxEval: 8,
    // S2 高级参数
    s2Seed: 1234, s2LogInterval: 100, s2EvalInterval: 500, s2Fp16: true,
    s2LrDecay: 0.999875, s2SegmentSize: 20480, s2CMel: 45, s2CKl: 1.0,
    s2TextLowLr: 0.4, s2GradCkpt: false,
  });
  const [localTaskId, setLocalTaskId] = useState(null);
  const [status, setStatus] = useState(null);
  // 所选训练版本的底模是否齐备（决定门控提醒）。
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
  // 人声提取权重的可用情况，由 VocalExtractionPanel 汇报（它负责 UVR5 目录拉取与下载任务）。
  // 当前启用的人声管线还缺权重时，下面的主按钮换成「下载模型」。
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
  const [selectedNode, setSelectedNode] = useState(null); // 管线图上正在配置或查看的步骤
  // 高级参数：common 档（temperature、topK、topP、repPenalty、splitMethod、
  // speedFactor、seed）与 advanced 档分两组。
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
  // 目标音色 id 已存在时的覆盖确认（服务端返回 409）。
  const [overwriteConfirm, setOverwriteConfirm] = useState(null); // { existingId, existingDisplay }

  // GPU 预检（只提示，不自动改参数）：没有 NVIDIA GPU 时拦住启动，要用户显式确认，
  // 因为 CPU 微调极慢且 UVR5 不可用。显存不足 4G 的卡仍可训练，只是有 OOM 风险，
  // 所以只提醒一次（记在持久化状态里），不反复弹。
  const cuda = health?.cuda; // { available, device_name, vram_gb }，health 加载前为 undefined
  const [noGpuConfirm, setNoGpuConfirm] = useState(false);
  const [noGpuAck, setNoGpuAck] = useState(false);
  // 管线门控：
  // G1：未开启 S1/S2 时 preprocess 三步无意义，确认后跳过 preprocess。
  // G2：开启训练却未勾 ASR 时没有转写会报错，但用户可能自备 .list：强提醒不阻断，
  //     并给一段 preprocess 前的宽限期（默认 30 秒）让用户投放 .list / segments.json。
  const [gate, setGate] = useState(null);  // null | { type:'g1'|'g2' }
  const [gateGraceSec, setGateGraceSec] = useState(30);
  // 门控放行标记与本次放行携带的覆盖项（preprocess 关 / 宽限期秒数）。
  const gateAckRef = useRef({ g1: false, g2: false, preprocessOff: false, graceSec: 30 });
  // FunASR 语言告知门：仅当选了 FunASR 但语言非中文或粤语时提醒（只告知，不阻断）。
  const [asrLangGate, setAsrLangGate] = useState(null);  // null | { lang }
  const asrLangAckRef = useRef(false);
  const [lowVramWarned, setLowVramWarned] = usePersistentState('train.lowVramWarned', false);
  const [showLowVram, setShowLowVram] = useState(false);
  useEffect(() => {
    // 只对确实存在的 4G 及以下 CUDA 卡触发这次一次性提醒。
    if (cuda?.ready && cuda.available && typeof cuda.vram_gb === 'number' && cuda.vram_gb <= 4 && !lowVramWarned) {
      setShowLowVram(true);
    }
  }, [cuda?.available, cuda?.vram_gb, lowVramWarned]);
  const dismissLowVram = () => { setShowLowVram(false); setLowVramWarned(true); };

  // 失败任务恢复：缓存里失败或中断的任务可以续跑，面板默认折叠。
  const [recoverList, setRecoverList] = useState([]);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverLoading, setRecoverLoading] = useState(false);
  // 用户点「Resume」之后的恢复上下文。
  //   { sourceTaskId, failedStep, resumeStep, steps, hasInputDir }
  const [recovery, setRecovery] = useState(null);
  // 续跑开始时记下的步骤参数基线；实时表单与它对比，
  // 上游参数一改就把重跑起点往前拉（变成分叉）。
  const paramSnapshotRef = useRef(null);
  const [restartFailedStep, setRestartFailedStep] = useState(false);

  const loadRecoverable = () => {
    setRecoverLoading(true);
    api('/api/train/recoverable')
      .then(r => { if (r.ok) setRecoverList(r.data.tasks || []); })
      .catch(() => {})
      .finally(() => setRecoverLoading(false));
  };
  // 页面空闲（没有进行中的任务）时拉一次列表，保持新鲜。
  useEffect(() => { if (!activeTaskId && !localTaskId) loadRecoverable(); }, [activeTaskId, localTaskId]);

  // 用 props 中的 activeTaskId，但 handleStart 之后也写一份本地（启动时用）
  const taskId = activeTaskId || localTaskId;
  const isAwaitingReview = status?.status === 'awaiting_review';
  const isRunning = status?.status === 'running';
  const isFinished = status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status);
  const isInterrupted = status?.status === 'interrupted';

  // 由训练预设独占的字段：手动改过其中任何一个，当前取值就不再等于那个预设，
  // 于是把预设名改成「Custom」。
  const PRESET_KEYS = ['gptEpochs', 'sovitsEpochs', 'batchSize', 's1SaveEvery', 's2SaveEvery', 's2GradCkpt', 's2Fp16'];

  const setField = (key, val) => setForm(prev => {
    const next = { ...prev, [key]: val };
    if (PRESET_KEYS.includes(key) && prev.preset && prev.preset !== 'custom') {
      next.preset = 'custom';
    }
    return next;
  });

  // 消费资产页「重建」动作递过来的一次性预填：填入输入目录与音色名，
  // 然后清掉信号，让它只生效一次。
  useEffect(() => {
    if (!trainPrefill) return;
    setForm(prev => ({ ...prev, ...trainPrefill }));
    if (setTrainPrefill) setTrainPrefill(null);
  }, [trainPrefill]);

  // 切片预设：一次性填好四个切片字段（或关掉切片）。
  const applySlicePreset = (name) => {
    if (name === 'none') { setField('slice', false); return; }
    const p = SLICE_PRESET_VALUES[name];
    if (p) setForm(prev => ({ ...prev, slice: true, ...p }));
  };

  // 训练预设：一次性覆盖训练字段。既支持内置预设，也支持用户保存的快照（saved:<name>）。
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

  // 不可逆的预设删除要二级确认，这里暂存待执行的动作。
  const [confirmState, setConfirmState] = useState(null);
  const askConfirm = (opts) => setConfirmState(opts);
  const closeConfirm = () => setConfirmState(null);

  // 训练预设的保存与管理（与人声链路的预设并列）。
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

  // 「Restoring training state…」超时兜底：10 秒后仍无 status 则回退表单
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
    // 同名音色的保护：服务端在没有显式覆盖时拒绝启动，
    // 这里弹确认框，并显示该 id 当前对应的显示名。
    if (!r.ok && r.status === 409 && r.data?.code === 'VOICE_EXISTS') {
      setOverwriteConfirm({ existingId: r.data.existingId, existingDisplay: r.data.existingDisplay });
      return;
    }
    if (!r.ok) throw new Error(r.data?.error || 'Failed to start training');
    setRecovery(null);
    paramSnapshotRef.current = null;
    setRestartFailedStep(false);
    setLocalTaskId(r.data.taskId);
    setActiveTaskId(r.data.taskId); // 写入持久化，并触发 App 层重连
    gateAckRef.current = { g1: false, g2: false, preprocessOff: false, graceSec: 30 }; // 重置门控，下次启动重新评估
  };

  const handleStart = async () => {
    // 恢复流程里，只有重跑起点是 denoise 或 slice 时才需要原始音频目录；
    // 起点更靠后的步骤直接用缓存里的产物。
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
    // GPU 预检：health 加载完成并报出没有 CUDA 设备时，拦住启动要用户显式确认，
    // 而不是默默跑一次 CPU 训练。
    // 只在明确为 false 时拦：health 还在加载时按未知放行，不拿未知状态当门控依据。
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

  // 用户确认无 GPU 警告后继续微调。
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

  // 进入恢复流程：把缓存里失败或中断的任务的原始参数填回表单，
  // 并把重跑起点钉在失败的那一步（Continue 模式）。
  const beginResume = (task) => {
    const patch = archiveToForm(task);
    setForm(prev => {
      const next = { ...prev, ...patch };
      // 把载入的参数记为检测改动用的基线。
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

  // 可选作重跑起点的上游步骤：失败那一步及其之前已完成的步骤。
  // 选到比失败步更早的位置就是 Modify（分叉）。
  const failedIdx = recovery ? FSTEP_ORDER.indexOf(recovery.failedStep) : -1;
  const resumeStepOptions = recovery
    ? FSTEP_ORDER.filter((s, i) => i <= failedIdx &&
        (s === recovery.failedStep || (recovery.steps[s] && recovery.steps[s].status === 'completed')))
    : [];
  // 检测续跑开始之后用户改过哪些步骤的参数。改的是上游步骤（在失败点之前、
  // 且可选择、已完成）时原地续跑用不上这个改动：它的缓存产物会被直接复用，
  // 改动被无声忽略。于是把重跑起点自动拉到最早被改动的上游步骤，
  // 这一步把本次运行变成分叉（新任务）并从那里重跑。
  const changedSteps = recovery ? changedStepSet(buildStepParams(form), paramSnapshotRef.current) : new Set();
  const earliestChangedStep = recovery
    ? (FSTEP_ORDER.find(s => changedSteps.has(s) && resumeStepOptions.includes(s)) || null)
    : null;
  const userResumeStep = recovery ? recovery.resumeStep : null;
  // 实际重跑起点取「用户选的步骤」与「最早被改动的步骤」里更早的那个。
  const rerunStart = recovery
    ? ((earliestChangedStep && FSTEP_ORDER.indexOf(earliestChangedStep) < FSTEP_ORDER.indexOf(userResumeStep))
        ? earliestChangedStep : userResumeStep)
    : null;
  const rerunIdx = recovery ? FSTEP_ORDER.indexOf(rerunStart) : -1;
  // 分叉是参数改动造成的（区别于用户手动把重跑起点往前拖）。
  const forkByParamChange = !!(recovery && earliestChangedStep && FSTEP_ORDER.indexOf(earliestChangedStep) < failedIdx
    && FSTEP_ORDER.indexOf(earliestChangedStep) <= rerunIdx);
  // Continue = 就在失败那一步重跑（原地，同一任务）。Modify =
  // 在更早的已完成步骤重跑（分叉，新任务；只复制上游产物）。
  const recoveryMode = recovery ? (rerunIdx < failedIdx ? 'modify' : 'continue') : null;
  const failedIsTrain = recovery && (recovery.failedStep === 'train_s1' || recovery.failedStep === 'train_s2');

  // 恢复运行要发给服务端的步骤开关：重跑起点之前的上游一律复用
  //（enabled=false，服务端标成 completed 并跳过）；从重跑起点到末尾照跑，
  // 可选步骤仍尊重用户自己的开关。
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

  const editable = !taskId; // 任务开始前输入框才可编辑

  // 表单里填的是显示名（允许中文等 Unicode）。规范化的 ASCII id 由服务端在创建任务时
  // 一次性分配。这里只拉一个「预览 id」用于显示：它明确不是保留名，最终 id 可能不同。
  // 显示名撞车绝不意味着覆盖：每个新音色都会拿到不同的 id。
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
  // 不阻断的提示：已有别的音色用了完全相同的显示名。
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
          {/* 恢复失败的任务：默认折叠，列出缓存里失败或中断的任务。
              点「Resume」恢复管线，从失败的那一步继续。 */}
          <RecoverableTasksPanel
            visible={!taskId}
            recoverOpen={recoverOpen}
            recoverList={recoverList}
            recoverLoading={recoverLoading}
            activeSourceTaskId={recovery && recovery.sourceTaskId}
            onToggle={() => { const n = !recoverOpen; setRecoverOpen(n); if (n) loadRecoverable(); }}
            onResume={beginResume}
          />

          {/* 基础字段：排成一行，让页面读起来是宽的而不是窄的 */}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
            <EssentialsFields
              form={form}
              setField={setField}
              proposedId={proposedId}
              dupDisplay={dupDisplay}
            />

            {/* 训练预设：内置预设与自己保存的快照。Custom 允许手动改下面管线各步的
                任一参数；「存为预设」把当前取值存成一个具名、可复用的预设，之后能改也能删。
                纯前端行为：预设只是填 form.* 里已有的字段。 */}
            <TrainingPresetPicker
              form={form}
              applyPreset={applyPreset}
              onSaveAsNew={() => setTrainPresetNameOpen(true)}
              onUpdate={updateTrainPreset}
              onDelete={deleteTrainPreset}
            />
          </fieldset>

          {/* 恢复横幅：Continue（原地续跑）与 Modify（分叉成新任务） */}
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

          {/* 管线图：点某一步可配置它（运行中可查看该步状态） */}
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

          {/* 预检摘要：反映 form.* 的实时取值（高级参数的改动也流到这里）。
              展示下拉框与管线图里看不到的那部分信息。 */}
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
                // 启用的人声管线还缺没装的权重。主按钮在这期间变成「下载模型」。
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
                title={tr('Delete finished task workspaces from the .staging cache (running tasks are never touched)', '从 .staging 缓存中删除已完成的任务工作区（运行中的任务不会被处理）')}>
                {clearing ? tr('Cleaning…', '清理中…') : 'Clean Cache'}
              </button>
              {clearMsg && <span style={{ fontSize: 'var(--fs-12)', color: 'var(--muted)' }}>{clearMsg}</span>}
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

          <TrainingStatusPanel
            taskId={taskId}
            status={status}
            form={form}
            engineId={engine?.id}
            isRunning={isRunning}
            isAwaitingReview={isAwaitingReview}
            isInterrupted={isInterrupted}
            isFinished={isFinished}
            onCancel={handleCancel}
            onReset={handleReset}
            onResumed={() => setStatus(s => s ? { ...s, status: 'running' } : s)}
          />
        </div>
      </div>

      {/* 日志只在任务开始或结束后出现，空闲时页面保持干净 */}
      {taskId && <LiveLogs logs={logs} />}

      <TrainingGates
        gate={gate}
        gateGraceSec={gateGraceSec}
        setGateGraceSec={setGateGraceSec}
        onConfirmGate={confirmGate}
        onCancelGate={cancelGate}
        overwriteConfirm={overwriteConfirm}
        onCancelOverwrite={() => setOverwriteConfirm(null)}
        onConfirmOverwrite={confirmOverwriteTrain}
        noGpuConfirm={noGpuConfirm}
        noGpuAck={noGpuAck}
        setNoGpuAck={setNoGpuAck}
        onCancelNoGpu={() => setNoGpuConfirm(false)}
        onProceedWithoutGpu={proceedWithoutGpu}
      />

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
                <p style={{ fontSize: 'var(--fs-13)', margin: 0, color: 'var(--warning, #e0b341)', fontWeight: 500 }}>
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
  // 精修弹窗复用这些导出，好让它暴露与训练和恢复流程完全一样的训练参数字段、
  // 序列化方式与默认值。
  TrainParamFields,
  buildTrainingParams,
  REBUILD_PARAM_DEFAULTS,
  LANGUAGES,
}
