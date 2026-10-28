// 异步 spawn：返回 Promise，resolve 时带 { status, stdout, stderr }。
// 子进程通过 options.onChild(proc) 同步交出，调用方可在 await 之前登记它以便取消。
// options：onStdout / onStderr 实时回调，signal 为 AbortSignal（abort 即杀进程）。
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
      // 进程被信号杀死时 code 为 null，换算成惯例退出码 128+signum，
      // 让上层错误信息里出现 "exit code 137"，供失败分类器识别 OOM
      // 让上层错误信息里出现 "exit code 137"，供失败分类器识别 OOM。
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
