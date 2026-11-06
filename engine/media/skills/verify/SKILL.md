---
name: verify
description: Prove a code change does what it claims by exercising it end-to-end and observing what actually happens — drive the affected flow through its real surface instead of trusting tests, types or a code read. Use before handing over any nontrivial change. Skip it when the diff touches only tests, docs or types: there is nothing to observe.
---

**Verification is runtime observation.** Build the app, run it, drive
it to where the changed code executes, and capture what you see.
That capture is the evidence. Nothing else is.

**Don't stop at tests or typecheck.** A green suite proves CI works,
not that the change works — and not "just to be sure" either. The
time goes to running the thing instead. `import { foo } from './src'`
then logging its return value is a unit test you wrote yourself: the
app never ran. Whatever calls `foo` ends at a terminal, a socket or a
window. Go there.

## Find the change

The scope is what you are verifying: usually a diff, sometimes "does
X work". Establish the full range (`git diff @{u}.. --stat`, or
`git diff HEAD --stat` for uncommitted work) and state what you
found. **The diff is ground truth; any description is a claim about
it.** When they disagree, that is a finding.

## Surface

The surface is where a user — human or programmatic — meets the
change. That is where you observe:

| Change reaches | Surface | You |
|---|---|---|
| CLI / script | terminal | run it with run_command, capture the output |
| Server / API | socket | send the request, capture the response |
| Web UI | pixels | browser_navigate + browser_snapshot / browser_screenshot |
| Library | package boundary | sample code through the public export |
| Editor / VS Code | the editor | make the state happen, read diagnostics and output |

An internal function is not a surface. Follow the caller chain until
it reaches a row above. Tests in the diff are the author's evidence,
not a surface. A change with no runtime surface at all is **SKIP —
no runtime surface (reason)**, one line.

## Drive it

The smallest path that makes the changed code execute: changed a
flag? Run with it. Changed a handler? Hit that route. Changed error
handling? Trigger the error. Read your plan back before running — if
every step is build/typecheck/test, you planned a CI rerun, not a
verification.

Then **push on it**: probe around the change at the same surface.
Wrong method, empty value, malformed body, doubled flag, Ctrl-C
mid-operation, the same action twice, stale state underneath. A
probe that finds nothing is still a step: "🔍 empty `--from` → clean
`error: --from requires a value`, exit 2."

## Capture and report

Captured output is evidence; your memory is not. Paste the pane, the
response body, the screenshot. Report:

```
## Verification: <one line>

Verdict: PASS | FAIL | BLOCKED | SKIP

Steps
1. ✅/❌/⚠️/🔍 what you did → what it showed (with the evidence)
Findings
- what made you pause, not only bugs
```

🔍 marks a probe — a step off the happy path. At least one; a steps
list that is all ✅ is a happy-path replay. Destructive paths with no
dry run are not driven live: say which path you did not exercise.

Verdicts: **PASS** — you ran it and the change did what it should at
its surface (not: tests pass). **FAIL** — you ran it and it does not,
or breaks something else, or claim and diff disagree. **BLOCKED** —
you could not reach a state where the change is observable; say
exactly where. **SKIP** — nothing to run. No partial pass: "3 of 4"
is FAIL. **When in doubt, FAIL** — a false PASS ships broken code; a
false FAIL costs one more look.
