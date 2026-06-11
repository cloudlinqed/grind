import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'grind.mjs');

let projects = [];

function mkProject({ planChecked = false, gateExit = 0, maxContinuations = 25 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grind-smoke-'));
  projects.push(dir);
  const r = spawnSync(process.execPath, [BIN, 'init', dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `init failed: ${r.stderr}\n${r.stdout}`);

  // deterministic test: no LLM classifier, tight rails
  const cfgPath = path.join(dir, '.grind', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.classifier.useLlm = false;
  cfg.rails.maxContinuationsPerSession = maxContinuations;
  cfg.stall.enabled = false;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const box = planChecked ? 'x' : ' ';
  fs.writeFileSync(
    path.join(dir, 'PLAN.md'),
    `# Plan\n\n## Phase 1 — Core\n\n- [${box}] implement the parser\n- [${box}] wire the CLI\n\n## Phase 2 — Polish\n\n- [${box}] write README\n`
  );
  fs.writeFileSync(
    path.join(dir, 'ENDSTATE.md'),
    `# End State\n\n## Narrative\n\nSmoke test project.\n\n## Acceptance Criteria\n\n- [ ] node exits ${gateExit}\n  verify: node -e "process.exit(${gateExit})"\n  fast: true\n`
  );
  return dir;
}

function writeTranscript(dir, text) {
  const p = path.join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the work' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function hookStop(dir, transcriptPath, sessionId) {
  const input = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: dir,
    hook_event_name: 'Stop'
  });
  const r = spawnSync(process.execPath, [BIN, 'hook-stop'], { input, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `hook-stop exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

// 1. checkpoint stop with work remaining → block with a targeted re-prompt
{
  const dir = mkProject();
  const t = writeTranscript(dir, 'Phase 1 is complete. Shall I proceed with Phase 2?');
  const out = hookStop(dir, t, 'sess-checkpoint');
  assert.strictEqual(out.decision, 'block', `expected block, got: ${JSON.stringify(out)}`);
  assert.ok(out.reason.includes('implement the parser'), 'reason should name the next unchecked item');
  assert.ok(out.reason.includes('continuation 1/'), 'reason should show the continuation counter');
  console.log('ok: checkpoint stop is blocked with a targeted re-prompt');
}

// 2. explicit blocker → allow, surfaced to the user
{
  const dir = mkProject();
  const t = writeTranscript(dir, 'I cannot continue.\nBLOCKED: I need the production API key for the payments sandbox.');
  const out = hookStop(dir, t, 'sess-blocker');
  assert.strictEqual(out.decision, undefined, `expected allow, got: ${JSON.stringify(out)}`);
  assert.ok(out.systemMessage.includes('BLOCKED: I need the production API key'), 'blocker line should surface');
  console.log('ok: BLOCKED: stop is allowed and surfaced');
}

// 3. done claim, plan fully checked, fast gate green → allow with validate suggestion
{
  const dir = mkProject({ planChecked: true, gateExit: 0 });
  const t = writeTranscript(dir, 'All phases are complete. Everything is implemented and all tests pass.');
  const out = hookStop(dir, t, 'sess-done');
  assert.strictEqual(out.decision, undefined, `expected allow, got: ${JSON.stringify(out)}`);
  assert.ok(out.systemMessage.includes('grind validate'), 'should point at full validation');
  console.log('ok: verified done-candidate is allowed to stop');
}

// 4. done claim but fast gate fails → block with repair re-prompt
{
  const dir = mkProject({ planChecked: true, gateExit: 1 });
  const t = writeTranscript(dir, 'All phases are complete. Everything is implemented and all tests pass.');
  const out = hookStop(dir, t, 'sess-repair');
  assert.strictEqual(out.decision, 'block', `expected block, got: ${JSON.stringify(out)}`);
  assert.ok(out.reason.includes('evidence disagrees'), 'repair reason expected');
  assert.ok(out.reason.includes('exit 1'), 'failing gate exit code should be cited');
  console.log('ok: false done claim is blocked with gate evidence');
}

// 5. done claim with unchecked plan items → block, citing the plan
{
  const dir = mkProject({ planChecked: false, gateExit: 0 });
  const t = writeTranscript(dir, 'All phases are complete. Everything is implemented and all tests pass.');
  const out = hookStop(dir, t, 'sess-done-todo');
  assert.strictEqual(out.decision, 'block', `expected block, got: ${JSON.stringify(out)}`);
  assert.ok(out.reason.includes('unchecked item'), 'should cite unchecked plan items');
  console.log('ok: done claim with unchecked plan items is blocked');
}

// 6. rails: continuation limit → handoff on the last allowed block, then allow
{
  const dir = mkProject({ maxContinuations: 2 });
  const t = writeTranscript(dir, 'Phase 1 is complete. Shall I proceed with Phase 2?');
  const first = hookStop(dir, t, 'sess-rails');
  assert.strictEqual(first.decision, 'block');
  assert.ok(first.reason.includes('continuation 1/2'));
  const second = hookStop(dir, t, 'sess-rails');
  assert.strictEqual(second.decision, 'block');
  assert.ok(second.reason.includes('HANDOFF.md'), 'final continuation should request a handoff');
  const third = hookStop(dir, t, 'sess-rails');
  assert.strictEqual(third.decision, undefined, `expected allow, got: ${JSON.stringify(third)}`);
  assert.ok(third.systemMessage.includes('continuation limit'), 'limit message expected');
  console.log('ok: continuation rail produces handoff then allows stop');
}

// 7. grind off → allow silently
{
  const dir = mkProject();
  const r = spawnSync(process.execPath, [BIN, 'off'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const t = writeTranscript(dir, 'Phase 1 is complete. Shall I proceed with Phase 2?');
  const out = hookStop(dir, t, 'sess-off');
  assert.deepStrictEqual(out, {}, `expected silent allow, got: ${JSON.stringify(out)}`);
  console.log('ok: grind off allows all stops');
}

// 8. uninitialized directory → silent allow (hook is safe anywhere)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grind-noinit-'));
  projects.push(dir);
  const t = writeTranscript(dir, 'Shall I proceed?');
  const out = hookStop(dir, t, 'sess-noinit');
  assert.deepStrictEqual(out, {}, `expected silent allow, got: ${JSON.stringify(out)}`);
  console.log('ok: hook is inert outside grind projects');
}

// 9. GRIND_INTERNAL guard → silent allow even in an initialized project
{
  const dir = mkProject();
  const t = writeTranscript(dir, 'Shall I proceed?');
  const input = JSON.stringify({ session_id: 's', transcript_path: t, cwd: dir, hook_event_name: 'Stop' });
  const r = spawnSync(process.execPath, [BIN, 'hook-stop'], {
    input,
    encoding: 'utf8',
    env: { ...process.env, GRIND_INTERNAL: '1' }
  });
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {}, 'internal sessions must never be grinded');
  console.log('ok: GRIND_INTERNAL sessions are ignored');
}

// 10. checkboxes and BLOCKED: lines inside code fences are ignored
{
  const dir = mkProject({ planChecked: true, gateExit: 0 });
  fs.appendFileSync(
    path.join(dir, 'PLAN.md'),
    '\n## Notes\n\n```markdown\n- [ ] example checkbox inside a fence — not a task\n```\n'
  );
  const t = writeTranscript(
    dir,
    'All phases are complete. Everything is implemented and all tests pass.\n\n```\nBLOCKED: this is a quoted example, not a real blocker\n```'
  );
  const out = hookStop(dir, t, 'sess-fence');
  assert.strictEqual(out.decision, undefined, `expected allow (fenced content must not count), got: ${JSON.stringify(out)}`);
  assert.ok(out.systemMessage.includes('grind validate'), 'should reach the DONE-CANDIDATE path, not BLOCKED');
  console.log('ok: fenced checkboxes and fenced BLOCKED: lines are ignored');
}

for (const p of projects) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}
console.log('\nall smoke tests passed');
