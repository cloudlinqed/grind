# End State — CSV Import API

> Example of a filled-in ENDSTATE.md for a small Express + TypeScript service.
> The narrative defines scope; the checklist defines done. Anything not
> required by this file is out of scope.

## Narrative

The service exposes a `POST /import` endpoint that accepts a CSV file of
customer records, validates every row, inserts the valid rows into the
database, and returns a JSON report listing each rejected row with its row
number and the specific validation error. Malformed rows never abort the whole
import. The endpoint is covered by integration tests, the project typechecks
and lints clean, and the README documents the endpoint. Out of scope: any UI,
authentication changes, and bulk export.

## Acceptance Criteria

- [ ] The full test suite passes
  verify: npm test
  timeout: 900
- [ ] The project typechecks with no errors
  verify: npx tsc --noEmit
  fast: true
- [ ] Lint is clean
  verify: npx eslint src --max-warnings 0
  fast: true
- [ ] The import route module exists
  verify: node -e "require('node:fs').accessSync('src/routes/import.ts')"
  fast: true
- [ ] Malformed rows are rejected individually, not as a blanket failure
  judge: Does POST /import return a per-row error report (row number + reason) for invalid rows while still importing the valid ones, rather than rejecting the whole request?
  context: src/routes/import.ts, test/import.test.ts
- [ ] The endpoint is documented
  judge: Does the README document POST /import including the request format and the shape of the error report?
  context: README.md
