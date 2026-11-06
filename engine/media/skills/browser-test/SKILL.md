---
name: browser-test
description: Check a web app's behavior by driving it with the browser tools against short, goal-oriented specs — "three to ten lines of intent beat thirty lines of click-this-then-that". Use it when asked to test, smoke-check or verify a web UI in the workspace.
---

Write the spec before touching the browser. A spec is a short markdown
note (`.zer0ne/tests/<name>.md`) with three parts:

1. **The flow's name** — what a user would call this ("Checkout with a
   promo code").
2. **Goal-oriented steps** — "Add the travel mug to the cart", never
   "click button.x7". Three to ten steps. The selector work is yours,
   not the spec's.
3. **"Passes when"** — criteria checkable from ONE screenshot at the
   end: cart shows the mug, total includes the discount, the banner is
   gone.

Rules that keep specs honest:

- **One flow per spec.** A spec that covers two flows fails halfway
  and tells you nothing about either.
- **Sentinels over credentials**: data you type must be unmistakable
  (`zzqx-test-note`), and never sign in anywhere but the site under
  test. If the flow needs auth, ask the user for a test account and
  keep those steps in a separate spec.
- **No state sabotage**: a spec may create data; it never edits or
  deletes data it did not create in the same run.

Run it with the browser tools (`browser_navigate`, `browser_click`,
`browser_type`, `browser_snapshot`). After the last step take a
screenshot and judge it against "passes when" — the screenshot is the
verdict's evidence, not your memory of the clicks.

Report per spec: PASS or FAIL, the screenshot, and one line per
failed criterion. A flaky pass (passed on retry) is reported as flaky,
never as PASS. When a step cannot run at all (element missing, page
errors), that is BLOCKED with the console output — do not improvise a
different flow mid-spec.
