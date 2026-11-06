# zer0ne Code — User guide

The complete reference for every panel and setting. For an overview, see the [README](../README.md); to build the app, see [Building and releasing](building.md).

**Contents:** [Getting started](#getting-started) · [Providers and subscriptions](#providers-and-subscriptions) · [Local models](#local-models) · [Workflows and subagents](#workflows-and-subagents) · [Background work](#background-work) · [Chats, review and Side Chat](#chats-review-and-side-chat) · [Appearance and transparency](#appearance-and-transparency) · [Terminal and project actions](#terminal-and-project-actions) · [Computer Use](#computer-use) · [Features, benchmark and goals](#features-benchmark-and-goals) · [Project checks](#project-checks) · [Command rules and sandbox](#command-rules-and-sandbox) · [Mobile remote](#mobile-remote) · [Your data](#your-data)

## Getting started

Run the installer (`zer0ne-Code-Setup-<version>.exe`) or copy a built `win-unpacked` folder anywhere and start `zer0ne Code.exe`. The installer adds Start Menu and desktop shortcuts; a copied folder adds its own Start Menu entry on first start (Windows shows notifications only for apps listed there). Quit from the tray icon (right-click, **Quit**); closing the window keeps your projects running in the background.

Running chats save progress periodically. After an interruption, reopening the chat
keeps its last saved partial reply and marks abandoned work as stopped. It does not
automatically resend your prompt; review the saved work before choosing **Retry**.

## Providers and subscriptions

Open **Settings → Providers & models → Add provider**. **Plans & subscriptions**
lists account connections and dedicated plan keys together. **API keys** has its own tab. ChatGPT connects through
OpenAI's browser flow for locally hosted agents, with a renewable session and your
account's current model list. **Add another account** keeps registrations separate;
choose the account in the provider list. Signing out clears its tokens and attempts
to end the remote session while retaining its registration for reconnecting.
OpenRouter uses its browser approval flow and its own
credits. More than 20 vendor-agent plan cards include
Claude, Google, Cursor, GitHub Copilot, OpenCode, Factory, Augment, JetBrains and
Grok Build, Kimi and MiniMax. ChatGPT and Google Antigravity each have one primary card; alternate Codex and Gemini CLI routes are omitted from this list.
The card explains missing software
or platform support before connecting. Package agents need Node.js or uv;
binary agents are downloaded when you connect, with confirmation for the download.
Finish the provider's browser or terminal login, then select an enabled model in chat.
The available models, quotas and whether a subscription permits the connection
are determined by the provider and your account.

Use **API keys** for regular API billing, or **Custom** for Chat Completions,
Responses, Anthropic Messages and native Gemini endpoints. Subscription keys use
the plan's own URL. OpenCode Go automatically picks the API format its model requires.
**Check connection** lists models for API keys. Vendor-agent checks, model tests
and account checks generate a short response and use quota. A saved
connection shows **Ready** until checked; failed checks show **Needs attention**.
Replacing a plan key updates the existing provider and keeps your model choices.
For vendor agents, **Fetch models** refreshes the account's current catalog and
removes withdrawn choices. Existing choices keep their settings; use **Enable models**
to add newly offered choices to chat. Model names come from the vendor's agent.
New Claude connections prefer its current model aliases; older versions remain
available in the provider's model list. Reconnecting preserves your choices.

Subscriptions do not all offer third-party OAuth. Use the provider's supported
agent login or dedicated plan key when browser OAuth is unavailable. Agent login
and model access depend on the vendor's client, operating system and account policy.
GitHub Models has retired; GitHub Copilot connects through its own agent and is a
separate service. Existing account connections are retained; use **Connect vendor
agent** when renewing a legacy Grok, Kimi or MiniMax connection.

Claude's subscription login ignores user-level proxy settings, just as its chat
agent does. A working proxy connection in your usual Claude terminal does not
mean this subscription connection is signed in; use **Sign in again** to finish
Claude's own browser login. Failed or unchecked agent connections show their
actual connection state.

Claude can report an OAuth login without reporting the account's plan. zer0ne
checks that login through Claude's agent; an omitted plan field does not block
sign-in. If Antigravity asks to verify your Google account, finish its verification
in the browser. If Google's page returns 500, use the recovery links and sign in
again in Antigravity to obtain a fresh challenge. Gemini CLI's former consumer
Google login has retired; use the Google Antigravity card for eligible personal plans.

Reasoning defaults to **Auto**, which uses the selected model or signed-in
agent's default. When the connection advertises adjustable reasoning, a compact
chat menu offers its supported levels. Models without adjustable reasoning need
no extra control. An API key or plan name alone does not specify an effort level.
Manual overrides can increase response time and token usage; **Maximum** is an
explicit setting where supported. Agent model variants appear by their actual name.

## Local models

A model Check distinguishes an estimated memory fit from a model tested on this
computer. Draft helpers such as DFlash cannot chat on their own. Raw
`.gguf.partN` chunks require the publisher's assembly steps and a compatible
runtime; they are shown together for size checking and cannot be run or
downloaded here as a standalone model. MoE memory estimates use the complete
weights, rather than just the parameters active for one token. An engine update
can add format support but cannot increase the computer's memory.


Open **Settings → Local models**. It started as Models Fit Studio's screen and is now
part of zer0ne Code, run by zer0ne Engine: the **Models**, **Battle**, **Library** and
**Settings** tabs, with the same words and fit rule. It takes zer0ne Code's theme and
accent colour.

- **Models**: paste a Hugging Face link or `owner/model` and press **Check** for the
  verdict, the memory each version needs, its estimated speed and every file of the
  repository. Below it, the model list searches Hugging Face, rated for this computer;
  the **Fits this PC** switch leaves only models that run here, **Suggest** picks a few
  and **Refresh** reads the list from Hugging Face again.
- **Download this model** downloads into zer0ne Code's own models folder: the files are
  checked against Hugging Face, the vision projector and a draft head (an `mtp-` file
  that makes the model write faster) come with it. The model is then in **Providers &
  models** under **zer0ne Engine**, ready in the chat's model picker.
- **Library** lists the models on this computer, including those Models Fit Studio
  downloaded. **Run** loads a model in zer0ne Engine and opens a chat with it; **Measure
  speed** and **Test quality** keep their results for that model. Deleting a model takes
  it out of the model picker too.
- **Battle** compares up to four models on quality, speed, memory and context.
- **Settings** shows storage, the Hugging Face token and the engine. The folder cannot
  be moved here, and tray, start-up and theme options belong to the Windows app.

The last tab, **Engine & more**, has **Engine** (zer0ne Engine's options, the local
assistant, the Local Host router and other runtimes) and **Activity** (the engine's
state, the model loaded now, live speed and memory, downloads, and what is on this
computer). **Local models** at its left returns to the screen.

Image, video and voice models are in the chat's model menu: each **Local** group lists
the models on this computer and the ones that fit it, with a **Get** button.

Downloads check the actual model and vision-projector sizes and available disk space.
Leave the engine's context on **Auto** so it can shorten the context and fit the model
to available memory when loading. The engine reads GGUF architecture metadata, budgets
the model, vision projector and context cache against available memory, and adjusts CPU
threads and prompt batches. Integrated GPU memory is counted as shared RAM. Models too
large for this computer need a smaller quantisation or model. Downloads use one
repository revision, reject incomplete split files and verify each file's size and
Hugging Face checksum when available before enabling it.

**Engine** shows the controls needed for normal use. **Engine options** contains
build, context and performance settings. **Other runtimes & sharing** keeps
optional Ollama, LM Studio and local server connections together.
On first load, a synthetic speed check takes up to 45 seconds before chatting.
It measures first-token delay and generation speed and samples process RAM
(GPU usage is not measured). Results are saved for that model file, computer,
engine and settings. **Tested successfully** confirms the speed check completed;
**Fits memory** remains an estimate. Current fit checks still apply after a test.
Cancel the check in **Engine**, disable **Test speed on first load** in
**Engine options**, or use **Test speed again** after loading a model.
After loading a model, open **Engine → Tune for speed** while the
engine is idle. It times what an agent does, on a synthetic code prompt: the first
read of a long prompt, then a follow-up turn that adds a file to it. It tries each
setting the model can run with (threads, prompt batch, the attention mode, and the
processor alone when a graphics chip is in use) and keeps a change only when it is
faster overall and neither reading, writing nor the wait of a follow-up turn gets
worse. It can take several minutes. Chats wait during tuning; **Cancel tuning**
restores previous settings. Profiles apply to that model, machine, build and
context/cache configuration. Turbo Fit can use a 4-bit context cache when needed,
with a possible accuracy tradeoff. Speeds in the catalog are estimates until refined
by benchmarks or real chats.

On integrated graphics the attention mode matters and depends on the model. Qwen
models load with plain attention there, which read a long prompt up to twice as fast
on the laptop it was measured on; for other models the engine keeps its own choice
until **Tune for speed** has measured both.

Both apps rate memory fit, tell helper files apart, pick the recommended build and
mark the quality test by the same rules, against what the computer has.

Ratings do not change when another app takes memory: a check shows a warning instead
when less is free than the build needs. A build larger than fast memory that the
computer can still hold says **Runs slower**. On a graphics chip that shares system
memory that estimate is three quarters of the chip's speed, measured on one laptop
where the processor ran such a model faster than any split between the two.

zer0ne Engine includes llama.cpp and installs automatically when a model needs it.
Choosing Ollama installs its checksum-verified official portable runtime if necessary,
without an administrator or a system-wide installer. Downloads appear in Downloads
and can be cancelled. GGUF tensor support depends on the engine version and backend;
original Safetensors weights need conversion, and MLX is an Apple-specific runtime.
Large cloud models do not become laptop-compatible just because their API works.

**Activity** shows live system CPU and RAM and the main zer0ne Engine’s speed and
context when its metrics are available. **Local assistant**, under Engine, is optional: it routes
summaries, composer text edits and selected read-only research to an installed model.
Keep it off if another model would leave too little memory for your main chat.

**Local Host router**, under Engine and off until you turn it on, serves OpenAI-compatible and Anthropic-compatible
API for other harnesses. Turn it on, copy the base URL and generated API key, and test
the connection. Select an OpenAI-compatible provider in the other tool; use
`GET /v1/models` to list model IDs. `engine/model-id` loads a downloaded GGUF on demand;
`ollama/model-id` selects Ollama even when both backends have the same model name.
Chat Completions and Completions work with both backends. With a compatible zer0ne
Engine release, you can also use Responses, Anthropic Messages and their token-count
endpoints. Copy the OpenAI URL ending in `/v1`, or the Anthropic URL without `/v1`;
the same generated key works with either API. Engine requests queue while a model
is in use. Streams, tool calls, images and upstream errors pass through intact.
The router shows the loaded engine model’s actual context size. Match the other
tool’s context setting to it, and keep messages plus tool definitions within that
window. Token counting loads the selected model to use its real tokenizer.
`GET /v1/status` reports active, queued and attempted requests, the loaded model and
its actual context, and requires the key. Browser-blocked ports are refused.
It listens on this computer by default. Enable LAN only when another device needs
access, then copy that device’s LAN URL. Rotating the key requires updating it in
the connected harnesses.
The project serving the router stays alive while you switch projects or hide its
window. Turn the router off or quit the app to stop serving it.

## Workflows and subagents

Use **`/workflow`** in Full Access to choose worker and reviewer models. New workflows
start with two workers and an independent read-only review. Named coding workers
get separate Git branches and worktrees; open the repository root and make an
initial commit before using them. Uncommitted changes in your main checkout are
not copied into those worktrees. **Saved runs** in the Workflow menu replays a
previous run with new inputs, or continues from its report. Turn on **Main agent
only delegates** there to keep the main agent from running commands or editing:
every task goes to a worker, and you can keep talking to the chat while they work.

In **Work Details → Subagents**, select a task to see its activity, branch, folder
and report. Under **Changes**, choose **View diff**, then **Apply changes** or
**Discard worktree and changes**. Application requires an idle chat in Full Access
and records an Undo checkpoint. Conflicting or changed patches require a fresh
review. Send instructions while a worker runs; after a restart, tasks stay stopped
until you choose **Continue task** or **Resume task**. **Work Details → Worktrees**
lists every checkout; a card can remove it (the branch is kept) once no run or
agent is active, and asks before dropping uncommitted changes.

Task evidence for workflows and subagents separates work completion, independent review
and recorded checks. In the task's details, choose **Inspect evidence and execution history** to compare
the saved check snapshots with current project files and see commands, exit codes,
timestamps and tool outcomes. Subagent details offer the same action and list the
worker's allowed tools. Continuing a worker can narrow its tools but cannot expand
its saved permissions. A check proves only the commands listed in its receipt.

Use **`/compare`** or **Add → Compare models** in Full Access to run one task with
2–4 configured models that support tools. Each candidate starts from the same Git
commit in its own worktree; uncommitted project edits are not copied. Runs share
your task budget and use each provider's quota. Review reports, usage, recorded
checks and a candidate's diff, then apply one candidate when the chat and writers
are idle. Applying records an Undo checkpoint. Other candidates stay available
until you explicitly discard them, and reopening the app does not rerun them.

Execution history records tools run by zer0ne, including approvals and refusals;
provider-managed actions may be outside that history. Calls without a recorded
outcome may already have taken effect. Inspect current files and connected systems
before retrying. Reusing a recorded tool-call identity cannot execute it again.

The main agent handles your chat and can delegate focused tasks to subagents.
Use **Settings → Agent → Subagents** to enable delegation, choose specialists,
and set their models. General instructions and permissions live on the
**Behavior** tab; execution limits are under **Advanced execution & task limits**.

Open **Work Details → Subagents** to see the orchestrator, delegated agents and
their recorded tools in a live graph. Select an agent for activity, instructions,
recorded file previews and its report, or open **Tasks and controls** for the list.
You can send instructions to a running subagent or stop it individually. Task review labels
require explicit reviewer findings.

Side Chat's **Save last 6 exchanges** option keeps its conversation with the main
chat. Clear removes the saved helper conversation. Memory settings provides
archive/restore and capacity controls; saved facts used for a request appear in
that message's recall receipt. Pins are recalled first within a 12 KB budget.
With an embedding model configured, recall also matches similar meaning. Solutions
(a recurring problem and the fix that worked) are kept separately, and **Find similar**
offers near-duplicates for review — nothing is archived until you choose. Optional
automatic learning uses only the local helper model, never a cloud provider.

In **Settings → Hooks & Memory → Hooks**, test a saved command with sample JSON and inspect its
output and exit code. Mark a Stop hook as required to prevent successful completion
when validation fails. Hook history keeps the latest 50 executions for the running
project engine. Windows commands use PowerShell.

Provider generation and tool-call tests have separate dated results. The tool
test validates a synthetic call without executing it. Browser settings can test
launch and take a snapshot; **Work Details → Browser** shows the latest preview
and activity. Feature health describes the scope of each check, including cases
where only configuration or tool discovery has been verified.

MCP tools that publish an app offer **Open interactive app** in their message.
Apps run in isolated frames without access to the desktop bridge. Requested
network domains and tool actions ask for approval. Desktop chats and phone
Remote both show inline apps.

## Background work

**Settings → Features → Background work** controls the switches for work that runs
while you do something else:
- reports when a background command ends;
- a watchdog for stalled or looping agents;
- the `recall` tool;
- **CI and review events**, which needs the GitHub CLI signed in. It checks this
  branch's CI runs and pull request reviews against a policy you write in plain
  language. At first it only records what it would hand over; tick **Hand events
  to the agent** once that looks right. A comment that mentions `@zer0ne`, from you
  or a login you allow, goes to the agent directly.

## Chats, review and Side Chat

Expand a chat's **files changed** summary, then choose **Review hunks** to Keep, Undo or Redo individual
changed blocks. Hunk decisions preserve the original turn checkpoint and refuse
to overwrite later manual edits. Large blocks use the full-file Review and Undo.

Resize **Projects** and **Work Details** by dragging their inner edges or opening
the panel-size button in either header. Choose a width with the slider or presets;
double-click an edge to reset. A focused edge also accepts the arrow keys, with
Shift for larger steps. Your chosen sizes follow you between projects.

Select a passage in a chat and choose **Send to Side Chat**, or use **Side Chat**
in the session header. Ask questions and follow up in its floating window without
changing the main conversation or its draft. Choose an API or local model in the
Side Chat composer; subscription agents cannot run this separate helper. Side Chat
is temporary and clears when you switch sessions or reload. Large sessions use the
most recent context that fits the chosen model, with an indicator when older text
is omitted.

Right-click a message for **Send to Side Chat**, copy options, **Attach selection
as context**, **Pin as chapter**, and **Fork from here**. Attaching context keeps
your existing draft; Ctrl+Shift+L also attaches the selected passage. Chapters are
saved with the session and marked in the navigation rail. Forking opens a new
session with the history through that message and keeps the original session.

**Settings → General** separates Language, Interaction, Message stream, Dictation,
Notifications, Notch and Diagnostics into pages. It remembers the last page you
opened. Notch settings are available in the desktop app.

**General → Diagnostics → Profile backup & restore** saves chats, settings,
memories and checkpoints to a `.zcbackup` file. Project files, local model
downloads and caches are excluded. Keep backups private: they contain your
conversations and configuration. Saved sign-in files are excluded by default;
including them requires working OS-protected key storage, and restoring them
requires the same OS account. Phone pairing tokens are cleared. Restore keeps a
recovery copy under your profile’s `backups` folder. Both operations require idle
agents, terminals and shared services, and restart the app to finish.

Use **Search all settings** at the top of Settings to find a control across pages.
Select a result to open its page and highlight the control. Ctrl+F focuses Settings
search while Settings is open. Explorer file previews have clickable path breadcrumbs
that return you to a parent folder in the tree.

**Restore files** keeps the conversation and records which files changed. **Rewind in
new chat** restores the selected turn's file checkpoints and later changes, then creates
a conversation before that message. The original chat stays available. Commands and
connected-system effects remain. Rewind stops before changing files when a required
checkpoint is incomplete; persistent provider sessions restart with the retained context.

After a disconnect, the app checks command receipts instead of automatically sending
your prompt again. An uncertain outcome means you should inspect the saved chat and
execution history before submitting another action. Older messages load through
**Load older messages**. A browser tab with an incompatible protocol must be reloaded
or used with a compatible app version.
An accepted prompt can still be running; task evidence reports completion and checks.

## Appearance and transparency

With transparency enabled, Projects and Work Details use translucent frosted
surfaces. Windows blurs the desktop behind these panels independently, including
at **100% transparency**, while the conversation remains clear. **Blurry** keeps
its original role as an optional setting for the whole window. Other systems use
the panels' web backdrop effect.

In **Settings → Appearance → Terminal & shell**, choose a shell font size and line
height, cursor shape, blinking and screen-reader output. Open shells update immediately;
reduced motion keeps cursors still. The **Terminal** theme adds a warm palette, readable
tool results and a static background, with optional retro texture or a reading font for
long answers. Custom colors apply throughout; low-contrast choices offer a readable-text
adjustment. **Reset terminal** preserves your screen-reader preference.

## Terminal and project actions

**Work Details → Terminal** has **Commands**, **Shells**, and **Actions** tabs.
Commands runs one command at a time; Shells holds interactive sessions. The console
follows your theme and uses the panel's full height. Actions saves reusable project commands.
Save named commands such as Start app, Check project, or Prepare worktree under
Configure actions. You can import a `zer0ne.actions.json` array from the repository;
importing shows the commands for review and saves a local copy. Opening a repository
does not run its scripts. Each execution asks permission and shows its output and result.
Actions marked `prepareWorktree` finish before a new worktree task starts; a failed
preparation leaves the worktree available for inspection.

```json
[
  { "name": "Start app", "command": "npm run dev", "previewUrl": "http://localhost:3000" },
  { "name": "Check project", "command": "npm run check" },
  { "name": "Prepare worktree", "command": "npm ci", "prepareWorktree": true }
]
```

Interactive terminals support keyboard input, resizing, and up to six Windows shell
sessions. They run with your account's permissions and need Windows ConPTY and the
.NET Framework compiler. The Commands tab remains available. Select terminal
output and choose **Attach selection** to add up to 16,000 characters to your prompt.
Paired phones can view sessions; terminal input and session controls stay on the desktop.

## Computer Use

For Computer Use, choose a vision model, then open **Settings → Features →
Capabilities → Computer Use → Manage app permissions**. Enable it, allow an open
Windows app, and choose **Resume Computer Use**. The agent can select an allowed
window and capture it on the primary display. App permissions apply in Full access
too. Use **Stop** in the status control, or **Ctrl+Alt+Esc** when the permissions
panel shows that shortcut as available, to pause control across all projects.
Restarting the app or changing permissions requires Resume. Some apps cannot
provide window captures; use file or browser tools for those. These permissions
limit Computer Use's capture and input targets; actions inside an allowed app can
still affect files, websites and other apps.

A blue outline identifies the controlled window. Floating controls show the app
and current action, with **Pause** and **Stop** available over other apps. Moving
your mouse or typing hands control back to you; **Resume…** opens the permissions
panel so you can explicitly resume. The visuals follow light/dark mode and Windows'
reduced-motion preference. In the permissions panel, **Keep screenshots in chat**
is off by default. Enable it to save observations in the chat, then use **Review
screenshots** to inspect the latest eight. Turning it off stops new screenshots
from being saved; it does not remove images already in the chat.

## Features, benchmark and goals

**Settings → Features** shows Overview, searchable Capabilities, Checks & activity and
Benchmark. Check labels distinguish configuration, discovery, measured usage and execution
results. Opening the page inspects setup without generating model requests or running
project scripts.

**Benchmark** runs zer0ne's bundled coding tasks against up to four of your models and
grades each result with tests the agent never sees. Every task runs in its own temporary
folder; your projects are not opened. Inside those folders the agent runs commands without
asking, so a run needs Full Access and a confirmation, and it uses your quota. The scorecard
keeps results by model, profile and task set. Choose **Chat engine** to exercise the same
controller used by your chats, including this chat's worker workflow, with isolated storage,
external integrations and personal memories. This mode supports API-key and local providers;
**Core tools only** also supports signed-in accounts. Compare current settings, more reasoning,
less reasoning with core tools, and strict tool arguments, with 1–10 trials per task.
Reasoning levels apply only when supported; a workflow can override the main tool selection.
Temporary cases have no Git history, so isolated writing workers that require a committed
repository report that prerequisite; the main agent and read-only workers can run normally.
The results show task success, typical and slow response times, retries, cutoffs, tool failures,
reported cache reads/writes, and cost per success when prices are known. Warm/cold times are
observations, not a controlled speed test. A small sample does not establish a winner.
Completed chat-engine results with at least three trials on two tasks and 90% success can
save core/full tool selection for that model. Automatic selection uses this choice for 30 days;
changing the endpoint or context window invalidates it. Reasoning and cache settings stay under
your control in **Advanced model controls**. Supported official OpenAI models offer explicit
cache controls and 30-minute or 12-hour lifetimes; longer writes can cost more.
From a terminal, `npm run evals -- --production --profiles current,thorough --trials 3 --category bugfix --save`
runs the chat engine; omit `--production` for the core. The **judge** category
checks the `/goal` judge on each model: records of work that only looks finished, which it
must reject, and records of finished work, which it must accept.

**`/goal`** keeps the agent working until a judge confirms the goal from the evidence of the
work: `/goal the login page works --check "npm test" --rounds 10`. With `--check`, the goal
is met only when that command passes (it asks for permission like any command) and the judge
agrees. `/goal status` shows each round; `/goal off` stops it.

## Project checks

Enable **Project verification** and terminal commands, then choose **Preview run** to review
the detected check, lint, test and build stages. **Dependency audit** supports npm projects
with `package-lock.json`; it sends dependency metadata to your npm registry and applies no
fixes. Runs can be stopped, stop on a failed stage, and record a timestamp and project snapshot.
Snapshots exclude dependency/generated folders, symbolic links and deny paths. Enable
**Workspace watch** to mark changed results stale and refresh search context as files change.
It never runs scripts automatically.
The review shows how commands will be isolated. When an OS command sandbox is unavailable,
the approval button explicitly says **Run outside sandbox**.

**Code index** search covers project documentation as well as code: Markdown, plain text,
reStructuredText, AsciiDoc, Org, LaTeX, CSV and the text layer of PDFs join the same index.
Each result says whether it came from code or a document. The index is stored on this computer;
embeddings use the embedding model configured for the index.

For **Code intelligence**, configure an installed language-server executable and its JSON
argument array in Features. Test its connection before querying a project file. Supported
servers can provide diagnostics, definitions, references, hover and symbols. The server runs
locally with project access; the client rejects server-requested edits. Unsupported operations
are reported explicitly. The agent can use `project_code_intel` and semantic evidence in `impact`.

For **Browser regression checks**, enable the browser agent and save scenarios in
`.zer0ne/browser-checks.json`, for example:

```json
[
  {
    "name": "Home page",
    "url": "http://localhost:3000",
    "assertions": [
      { "kind": "text", "value": "Welcome" },
      { "kind": "selector", "value": "main" },
      { "kind": "no-console-errors", "value": "" }
    ]
  }
]
```

Start your app server separately, then preview the URLs and assertions before running them.
Checks use a separate browser profile, save screenshots and support text, title, URL, selector
and console-error assertions. The agent can use `project_verify`, `dependency_audit` and
`browser_regression` under the existing execution permissions. These tools require Agent or
Full access mode; read-only language queries are also available while planning.

## Command rules and sandbox

**Command rules** for a project live in `.zer0ne/command-rules`, one rule per line:

```text
allow: npm test        # runs without an approval card
ask:   git push*       # always asks, even in Full access
deny:  rm -rf *        # never runs
```

`*` matches anything. Deny wins over ask, and ask wins over allow. Deny and ask also match
any part of a chained, piped, backgrounded or substituted command; allow only applies to a
single simple command. Rules match the command text, so they cannot see what a script it
starts does.

The rules file comes with the repository, so its allow lines run nothing until you trust them
in **Settings → Agent → Project command rules**. A changed or new allow line waits for you
again. Deny and ask lines apply at once, and one you trusted keeps applying if the file later
drops it.
Agent commands start without environment variables that look like API keys, tokens or
passwords; turn off **Hide secrets from agent commands** in Settings → Agent when a command
needs one.

**Shortcuts:** Ctrl+Alt+Space (⌘⌥Space on macOS) opens the quick prompt from anywhere, and
Ctrl+F finds text in the open chat.

Windows agent commands run in
PowerShell. On Windows, choose **Prepare project** under Settings → Agent → Command
sandbox once per project: zer0ne gives the folder a write permission for that
project's own sandbox ID, and sandboxed commands then run with a write-restricted
token that can change files only in the project and its sandbox temp folder. They can
still read files and reach the network; Git uses its OpenSSL backend inside the
sandbox. **Remove sandbox access** takes the permission away again. Until a project
is prepared, Command sandbox Auto or Always makes Agent mode ask for approval before
running outside the sandbox, including automatic verification and background
commands. Command allowlists and automatic approval do not bypass this prompt. Full
access mode and Sandbox Off keep the unrestricted execution you have selected.

## Mobile remote

**Settings → Mobile remote** turns the project into a small web app for your
phone: scan the QR code with the camera or type the 6-digit pairing code. Pick
how the phone reaches this computer — **Same Wi-Fi**, **Anywhere** (a Cloudflare
secure link), **Tailscale**, or your own SSH tunnel — and the page shows which
one is live.

The phone gets its own layout: Projects and **Work Details** open as full-screen
sheets, the top bar keeps only the project list, the chat title, a new chat and a
**⋯** menu (history, Work details, Side chat, phone alerts, settings), approvals
and questions use thumb-sized buttons, and the composer can attach a photo or a
small text file. **Phone alerts** in ⋯ asks the browser for notification
permission; the screen stays awake while the agent runs and the phone buzzes
when it needs you. If the link drops, a *Reconnecting…* pill says so and the
page reconnects as soon as you return to it. When the agent publishes an
artifact, an eye appears in the top bar and opens that page full screen, with the
same sandbox the desktop preview gets.

Every phone that pairs gets its own session, listed under **Paired phones** with
its name, address and last activity, and **Sign out** ends just that phone. A
signed-out phone has to pair again — even if it still has its old link — and
**New link** signs out every phone at once. With push alerts on, an approval
notification carries **Approve** and **Reject** buttons that work straight from
the lock screen while Remote is reachable.

## Your data

Your data lives in `%APPDATA%\zer0ne Code` (`data\` for chats and settings, `logs\engine.log`
for the engine log). API keys are encrypted with a key protected by Windows. Set
`ZER0NE_DATA_DIR` to keep everything in one folder instead.
