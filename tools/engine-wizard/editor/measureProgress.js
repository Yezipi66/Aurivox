// 第 5 步试运行的进度文案：后台任务的阶段（core/measureJob.js 的 job.stage）→ 界面上的词。
//   单独一个文件，不依赖 React，测试直接 import。

export const MEASURE_STAGES = Object.freeze({
  starting: { en: 'Starting the engine', zh: '启动中' },
  synth: { en: 'Synthesizing', zh: '合成中' },
  done: { en: 'Done', zh: '完成' },
  failed: { en: 'Failed', zh: '失败' },
})

// 轮询间隔：阶段以秒计地变化，再密只是空转。
export const MEASURE_POLL_MS = 1000

export function measureStageLabel (stage, t) {
  const s = MEASURE_STAGES[stage] || MEASURE_STAGES.starting
  return t(s.en, s.zh)
}

// 已用时间：mm:ss，超过一小时带小时。
export function formatElapsed (ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

// 任务还进行中吗：没有任务、或者已经 done / failed ⇒ 停止轮询。
export function measureRunning (job) {
  return !!(job && job.state === 'running')
}
