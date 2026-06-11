import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const TAIL_CAP = 64 * 1024;

function keepTail(s) {
  return s.length > 2 * TAIL_CAP ? s.slice(-TAIL_CAP) : s;
}

export function tail(s, n) {
  return s.length > n ? s.slice(-n) : s;
}

export function indent(s, prefix) {
  return s.split('\n').map(l => prefix + l).join('\n');
}

export function killTree(pid) {
  if (pid == null) return;
  if (process.platform === 'win32') {
    // child.kill() orphans grandchildren on Windows; taskkill /T takes the whole tree
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

export function runCommand(command, { cwd, timeoutMs = 600000, env } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let timedOut = false;
    let settled = false;
    let timer, grace;
    const settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(result);
    };
    const onData = d => { out = keepTail(out + d.toString()); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // 'close' waits on the stdio pipes; a surviving grandchild holding them
      // open would hang the hook, so force-settle after a grace period
      grace = setTimeout(() => {
        try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
        settle({ code: null, out, timedOut: true, ms: Date.now() - started });
      }, 2000);
    }, timeoutMs);
    child.on('error', e => {
      settle({ code: null, out: out + `\n[spawn error: ${e.message}]`, timedOut, ms: Date.now() - started, error: e.message });
    });
    child.on('close', code => {
      settle({ code, out, timedOut, ms: Date.now() - started });
    });
  });
}

// Internal claude calls (judge/classifier) run from a neutral cwd so they never
// pick up the target project's settings/hooks, and carry GRIND_INTERNAL so the
// Stop hook ignores their sessions entirely — both guards prevent recursion.
export function callClaude({ prompt, model, timeoutMs = 120000, cwd, extraArgs = [] }) {
  return new Promise((resolve, reject) => {
    // shell:true joins args without quoting on Windows — args must stay space-free
    // (the prompt rides stdin for exactly this reason)
    const args = ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), ...extraArgs];
    const child = spawn('claude', args, {
      cwd: cwd ?? os.tmpdir(),
      shell: true,
      windowsHide: true,
      env: { ...process.env, GRIND_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    let timer, grace;
    const fail = e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      reject(e);
    };
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err = keepTail(err + d.toString()); });
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      grace = setTimeout(() => {
        try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
        fail(new Error(`claude call timed out after ${timeoutMs}ms (process tree did not exit cleanly)`));
      }, 2000);
    }, timeoutMs);
    child.on('error', e => {
      fail(new Error(`failed to spawn claude: ${e.message}`));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (timedOut) return reject(new Error(`claude call timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${tail(err || out, 400)}`));
      let j;
      try {
        j = JSON.parse(out);
      } catch {
        return reject(new Error(`claude output was not JSON: ${out.slice(0, 400)}`));
      }
      const text =
        typeof j.result === 'string' ? j.result
        : typeof j.result?.message === 'string' ? j.result.message
        : Array.isArray(j.result?.message?.content)
          ? j.result.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          : null;
      if (text == null) return reject(new Error(`unrecognized claude JSON shape: keys=${Object.keys(j).join(',')}`));
      resolve({ text, costUsd: j.total_cost_usd ?? null, raw: j });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
