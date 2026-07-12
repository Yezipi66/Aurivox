/**
 * 异步 spawn 辅助函数
 *
 * Returns a Promise that resolves with { status, stdout, stderr }.
 * The spawned child process is handed back synchronously via options.onChild(proc)
 * so callers can register it for cancellation before await resolves.
 *
 * Options:
 *   onStdout(s)  — called with each chunk of stdout (real-time)
 *   onStderr(s)  — called with each chunk of stderr (real-time)
 *   signal       — AbortSignal, call .abort() to kill the process
 */
function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      timeout = 600000, windowsHide = true, onChild,
      onStdout, onStderr, signal,
      ...spawnOpts
    } = options;

    const cp = require('child_process');
    const proc = cp.spawn(command, args, {
      ...spawnOpts, windowsHide, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (typeof onChild === 'function') onChild(proc);

    let stdout = '', stderr = '', killed = false;

    proc.stdout.on('data', (d) => {
      const s = d.toString(); stdout += s;
      if (typeof onStdout === 'function') onStdout(s);
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString(); stderr += s;
      if (typeof onStderr === 'function') onStderr(s);
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      reject(new Error(`Process timed out after ${timeout}ms`));
    }, timeout);

    if (signal) {
      if (signal.aborted) { killed = true; proc.kill('SIGTERM'); }
      signal.addEventListener('abort', () => { killed = true; proc.kill('SIGTERM'); }, { once: true });
    }

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('killed'));
      // 若进程被信号杀死（典型：系统 OOM killer 发 SIGKILL），code 为 null。
      // 换算成惯例退出码 128+signum，让上层错误信息里出现 "exit code 137"，
      // 供失败分类器识别 OOM（见 pipeline.js classifyFailure）。
      let status = code;
      if (status === null && signal) {
        const SIGNUM = { SIGKILL: 9, SIGTERM: 15, SIGSEGV: 11, SIGABRT: 6, SIGINT: 2, SIGBUS: 7 };
        status = 128 + (SIGNUM[signal] || 0);
      }
      resolve({ status, signal: signal || null, stdout, stderr });
    });
  });
}

module.exports = { spawnAsync };
