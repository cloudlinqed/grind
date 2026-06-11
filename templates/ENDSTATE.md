# End State — <project name>

> grind validates the project against this file. The narrative defines scope;
> the checklist defines done. Anything not required by this file is out of scope.

## Narrative

Describe, in a paragraph or two, what the finished system looks like: what it
does, what it explicitly does not do, and how you would tell it is complete.

## Acceptance Criteria

<!--
Each criterion is a checkbox followed by indented "key: value" lines.
  verify: <shell command>    machine-checked by grind; exit code 0 = pass
  timeout: <seconds>         for verify commands (default 600)
  fast: true                 cheap enough for the in-session Stop hook to run
  judge: <question>          fuzzy criterion judged by a fresh LLM (never the worker)
  context: <file, file>      files the judge reads (required for judge criteria)
A criterion must have exactly one of verify: or judge:.
-->

- [ ] The full test suite passes
  verify: npm test
  timeout: 900
- [ ] The project typechecks with no errors
  verify: npx tsc --noEmit
  fast: true
- [ ] <fuzzy requirement stated as a yes/no question>
  judge: <question the judge should answer about the implementation>
  context: src/example.ts
