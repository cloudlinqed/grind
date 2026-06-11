import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { findProjectDir, loadConfig, loadState, saveState, isOff, log } from './state.mjs';
import { parsePlan, uncheckedItems } from './plan.mjs';
import { parseEndstate } from './endstate.mjs';
import { runCommand, callClaude, tail, indent } from './proc.mjs';
import { lastAssistantText } from './transcript.mjs';

const BLOCKER_RE = /^\s*BLOCKED:/m;
const DONE_RE = /(all\s+(phases|tasks|items|criteria|steps)\b[^.\n]{0,60}\b(complete|completed|done|finished|implemented)|fully\s+implemented|implementation\s+is\s+(now\s+)?complete|plan\s+is\s+(now\s+)?complete|everything\s+[^.\n]{0,30}\b(complete|done)|all\s+tests\s+pass)/i;
const CHECKPOINT_RE = /(shall\s+i|should\s+i\s+(proceed|continue)|would\s+you\s+like|do\s+you\s+want|want\s+me\s+to\s+(proceed|continue)|let\s+me\s+know|your\s+(approval|confirmation|review|input|feedback)|ready\s+(for|to)\s+(review|proceed|continue)|before\s+(i|we)\s+(proceed|continue)|please\s+(review|confirm)|if\s+you(['’])?d\s+like|happy\s+to\s+(continue|proceed)|pausing\s+(here|for))/i;

// Classification must ignore fenced code: a quoted "BLOCKED:" example or a
// checkbox in a markdown snippet is not a signal.
export function stripFences(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
}

export function classifyHeuristic(text) {
  if (BLOCKER_RE.test(text)) return 'blocker';
  if (DONE_RE.test(text)) return 'done';
  if (CHECKPOINT_RE.test(text) || /\?\s*$/.test(text)) return 'checkpoint';
  return 'ambiguous';
}

async function llmClassify(text, config) {
  const prompt = `An autonomous coding agent working through a long multi-phase plan has paused with the message below.

Classify the pause. Reply with EXACTLY one word:
- BLOCKER — it needs something only a human can provide (a credential, a decision, contradictory requirements, a broken environment)
- DONE — it claims all planned work is complete
- CHECKPOINT — anything else: asking permission/review/confirmation, summarizing progress, proposing to continue

Agent message:
---
${tail(text, 4000)}
---`;
  const { text: reply } = await callClaude({
    prompt,
    model: config.classifier.model,
    timeoutMs: config.classifier.timeoutMs
  });
  const word = (reply.trim().toUpperCase().match(/\b(BLOCKER|DONE|CHECKPOINT)\b/) || [])[1];
  if (!word) throw new Error(`classifier returned unparseable reply: ${reply.slice(0, 120)}`);
  return word.toLowerCase();
}

async function changeHash(projectDir) {
  const st = await runCommand('git status --porcelain', { cwd: projectDir, timeoutMs: 15000 });
  if (st.code !== 0) return null;
  // diff against HEAD so staged changes count as progress; repos with no
  // commits yet have no HEAD, hence the unstaged-only second attempt
  let di = await runCommand('git diff HEAD', { cwd: projectDir, timeoutMs: 30000 });
  if (di.code !== 0) di = await runCommand('git diff', { cwd: projectDir, timeoutMs: 30000 });
  if (di.code !== 0) return null;
  return crypto.createHash('sha1').update(st.out).update(di.out).digest('hex');
}

async function runFastGates(criteria, projectDir, budgetMs) {
  const gates = criteria.filter(c => c.verify && c.fast);
  const results = [];
  let remaining = budgetMs;
  for (const g of gates) {
    if (remaining <= 1000) {
      results.push({ gate: g, skipped: true });
      continue;
    }
    const t = Math.min(remaining, (g.timeoutSec ?? 60) * 1000);
    const r = await runCommand(g.verify, { cwd: projectDir, timeoutMs: t });
    remaining -= r.ms;
    results.push({ gate: g, ...r, ok: r.code === 0 && !r.timedOut });
  }
  return results;
}

function planItemLines(items) {
  return items.slice(0, 3).map(i => `- ${i.heading ? `[${i.heading}] ` : ''}${i.text}`).join('\n');
}

function composeContinue({ config, todo, n, max, stalled }) {
  const stallHint = stalled
    ? `\n- IMPORTANT: no file changes were detected across your last ${stalled} continuations. Re-read the relevant files and take a DIFFERENT approach from your previous attempts before editing again.`
    : '';
  return `grind continuation ${n}/${max} — do not stop to ask for review, confirmation, or to summarize progress. Keep working.

Next unchecked items in ${config.planFile} (${todo.length} remaining):
${planItemLines(todo)}

Rules:
- Continue with the first item above now. Stay strictly within the scope defined in ${config.endstateFile}.
- Mark each item complete in ${config.planFile} ([ ] -> [x]) as you finish it.${stallHint}
- Stop ONLY for a real blocker: a credential, a decision only the user can make, contradictory requirements, or a broken environment. If blocked, start a line with "BLOCKED:" stating exactly what you need.`;
}

function composeRepair({ config, todo, failing, n, max }) {
  const parts = [];
  if (failing.length) {
    parts.push(`Failing verification (run by grind itself, independent of your transcript):
${failing.map(f => `- ${f.gate.verify} -> ${f.timedOut ? 'TIMED OUT' : `exit ${f.code}`}\n${indent(tail(f.out || '', 800), '    ')}`).join('\n')}`);
  }
  if (todo.length) {
    parts.push(`${config.planFile} still has ${todo.length} unchecked item(s); next:
${planItemLines(todo)}`);
  }
  return `grind continuation ${n}/${max} — completion was claimed, but the evidence disagrees.

${parts.join('\n\n')}

Rules:
- Fix the failures and/or continue with the next unchecked item now. Do not declare completion until every ${config.planFile} item is checked and the verify commands in ${config.endstateFile} pass.
- Stay strictly within the scope defined in ${config.endstateFile}.
- Stop ONLY for a real blocker; if blocked, start a line with "BLOCKED:" stating exactly what you need.`;
}

function composeHandoff({ config, n, max }) {
  return `grind continuation ${n}/${max} — this session is at its continuation limit. Do exactly these two things, then stop:

1. Update ${config.planFile} checkboxes to reflect the ACTUAL current state of the work.
2. Write a concise handoff to .grind/HANDOFF.md: what was just completed, what is in progress, the next 3 concrete steps, and any pitfalls discovered.

A fresh session will continue from those files. Do not start new work.`;
}

export async function superviseStop(input) {
  if (process.env.GRIND_INTERNAL === '1') return { allow: true };

  const projectDir = findProjectDir(input.cwd ?? process.cwd());
  if (!projectDir) return { allow: true };

  const config = loadConfig(projectDir);
  if (isOff(projectDir)) {
    log(projectDir, { event: 'stop', verdict: 'OFF' });
    return { allow: true };
  }

  const state = loadState(projectDir);
  const sid = input.session_id ?? 'unknown';
  const s = (state.sessions[sid] ??= { continuations: 0, firstStopAt: Date.now(), hashes: [] });
  s.lastStopAt = Date.now();
  const max = config.rails.maxContinuationsPerSession;

  const finish = (decision, meta = {}) => {
    s.lastVerdict = meta.verdict;
    try {
      saveState(projectDir, state);
    } catch (e) {
      // a block whose counter never persisted could re-prompt forever — fail open
      log(projectDir, { event: 'state-save-failed', error: String(e?.message ?? e) });
      return { allow: true, systemMessage: 'grind: could not persist state — allowing stop (see .grind/grind.log).' };
    }
    log(projectDir, {
      event: 'stop',
      session: sid.slice(0, 8),
      verdict: meta.verdict,
      classification: meta.classification,
      continuations: s.continuations,
      ...meta.extra
    });
    return decision;
  };

  if (s.continuations >= max) {
    return finish(
      {
        allow: true,
        systemMessage: `grind: continuation limit reached (${max}) for this session — allowing stop. Run "grind validate", review .grind/HANDOFF.md, then continue in a fresh session.`
      },
      { verdict: 'LIMIT' }
    );
  }
  if (Date.now() - s.firstStopAt > config.rails.maxSessionMinutes * 60000) {
    return finish(
      { allow: true, systemMessage: `grind: session exceeded ${config.rails.maxSessionMinutes} minutes — allowing stop.` },
      { verdict: 'TIME' }
    );
  }

  const rawText = input.transcript_path ? lastAssistantText(input.transcript_path) : null;
  const text = rawText == null ? null : stripFences(rawText);
  if (text == null) {
    return finish(
      { allow: true, systemMessage: 'grind: could not read the session transcript — allowing stop (details in .grind/grind.log).' },
      { verdict: 'NO-TRANSCRIPT', extra: { transcript: input.transcript_path ?? null } }
    );
  }

  const planPath = path.join(projectDir, config.planFile);
  const esPath = path.join(projectDir, config.endstateFile);
  if (!fs.existsSync(planPath) || !fs.existsSync(esPath)) {
    const missing = !fs.existsSync(planPath) ? config.planFile : config.endstateFile;
    return finish(
      { allow: true, systemMessage: `grind: ${missing} not found — allowing stop. Create it (or run "grind init") to activate grinding.` },
      { verdict: 'NO-SPEC', extra: { missing } }
    );
  }

  const plan = parsePlan(fs.readFileSync(planPath, 'utf8'));
  if (plan.items.length === 0) {
    return finish(
      { allow: true, systemMessage: `grind: ${config.planFile} has no checkbox items — nothing to grind. Add "- [ ]" items.` },
      { verdict: 'EMPTY-PLAN' }
    );
  }
  const es = parseEndstate(fs.readFileSync(esPath, 'utf8'));
  if (es.errors.length) {
    log(projectDir, { event: 'spec-errors', errors: es.errors });
  }
  const todo = uncheckedItems(plan);

  let classification = classifyHeuristic(text);
  let classifiedBy = 'heuristic';
  if (classification === 'ambiguous') {
    if (config.classifier.useLlm) {
      try {
        classification = await llmClassify(text, config);
        classifiedBy = 'llm';
      } catch (e) {
        // bias toward grinding; real blockers have the explicit BLOCKED: convention
        classification = 'checkpoint';
        classifiedBy = `llm-error(${String(e.message ?? e).slice(0, 80)})`;
      }
    } else {
      classification = 'checkpoint';
    }
  }
  const classLabel = `${classification}/${classifiedBy}`;

  if (classification === 'blocker') {
    const line = (text.match(/^\s*BLOCKED:.*$/m) || ['(see last message)'])[0].trim();
    return finish(
      { allow: true, systemMessage: `grind: blocker surfaced — ${line.slice(0, 200)}` },
      { verdict: 'BLOCKED', classification: classLabel }
    );
  }

  if (classification === 'done' || todo.length === 0) {
    const gateResults = await runFastGates(es.criteria, projectDir, config.hook.fastGateBudgetMs);
    const failing = gateResults.filter(r => !r.skipped && !r.ok);
    const skipped = gateResults.filter(r => r.skipped);
    if (todo.length === 0 && failing.length === 0) {
      // be honest about coverage: in-hook checks are only the fast slice
      const ranGreen = gateResults.length - skipped.length;
      const slowVerify = es.criteria.filter(c => c.verify && !c.fast).length;
      const judges = es.criteria.filter(c => c.judge).length;
      const unchecked = [];
      if (skipped.length) unchecked.push(`${skipped.length} fast gate(s) skipped for time`);
      if (slowVerify) unchecked.push(`${slowVerify} verify criteria`);
      if (judges) unchecked.push(`${judges} judge criteria`);
      const coverage = unchecked.length
        ? ` NOT yet validated: ${unchecked.join(', ')} — run "grind validate" before trusting completion.`
        : ` All ${config.endstateFile} criteria were checked in-hook; run "grind validate" to confirm.`;
      const specNote = es.errors.length
        ? ` WARNING: ${es.errors.length} spec error(s) in ${config.endstateFile} (see .grind/grind.log).`
        : '';
      return finish(
        {
          allow: true,
          systemMessage: `grind: ${config.planFile} is fully checked; ${ranGreen} fast gate(s) green.${coverage}${specNote}`
        },
        { verdict: 'DONE-CANDIDATE', classification: classLabel }
      );
    }
    s.continuations++;
    const handoff = s.continuations === max;
    return finish(
      {
        allow: false,
        reason: handoff
          ? composeHandoff({ config, n: s.continuations, max })
          : composeRepair({ config, todo, failing, n: s.continuations, max })
      },
      {
        verdict: handoff ? 'HANDOFF' : 'REPAIR',
        classification: classLabel,
        extra: { failingGates: failing.length, todo: todo.length }
      }
    );
  }

  // checkpoint → continue
  let stalled = 0;
  if (config.stall.enabled) {
    const h = await changeHash(projectDir);
    if (h) {
      s.hashes.push(h);
      const k = config.stall.noChangeThreshold;
      if (s.hashes.length > k + 1) s.hashes.shift();
      if (s.hashes.length >= k && new Set(s.hashes.slice(-k)).size === 1) stalled = k;
    }
  }
  s.continuations++;
  const handoff = s.continuations === max;
  const reason = handoff
    ? composeHandoff({ config, n: s.continuations, max })
    : composeContinue({ config, todo, n: s.continuations, max, stalled });
  return finish(
    { allow: false, reason },
    { verdict: handoff ? 'HANDOFF' : 'CONTINUE', classification: classLabel, extra: { todo: todo.length, stalled } }
  );
}
