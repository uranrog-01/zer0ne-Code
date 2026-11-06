---
name: decision-doc
description: Turn a decision with real trade-offs into a structured document the user can answer quickly — options, a recommendation, and what each choice costs. Use it when a choice would otherwise become a wall of prose or a series of interrupting questions.
---

When one decision shapes the work (storage engine, state management,
buy vs build, which API to commit to), write `.zer0ne/decisions/<slug>.md`
in the workspace:

```
# <Decision — one line, as a question>

Status: open | decided (chosen: <option>)
Date: YYYY-MM-DD

## Options

### <Option name>  (recommended)
<2-4 sentences: what it is, why it wins here.>

### <Option name>
<2-4 sentences. Cost of choosing it, not a strawman.>

## What each choice costs
| | <opt A> | <opt B> |
|---|---|---|
| Effort | … | … |
| Ongoing risk | … | … |
| Reversibility | easy / costly | … |

## Recommendation
<The pick, in one sentence, and the condition that would change it.>
```

Rules:

- **2–4 options, recommendation first.** A recommendation listed last
  reads like an excuse; an option list with no lean is homework you
  handed back.
- **Costs, not feature grids.** The table answers "what do I give
  up", the thing prose hides.
- **Name the reversal condition.** "If the sync set grows past ~10k
  items, revisit this" turns a decision into a plan.
- Answers come back in chat ("go with B, but keep the API surface").
  When one arrives: mark the doc `decided`, note the date and the
  condition, and restate the choice in one line where the work
  happens ("Applied: cache-store -> redis"). The doc is the record;
  the code is the commitment.

One open decision, one document — do not bundle several questions
into a single file; they get decided at different times.
