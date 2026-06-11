#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { superviseStop } from '../src/supervisor.mjs';
import { validateProject } from '../src/validate.mjs';
import {
  GrindError,
  defaultConfig,
  findProjectDir,
  loadConfig,
  loadState,
  isOff,
  setOff,
  log
} from '../src/state.mjs';
import { parsePlan } from '../src/plan.mjs';
import { tail, indent } from '../src/proc.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'grind.mjs').replace(/\\/g, '/');
// Use the absolute node path: Claude Code's hook environment (native installer)
// may not have node on PATH. Quotes guard spaces; settings.json's own JSON
// encoding handles the backslashes.
const HOOK_COMMAND = `"${process.execPath}" "${BIN}" hook-stop`;

main().catch(e => {
  console.error(e instanceof GrindError ? `grind: ${e.message}` : e);
  process.exit(2);
});

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      return init(path.resolve(args[0] ?? process.cwd()));
    case 'hook-stop':
      return hookStop();
    case 'status':
      return status(requireProject());
    case 'on':
      setOff(requireProject(), false);
      console.log('grind: ON');
      return;
    case 'off':
      setOff(requireProject(), true);
      console.log('grind: OFF (the Stop hook will allow all stops until "grind on")');
      return;
    case 'validate':
      return validateCmd(requireProject());
    default:
      return help();
  }
}

function requireProject() {
  const dir = findProjectDir(process.cwd());
  if (!dir) throw new GrindError('no .grind/config.json found here or in any parent directory — run "grind init <project>" first');
  return dir;
}

function help() {
  console.log(`grind — supervisor loop for Claude Code: re-prompts premature stops until the plan is done and the end state validates.

Usage: node ${BIN} <command>

Commands:
  init [dir]   set up grind in a project: .grind/, ENDSTATE.md, PLAN.md, Stop hook
  status       show plan progress, session continuations, recent decisions
  validate     run full validation (all verify: gates + judge: criteria) against ENDSTATE.md
  off | on     pause / resume grinding (Stop hook allows all stops while off)
  hook-stop    (internal) Stop hook entry point — wired by init, reads hook JSON on stdin`);
}

function manualSnippet() {
  return JSON.stringify(
    { hooks: { Stop: [{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 300 }] }] } },
    null,
    2
  );
}

function wireHook(targetDir) {
  const dir = path.join(targetDir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'settings.json');
  let settings = {};
  let backedUp = false;
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      throw new GrindError(`${p} is not valid JSON (${e.message}) — fix it or add the hook manually:\n${manualSnippet()}`);
    }
    fs.copyFileSync(p, p + '.grind-backup');
    backedUp = true;
  }
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  if (!Array.isArray(settings.hooks.Stop)) {
    throw new GrindError(`hooks.Stop in ${p} is not an array — fix it or add the hook manually:\n${manualSnippet()}`);
  }
  const already = JSON.stringify(settings.hooks.Stop).includes('hook-stop');
  if (!already) {
    // timeout is in seconds per the hooks reference
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 300 }] });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  }
  return { wired: !already, backedUp };
}

function init(target) {
  if (!fs.existsSync(target)) throw new GrindError(`target directory does not exist: ${target}`);
  const gdir = path.join(target, '.grind');
  fs.mkdirSync(gdir, { recursive: true });

  const cfgPath = path.join(gdir, 'config.json');
  const wroteCfg = !fs.existsSync(cfgPath);
  if (wroteCfg) fs.writeFileSync(cfgPath, JSON.stringify(defaultConfig(), null, 2) + '\n');

  const copies = [];
  for (const f of ['ENDSTATE.md', 'PLAN.md']) {
    const dst = path.join(target, f);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(ROOT, 'templates', f), dst);
      copies.push(f);
    }
  }

  const { wired, backedUp } = wireHook(target);

  console.log(`grind initialized in ${target}`);
  console.log(`- .grind/config.json ${wroteCfg ? 'created' : 'already existed (kept)'}`);
  for (const f of copies) console.log(`- ${f} created from template — EDIT THIS before relying on grind`);
  console.log(`- Stop hook ${wired ? 'wired into' : 'already present in'} .claude/settings.json${backedUp ? ' (previous file backed up as settings.json.grind-backup)' : ''}`);
  console.log(`
WARNING: grind multiplies token usage by design — every blocked stop starts
another full agent turn (up to ${defaultConfig().rails.maxContinuationsPerSession}/session by default). Watch your first
sessions; press Esc to interrupt the agent manually, then "grind off" to
disengage. Lower the rails in .grind/config.json to start cautious.

Next steps:
1. Edit ENDSTATE.md: the narrative defines scope, the checklist defines done (verify:/judge: tags).
2. Keep PLAN.md as the live multi-phase plan — Claude checks items off as it works.
3. Add this line to the project's CLAUDE.md:
   If you are genuinely blocked, start a line with "BLOCKED:" stating exactly what you need.
4. Start Claude Code from the project root. grind now answers premature stops automatically.

Escape hatches: "grind off", create .grind/OFF, or remove the Stop hook entry from .claude/settings.json.`);
}

async function readStdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

async function hookStop() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // unreadable hook input → allow the stop
  }
  let decision;
  try {
    decision = await superviseStop(input);
  } catch (e) {
    try {
      const dir = findProjectDir(input.cwd ?? process.cwd());
      if (dir) log(dir, { event: 'hook-error', error: String(e?.stack ?? e) });
    } catch {}
    decision = { allow: true, systemMessage: `grind: hook error — allowing stop (${e?.message ?? e})` };
  }
  const out = decision.allow
    ? decision.systemMessage
      ? { systemMessage: decision.systemMessage }
      : {}
    : { decision: 'block', reason: decision.reason };
  await new Promise(r => process.stdout.write(JSON.stringify(out) + '\n', r));
  process.exit(0);
}

function status(projectDir) {
  const config = loadConfig(projectDir);
  console.log(`grind status — ${projectDir}`);
  console.log(`mode: ${isOff(projectDir) ? 'OFF' : 'ON'}`);
  const planPath = path.join(projectDir, config.planFile);
  if (fs.existsSync(planPath)) {
    const plan = parsePlan(fs.readFileSync(planPath, 'utf8'));
    const done = plan.items.filter(i => i.checked).length;
    console.log(`plan: ${done}/${plan.items.length} items checked (${config.planFile})`);
  } else {
    console.log(`plan: ${config.planFile} NOT FOUND`);
  }
  const state = loadState(projectDir);
  const sessions = Object.entries(state.sessions)
    .sort((a, b) => (b[1].lastStopAt ?? 0) - (a[1].lastStopAt ?? 0))
    .slice(0, 5);
  for (const [id, s] of sessions) {
    console.log(
      `session ${id.slice(0, 8)}: ${s.continuations} continuation(s), last verdict ${s.lastVerdict ?? '-'}${s.lastStopAt ? ` at ${new Date(s.lastStopAt).toLocaleString()}` : ''}`
    );
  }
  const logPath = path.join(projectDir, '.grind', 'grind.log');
  if (fs.existsSync(logPath)) {
    console.log('\nrecent log:');
    for (const l of fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-5)) console.log('  ' + l);
  }
}

async function validateCmd(projectDir) {
  console.log(`grind validate — ${projectDir}\n`);
  const { results, ok } = await validateProject(projectDir, { onProgress: m => console.log(`  running ${m} ...`) });
  console.log('');
  for (const r of results) {
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] (${r.kind}) ${r.criterion.text}${r.detail ? ` — ${r.detail}` : ''}`);
    if (!r.ok && r.kind === 'verify' && r.output) console.log(indent(tail(r.output, 1200), '       '));
    if (!r.ok && r.evidence) console.log(`       evidence: ${r.evidence}`);
    if (!r.ok && r.suggestedFix) console.log(`       suggested fix: ${r.suggestedFix}`);
  }
  const cost = results.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} criteria pass${cost ? ` — judge cost ~$${cost.toFixed(4)}` : ''}`);
  process.exit(ok ? 0 : 1);
}
