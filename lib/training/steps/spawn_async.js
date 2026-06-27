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
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('killed'));
      resolve({ status: code, stdout, stderr });
    });
  });
}

module.exports = { spawnAsync };
