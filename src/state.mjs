import fs from 'node:fs';
import path from 'node:path';

export class GrindError extends Error {}

export function grindDir(projectDir) {
  return path.join(projectDir, '.grind');
}

export function isInitialized(projectDir) {
  return fs.existsSync(path.join(grindDir(projectDir), 'config.json'));
}

// Walk upward so the hook works when claude was started in a subdirectory.
export function findProjectDir(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 30; i++) {
    if (isInitialized(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function defaultConfig() {
  return {
    planFile: 'PLAN.md',
    endstateFile: 'ENDSTATE.md',
    rails: {
      maxContinuationsPerSession: 25,
      maxSessionMinutes: 240
    },
    classifier: {
      useLlm: true,
      model: 'haiku',
      timeoutMs: 60000
    },
    judge: {
      model: 'haiku',
      timeoutMs: 120000,
      votes: 1
    },
    hook: {
      fastGateBudgetMs: 90000
    },
    stall: {
      enabled: true,
      noChangeThreshold: 3
    }
  };
}

export function loadConfig(projectDir) {
  const p = path.join(grindDir(projectDir), 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new GrindError(`cannot read ${p}: ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new GrindError(`invalid JSON in ${p}: ${e.message}`);
  }
  const d = defaultConfig();
  return {
    ...d,
    ...cfg,
    rails: { ...d.rails, ...cfg.rails },
    classifier: { ...d.classifier, ...cfg.classifier },
    judge: { ...d.judge, ...cfg.judge },
    hook: { ...d.hook, ...cfg.hook },
    stall: { ...d.stall, ...cfg.stall }
  };
}

const MAX_SESSIONS_KEPT = 20;

export function loadState(projectDir) {
  const p = path.join(grindDir(projectDir), 'state.json');
  if (!fs.existsSync(p)) return { sessions: {} };
  try {
    const state = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!state.sessions || typeof state.sessions !== 'object') return { sessions: {} };
    return state;
  } catch (e) {
    // preserve the bad file as evidence, start fresh, and say so in the log
    const quarantine = p + '.corrupt-' + Date.now();
    try { fs.renameSync(p, quarantine); } catch {}
    log(projectDir, { event: 'state-corrupt', error: e.message, quarantine });
    return { sessions: {} };
  }
}

export function saveState(projectDir, state) {
  const ids = Object.keys(state.sessions);
  if (ids.length > MAX_SESSIONS_KEPT) {
    ids.sort((a, b) => (state.sessions[a].lastStopAt ?? 0) - (state.sessions[b].lastStopAt ?? 0));
    for (const id of ids.slice(0, ids.length - MAX_SESSIONS_KEPT)) delete state.sessions[id];
  }
  const p = path.join(grindDir(projectDir), 'state.json');
  // pid-unique tmp file: two sessions on one project fire concurrent Stop hooks,
  // and a shared tmp path lets one rename the other's half-written file
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (e) {
      lastErr = e;
      sleepMs(25 * (i + 1)); // Windows EPERM under concurrent rename usually clears in ms
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw lastErr;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const OFF_FLAG = 'OFF';

export function isOff(projectDir) {
  return fs.existsSync(path.join(grindDir(projectDir), OFF_FLAG));
}

export function setOff(projectDir, off) {
  const p = path.join(grindDir(projectDir), OFF_FLAG);
  if (off) {
    fs.writeFileSync(p, 'grind is paused; delete this file or run "grind on" to resume\n');
  } else if (fs.existsSync(p)) {
    fs.unlinkSync(p);
  }
}

export function log(projectDir, entry) {
  // logging must never break the hook
  try {
    const p = path.join(grindDir(projectDir), 'grind.log');
    try {
      if (fs.statSync(p).size > 5 * 1024 * 1024) fs.renameSync(p, p + '.1');
    } catch {}
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}
