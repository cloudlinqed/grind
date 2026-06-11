# grind

**A supervisor loop for Claude Code.** When the agent stops mid-plan to ask *"shall I continue?"*, grind answers for you — with a validated, targeted re-prompt — until the plan is actually done and the end state actually verifies.

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code finishes a turn ──► Stop hook ──► grind        │
│                                                  │          │
│            ┌─────────────────────────────────────┘          │
│            ▼                                                │
│   classify the stop ── gather evidence ── pick a verdict    │
│   (blocker? done-claim?   (PLAN.md boxes,                   │
│    checkpoint?)            verify commands,                 │
│                            git state)                       │
│            │                                                │
│            ├─ CONTINUE ──► re-prompt with the next item     │
│            ├─ REPAIR ────► re-prompt with failing output    │
│            ├─ DONE ──────► allow stop, suggest validation   │
│            ├─ BLOCKED ───► allow stop, surface to you       │
│            └─ LIMIT ─────► request handoff, stand down      │
└─────────────────────────────────────────────────────────────┘
```

## Why

On large multi-phase projects, coding agents stop early — they pause at phase boundaries to ask for review or confirmation, no matter what your instructions say. That checkpointing is trained behavior, not disobedience, so no `CLAUDE.md` line reliably fixes it, and instructions get diluted as the context grows. Built-in goal features evaluate the agent's own transcript, which means they trust the agent's claim that work is done.

grind takes the opposite stance on both problems:

- **It doesn't fight the stop — it answers it.** Stops at phase boundaries are by design; today *you* are the one who reads the summary and says "looks fine, continue with phase 3." grind is that reviewer with perfect patience.
- **It never trusts the agent's own "done."** grind runs the verification commands itself, in its own process, and its LLM judge never sees the worker's transcript — only the spec and the code.

Two files define the work, so forced continuation can't wander off and generate random code:

| File | Role |
|---|---|
| `ENDSTATE.md` | The contract. A narrative (scope) plus acceptance criteria, each machine-checked (`verify:`) or judged from the code by a fresh LLM (`judge:`). Anything not required by this file is out of scope. |
| `PLAN.md` | The live multi-phase plan. Unchecked boxes mean "keep going"; the agent checks items off as it works. Re-prompts always point at the next unchecked item — grind never invents tasks. |

## Requirements

- Node.js ≥ 18 (no dependencies, no build step)
- [Claude Code](https://claude.com/claude-code) CLI installed (`claude` on PATH — also used for grind's internal classifier/judge calls, billed to your account; both can be disabled, see Configuration)
- Git in the target project (optional — enables stall detection)
- Developed and tested on Windows 11; macOS/Linux supported best-effort

## Installation

```bash
git clone https://github.com/cloudlinqed/grind.git
cd grind
npm test          # optional: 10 end-to-end smoke tests, no API calls
npm link          # optional: makes a global `grind` command
```

Without `npm link`, replace `grind` below with `node <path-to-clone>/bin/grind.mjs`.

> Note: `grind init` writes the absolute paths of your Node binary and this clone into the target project's hook configuration. If you move the clone, re-run `grind init` in each project.

## Quick start

**1. Initialize your project** (works on a completely empty folder — `.claude/` is created if missing):

```bash
grind init /path/to/your-project
```

This creates `.grind/config.json`, `ENDSTATE.md`, `PLAN.md` (templates, only if missing), and wires a Stop hook into the project's `.claude/settings.json` (an existing file is backed up first).

**2. Edit `ENDSTATE.md`** — the most important step. The narrative defines scope; the checklist defines done. Every `verify:` command must actually run in your project. See [examples/ENDSTATE.md](examples/ENDSTATE.md).

**3. Edit `PLAN.md`** with real `- [ ]` items. If Claude Code already maintains a plan file, point `planFile` in `.grind/config.json` at it instead.

**4. Add one line to the project's `CLAUDE.md`:**

```
If you are genuinely blocked, start a line with "BLOCKED:" stating exactly what you need.
```

(Optional but recommended — every grind re-prompt teaches the same convention, but this makes even the first stop able to use it.)

**5. Start Claude Code from the project root.** On first start it will ask you to approve the Stop hook found in project settings — **approve it; that's the moment grind goes live.** Then hand Claude the task and watch the continuations.

## Verifying the hook is live

1. **`/hooks` inside Claude Code** — the Stop entry with the `grind.mjs hook-stop` command should be listed. Confirms Claude Code loaded it.
2. **`.grind/grind.log`** — grind writes a line on *every* stop, even allowed ones. Wiring test without triggering re-prompts: run `grind off`, ask Claude anything trivial, then check the log for `{"event":"stop","verdict":"OFF"}`. Then `grind on`.
3. **`claude --debug`** — prints hook executions and their JSON responses, if 1 and 2 disagree.

Heads-up: grind doesn't distinguish small talk from work. With unchecked plan items, even a casual answer can be re-prompted toward the plan — that's by design. Keep grind `off` until you actually hand over the task.

## ENDSTATE.md reference

```markdown
- [ ] The full test suite passes
  verify: npm test
  timeout: 900
- [ ] The project typechecks
  verify: npx tsc --noEmit
  fast: true
- [ ] Imports reject malformed rows with per-row errors
  judge: Does POST /import reject malformed rows with per-row errors rather than a blanket 400?
  context: src/routes/import.ts, test/import.test.ts
```

| Key | Meaning |
|---|---|
| `verify: <command>` | Machine-checked: grind runs it from the project root; exit 0 = pass |
| `timeout: <seconds>` | Per-command timeout for `verify:` (default 600) |
| `fast: true` | Cheap enough to also run inside the Stop hook when the agent claims completion |
| `judge: <question>` | Fuzzy criterion answered by a fresh LLM that sees the spec and the listed files — never the worker's transcript |
| `context: <file, file>` | Files the judge reads (required for `judge:` criteria) |

Rules: exactly one of `verify:`/`judge:` per criterion; keys are indented under their checkbox; checkboxes inside code fences are ignored.

`PLAN.md` is plain markdown checkboxes under headings — see [examples/PLAN.md](examples/PLAN.md).

## Commands

```
grind init [dir]   set up .grind/, templates, and the Stop hook in a project
grind status       plan progress, session continuations, recent decisions
grind validate     full validation: every verify: gate + every judge: criterion
grind off | on     pause / resume (off = the hook allows all stops, still logs)
grind hook-stop    (internal) Stop hook entry point — wired by init
```

`grind validate` exits 0 when all criteria pass, 1 otherwise — run it when grind reports a DONE-CANDIDATE, or wire it into CI.

## Configuration (`.grind/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `planFile` / `endstateFile` | `PLAN.md` / `ENDSTATE.md` | the two contract files |
| `rails.maxContinuationsPerSession` | 25 | re-prompts per session before grind stands down (the last one requests a handoff to `.grind/HANDOFF.md`) |
| `rails.maxSessionMinutes` | 240 | wall-clock rail per session |
| `classifier.useLlm` | true | classify ambiguous stops with a cheap model (regex heuristics always run first; set false for fully deterministic, zero-cost operation) |
| `classifier.model` / `judge.model` | `haiku` | models for classification / judging |
| `judge.votes` | 1 | majority-vote count for judge criteria (use 3 for final sign-off) |
| `hook.fastGateBudgetMs` | 90000 | total time the in-hook fast gates may take |
| `stall.noChangeThreshold` | 3 | identical git-state stops before a change-of-approach hint is injected |

## Safety and escape hatches

- `grind off` (or creating `.grind/OFF`) makes the hook allow every stop instantly.
- The continuation counter is the loop guard: grind always stands down at the rail, requesting a written handoff first. A state-persistence failure also fails open (allows the stop) rather than risking an unbounded loop.
- Any hook error fails open and logs to `.grind/grind.log` — grind can break itself, but it can't break your session.
- Internal LLM calls carry a guard env var and a neutral working directory, so grind never supervises (or recurses into) its own judge/classifier sessions.
- grind runs `verify:` commands itself and reads git state itself — the agent's claims are never the evidence.

## Under the hood

On every Stop event the hook receives the session info on stdin, finds the nearest `.grind/` walking up from the session's cwd, and:

1. **Rails** — continuation/time limits checked first; at the limit grind allows stops and tells you to validate and start fresh.
2. **Classify** — the agent's last message (code fences stripped) is matched against blocker/done/checkpoint patterns; ambiguous cases go to a one-word LLM classification, and classifier failures default to "checkpoint" (grinding bias — real blockers have the explicit `BLOCKED:` convention).
3. **Evidence** — unchecked `PLAN.md` items; on done-claims, the `fast: true` gates actually run inside the hook. A done-claim that contradicts the evidence gets a REPAIR re-prompt quoting the failing output verbatim.
4. **Stall detection** — a hash of `git status` + `git diff HEAD` per stop; N identical hashes inject a "take a different approach" hint into the next re-prompt.
5. **Decision** — blocks emit `{"decision":"block","reason":<the re-prompt>}`; allows emit `{}` (optionally with a status message). Reasons always name the next concrete plan item and restate the scope boundary and the `BLOCKED:` exit.

Full validation (`grind validate`) runs every `verify:` gate with full timeouts, then each `judge:` criterion as a fresh `claude -p` call with a strict adversarial prompt and structured JSON verdicts — majority-voted if `judge.votes` > 1.

## Does it work with agents other than Claude Code?

Not yet. The supervisor brain (parsers, gates, verdicts, judge, rails) is agent-agnostic; the transport (Stop hook wiring, transcript format) is Claude Code-specific. OpenAI Codex CLI support is planned via the unattended outer loop (`codex exec` per iteration — process exit is the stop signal, no hooks needed).

## Roadmap

- **v0.2** — unattended `grind run`: an outer loop that spawns headless `claude -p` sessions, runs full validation between iterations, git-checkpoints each one, and rehydrates fresh sessions from `HANDOFF.md`; Codex CLI driver.
- **Planned** — tamper sentinel (hash protected test files so the agent can't game gates by weakening them), judge drift-check verdict (REDIRECT), spec linter.

Until the tamper sentinel lands: a determined agent can game gates it can edit. Keep test files out of the plan's scope, review per-phase diffs, and prefer `verify:` commands the agent has no reason to touch.

## Development

```bash
npm test    # test/smoke.mjs — exercises the hook end-to-end with fixture transcripts, no API calls
```

Zero dependencies, plain ESM, Node ≥ 18.

## License

[MIT](LICENSE)
