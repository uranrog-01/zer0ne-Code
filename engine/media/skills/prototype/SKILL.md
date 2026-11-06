---
name: prototype
description: Build or iterate an HTML prototype of a UI idea — one self-contained page the user can open in the artifact preview. Use it for mockups, click-through demos and "what if it looked like this" questions, not for production components.
---

**Intake first.** Two questions decide everything: is this "build now"
or "ask first" (a direction worth one clarifying question before any
code), and which fidelity — **sketch** (structure only), **clickable**
(states and navigation work), or **wired** (sample data flows through).
Name the fidelity in one line before you start.

**One design question per page.** The prototype exists to answer one
thing ("does the timeline read better as rows or cards?"). Put that
question in a comment at the top of the file; everything on the page
serves it.

Build it as a single self-contained HTML document and publish it with
the `publish_artifact` tool — the user gets a preview panel, and
republishing the same name updates that panel in place. **Iterate by
republishing the same file.** Creating `v2`, `final`, `final2` copies
loses the thread; one file, one name, newest wins.

Rules that keep prototypes useful:

- Real-looking sample data (names, prices, dates), never lorem ipsum
  or `asdf`.
- State your assumptions in chat, not in the page: "assumed the list
  shows 20 items; say the word if it paginates".
- End with a hand-off brief in three buckets — **must** (what makes
  this work), **nice** (obvious next touches), **cut** (what you
  deliberately left out). The cut list is the part that saves the
  user time.
- Rebuilding an existing screen from source? Match it exactly and say
  so; a deliberate deviation is a design decision, not an accident.
