# Plan — CSV Import API

> Example of a filled-in PLAN.md matching examples/ENDSTATE.md.
> grind reads this file at every stop: unchecked boxes mean "keep going".
> The agent checks items off ([ ] -> [x]) as it completes them, and may add
> items — but only within the scope defined in ENDSTATE.md.

## Phase 1 — Parsing and validation

- [ ] Add csv-parse dependency and a typed row schema for customer records
- [ ] Implement row validator: required fields, email format, date format
- [ ] Unit tests for the validator covering each rejection reason

## Phase 2 — Endpoint

- [ ] POST /import route: multipart upload, streaming parse, per-row validation
- [ ] Insert valid rows in a single transaction; collect rejected rows
- [ ] Return JSON report: imported count + rejected[] with row number and reason
- [ ] Integration tests: clean file, mixed file, fully invalid file, empty file

## Phase 3 — Polish

- [ ] Wire route into the app router with size limits
- [ ] Document POST /import in the README (request format, report shape)
- [ ] Lint and typecheck clean
