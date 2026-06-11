import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, GrindError } from './state.mjs';
import { parseEndstate } from './endstate.mjs';
import { runCommand, callClaude } from './proc.mjs';

const FILE_CAP = 50000;

// Greedy {.*} grabs from first { to LAST } — fatal when the judge echoes the
// two example objects from the prompt. Parse whole reply first, then walk a
// balanced-brace span (string-aware) from the first {.
function extractJson(text) {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.indexOf('{');
  if (start === -1) throw new Error(`no JSON object in judge reply: ${t.slice(0, 200)}`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1));
    }
  }
  throw new Error(`unbalanced JSON in judge reply: ${t.slice(0, 200)}`);
}

function judgePrompt({ goal, criterion, files, gateSummary }) {
  return `You are a strict, adversarial validator for an autonomous coding project. Decide whether ONE acceptance criterion is truly satisfied by the current code. Actively look for reasons it is NOT satisfied. Do not give the benefit of the doubt.

PROJECT END-STATE (scope/contract):
${goal || '(no narrative provided)'}

CRITERION TO JUDGE:
${criterion.judge}

DETERMINISTIC GATE RESULTS (context):
${gateSummary || '(none run)'}

RELEVANT FILES:
${files.map(f => `--- ${f.path}${f.truncated ? ' (truncated)' : ''} ---\n${f.content}`).join('\n\n')}

Reply with ONLY a JSON object, no markdown fences, exactly this shape:
{"verdict":"pass","evidence":"<specific evidence from the files>","suggested_fix":""}
or
{"verdict":"fail","evidence":"<specific evidence from the files>","suggested_fix":"<concrete fix>"}`;
}

export async function validateProject(projectDir, { onProgress } = {}) {
  const config = loadConfig(projectDir);
  const esPath = path.join(projectDir, config.endstateFile);
  if (!fs.existsSync(esPath)) throw new GrindError(`${config.endstateFile} not found in ${projectDir}`);
  const es = parseEndstate(fs.readFileSync(esPath, 'utf8'));
  if (es.errors.length) {
    throw new GrindError(`spec errors in ${config.endstateFile}:\n  - ${es.errors.join('\n  - ')}`);
  }
  if (es.criteria.length === 0) throw new GrindError(`${config.endstateFile} has no acceptance criteria`);

  const results = [];

  for (const c of es.criteria.filter(c => c.verify)) {
    onProgress?.(`verify: ${c.verify}`);
    const r = await runCommand(c.verify, { cwd: projectDir, timeoutMs: (c.timeoutSec ?? 600) * 1000 });
    results.push({
      criterion: c,
      kind: 'verify',
      ok: r.code === 0 && !r.timedOut,
      detail: r.timedOut ? `timed out after ${c.timeoutSec ?? 600}s` : `exit ${r.code}`,
      output: r.out,
      ms: r.ms
    });
  }

  const gateSummary = results
    .map(r => `- ${r.criterion.verify}: ${r.ok ? 'PASS' : 'FAIL'} (${r.detail})`)
    .join('\n');

  for (const c of es.criteria.filter(c => c.judge)) {
    onProgress?.(`judge: ${c.text}`);
    const files = [];
    for (const rel of c.context) {
      const fp = path.join(projectDir, rel);
      if (!fs.existsSync(fp)) {
        files.push({ path: rel, missing: true });
        continue;
      }
      if (fs.statSync(fp).isDirectory()) {
        files.push({ path: rel, missing: true, isDir: true });
        continue;
      }
      let content = fs.readFileSync(fp, 'utf8');
      const truncated = content.length > FILE_CAP;
      if (truncated) content = content.slice(0, FILE_CAP);
      files.push({ path: rel, content, truncated });
    }
    const bad = files.filter(f => f.missing);
    if (bad.length) {
      results.push({
        criterion: c,
        kind: 'judge',
        ok: false,
        detail: bad.map(f => (f.isDir ? `context path is a directory (list files explicitly): ${f.path}` : `context file missing: ${f.path}`)).join('; ')
      });
      continue;
    }

    const votes = [];
    let cost = 0;
    let error = null;
    const nVotes = Math.max(1, config.judge.votes | 0);
    for (let v = 0; v < nVotes; v++) {
      try {
        const { text, costUsd } = await callClaude({
          prompt: judgePrompt({ goal: es.goal, criterion: c, files, gateSummary }),
          model: config.judge.model,
          timeoutMs: config.judge.timeoutMs
        });
        cost += costUsd ?? 0;
        const verdict = extractJson(text);
        if (verdict.verdict !== 'pass' && verdict.verdict !== 'fail') {
          throw new Error(`invalid verdict value: ${JSON.stringify(verdict.verdict)}`);
        }
        votes.push(verdict);
      } catch (e) {
        error = e;
        break;
      }
    }
    if (error) {
      results.push({ criterion: c, kind: 'judge', ok: false, detail: `judge error: ${error.message}`, costUsd: cost });
      continue;
    }
    const passes = votes.filter(v => v.verdict === 'pass').length;
    const ok = passes > votes.length / 2;
    const failVote = votes.find(v => v.verdict === 'fail');
    const passVote = votes.find(v => v.verdict === 'pass');
    results.push({
      criterion: c,
      kind: 'judge',
      ok,
      detail: `${passes}/${votes.length} vote(s) pass`,
      evidence: (ok ? passVote : failVote)?.evidence,
      suggestedFix: ok ? undefined : failVote?.suggested_fix,
      costUsd: cost
    });
  }

  return { results, ok: results.every(r => r.ok) };
}
