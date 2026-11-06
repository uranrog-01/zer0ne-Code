# Changelog

## Unreleased

- Settings → **Features** is one grouped list: each feature has a plain description, a switch and, where it has more settings, a Configure link. A summary shows how many are on and what needs your attention, filters show On, Off, Needs attention or Advanced, and extra options appear only once a feature is on. Checks and project runs have their own tab; local language server, code index and browser check files sit under Advanced setup.
- When Computer Use can't act because no app is allowed or it is paused, the chat now says which of the two is missing, and its Next step button opens Computer Use permissions instead of Browser settings.
- **Browser & Computer Use**: Computer Use settings (on/off, Design cursor effects, screenshot history and app permissions) are now on the browser page, renamed Browser & Computer Use in the desktop app.

- Computer Use permissions have a **Design cursor effects** switch, off by default (off keeps the classic outline and pointer). On, one design-tool cursor replaces the outline: it redraws the controlled window with boxes, size badges, rulers, a guide and typed text, redraws only what changed after each action, and marks each click with the element's box and size. A bar on the window names the app and keeps Pause and Stop. Each action waits until its cursor is on screen. The effects are never in the model's screenshots, and reduced motion or high contrast keeps the classic outline.

## 0.3.0

- Security: with **Hide secrets from agent commands** on, agent commands and helper processes no longer receive Git's `GIT_CONFIG_COUNT` / `GIT_CONFIG_VALUE_<n>` variables after their `GIT_CONFIG_KEY_<n>` names were removed. A value such as an `http.extraheader` authorization header was passed through, and every `git` command failed with "missing config key".
- **Windows installer**: `zer0ne-Code-Setup-<version>.exe` installs per user without an administrator prompt (all users on request, in `C:\Program Files\zer0ne\zer0ne Code`), adds desktop and Start Menu shortcuts (in a **zer0ne** folder), shows the license and stops while the app is running. It wraps the validated build unchanged, ships with a SHA-256 checksum, and signed releases sign the installer and uninstaller. Uninstalling keeps your chats, settings and keys.
- Settings no longer refer to VS Code where the desktop app does something else: API keys are described as encrypted with a key your operating system protects, the default UI font is called System, and the About credits drop the retired Model Finder and Model Intelligence entries.
- Installed benchmark tasks and judge records are now covered by the app's runtime integrity checks, so modified or added evaluation data is refused.
- zer0ne Code is now open source under the MIT License. Builds from the public source show the welcome screen without its Filament animation.
- The browser agent waits up to a minute for a browser's first start, so a slow start no longer fails with a DevTools connection error.
- **Show Files** on a project that is still starting keeps Work Details open instead of closing it as the Projects panel opens.
- Chats preserve native reasoning across turns, use each model’s advertised response allowance, and automatically continue a cut-off answer within a bounded retry allowance. Cache usage includes write tokens and changes to reasoning settings; compaction preserves the request’s reasoning profile.
- Agent benchmarks can compare repeated reasoning/tool profiles using the actual chat engine, with task success, latency, retries, cutoffs, cache activity and cost per success. Eligible results can supply a model’s tool profile. Advanced controls expose strict tool arguments and supported OpenAI cache lifetimes.

- Cancelling idle cache warming now stops its request, and a late response from an older refresh can no longer update another chat or cancel its newer refresh schedule.

- Chat sessions jump to the latest message when you send or retry, follow replies as they arrive through layout changes, and return to the bottom when an answer finishes.

- Windows Computer Use now outlines the controlled app, shows an agent pointer and action hints, and keeps floating Pause/Stop controls visible. Physical mouse or keyboard input pauses control with an explicit handoff. Optional screenshot history lets you review the latest eight observations in the chat.

- Permanently removed the retired Mods, Model Finder/Analysis, CLI installer panel, bot channels, and old scheduled-task implementations from the app and source.

- The window stays opaque at 0% transparency, and raising or lowering transparency swaps it in place without reloading the project page. The start page's and the notch's renderers are released while they are not shown, a quiet project retires early when the machine runs short of RAM, and Calm motion now also stops the welcome 3D preview and animated background.

- Reduced idle CPU use by letting the app's freeze detector sleep between checks, and corrected its diagnostic profiling.

- **History reads like a library**: the chat list opens as a file manager — a thin rail, a project sidebar with just **two views**, a row of project folders with paper-stuffed artwork, and a table underneath. **All chats** is every folder's chats in one list, grouped by folder, with archived chats still listed and marked; **Pinned** gathers the pinned ones. Selecting a folder shows only that folder's chats, and picking one opens that project at that chat. Drag a chat onto a folder, or use the selection bar, to file it, with one-step Undo.
- **Long commands no longer hold the chat**: a command the agent runs that is still going after 20 seconds moves to the background on its own and keeps its time limit. The agent keeps working or ends its turn, and how the command ended arrives by itself. This needs Command reports; scheduled tasks and workers are unchanged.
- **Agents report how their work ended**: every subagent ends with a status, one of ready, blocked, failed, or dropped when there was nothing to do. A report that found nothing to do no longer interrupts you, and a decision the agent needs reaches you as one question, asked as written. The agent monitor shows "Nothing to do", "Blocked" or "Needs your answer".
- **Ask the agent on GitHub**: with CI and review events on, a pull request comment that mentions `@zer0ne` (you can change the word) is a direct request when it is yours or from a login you allow. It goes to the agent at once, even in observe mode, without the policy check. A mention from anyone else, or from a bot, is ignored.
- **Command reports**: when a background command such as a long build or test run ends on its own, the agent is told how it ended, with the last lines of its output. If the chat is idle, a short follow-up turn reads the result, so the agent can keep working instead of checking on the command. Commands you stop are not reported. Settings → Features → Background work.
- **Main agent only delegates**: a new Workflow option. The main agent loses its command and editing tools, hands every task to a worker, and stays free to answer you while the workers run.
- **Agent watchdog**: a subagent that repeats the same call with the same result three times is nudged once. If it keeps going, or finishes no step for 10 minutes (adjustable), the main agent is told. The monitor marks such agents as Repeating itself or Stalled. An optional, advanced **Drift check** asks the chat model every ten minutes whether each background agent is still on task. The main agent only gets its doubts as a suggestion; nothing is changed on its own.
- New **recall** tool: notices now carry ids for agents, background commands, conversations and events, and the main agent can follow them one step at a time, for example from a comment to its pull request to the agent that owns it. `recall list` shows what the chat has. Output read from a background command is saved in full when Token Saver shortens it.
- **Conversation routing** for Telegram and Discord: reply to a message to continue its conversation. Replies in a conversation that a running background agent owns go straight to that agent, and its answer comes back to the same conversation.
- **Short phone replies**: answers sent to Telegram or Discord lead with the conclusion and are cut to about 100 words. The full answer stays in the chat.
- CI and review events now start in **observe** mode: what your policy would hand to the agent is only recorded (`recall list` shows it) until you tick **Hand events to the agent**. Runs, reviews and comments on a pull request that a running agent owns go straight to that agent, bots and passing runs included. Events waiting together are checked in one model call that also sees their conversation so far. A message in a conversation whose agent already finished points the main agent at resuming it. A message passed straight to a working agent tells it to hand back anything outside its task. In the Workflow's delegate-only mode, the main agent no longer waits on reports and passes on your own words instead of writing plans.
- **CI and review events** (off by default): zer0ne checks this branch's CI runs and pull request reviews with the GitHub CLI. Your own comments, bots, passing runs and approvals without comments are dropped. The rest are checked against a policy you write in plain language, and only the events it asks for reach the agent. The first check only notes what already exists, the agent sees event text as untrusted, and every action still needs your usual approvals.
- Providers & models blocks saving API keys to public HTTP endpoints, preserves model edits and toggles during refreshes, and keeps every key when duplicating an API provider. Subscription copies ask for their own sign-in so the original login keeps working.
- The Remote shortcut in the sidebar footer is now a compact icon button without text, matching AI Dock and Notifications.
- Renamed the Notch shortcut and General Settings section to AI Dock in the user interface.

- **Side Chat's wait is one quiet line**: while it answers, the current phase slides in as it changes beside an elapsed clock and a hairline of progress, and the line settles into a done, failed or stopped receipt when the answer ends. Motion holds still when the system asks for reduced motion.
- **Start without an API key**: the welcome screen now offers a guided first run. It offers the local models that fit this computer (with size, context and a fits/tight badge), downloads the chosen one in the background, makes it the selected model, and then offers a project folder and a small first task whose changes appear as a diff with Undo. A wrong API key is refused before a provider is added; skipping is remembered.
- A working chat in the Projects panel shows a light that travels around its button. The light holds still when motion is reduced, and the button keeps the current theme in light and dark.
- The sidebar footer replaces Side Chat with a Notch shortcut that opens its settings.
- The agent can answer a running command: **command_input** writes to a background command's stdin (sign-in flows, scaffolders, REPLs), and the Windows job supervisor forwards stdin instead of closing it.
- **AGENTS.md in a monorepo**: a package opened on its own also reads the repository's AGENTS.md chain, and `AGENTS.override.md` replaces the shared file locally.
- **Command rules can say why**: `ask: git push* # review before pushing` shows its reason on the approval card, and a `deny:` reason appears in the refusal.
- New **context_remaining** tool: the agent can check how much of the context window is left before a costly read.
- **Sandbox reads can be restricted**: Settings → Agent → “Paths commands cannot read” (`~` is your home folder) is enforced by the macOS/Linux sandbox profile and, on Windows, by a deny entry for the project's sandbox ID (prepare the project again after changing it). A **Use recommended list** button fills in the common credential folders, the app's own keys, settings, chats and checkpoints are always blocked, and the status line says plainly whether reads are restricted and whether a Windows project needs preparing again.
- Desktop clicks no longer hit the phone-sized request limit during bursts of settings changes, state saves and panel refreshes. Desktop traffic keeps its own bounded request budget.
- Image generation: the agent has an opt-in **image_generate** tool (Settings → Features → Image generation). One image per prompt, made by an installed Studio image model or an image-capable provider (`provider/model`), saved in the project under `images/` and shown under the call. Every call is approved first; Stop cancels the generation.
- Saved workflow runs are reachable again: the Workflow menu has **Saved runs**, where a run can be replayed with new inputs or continued from its previous report. The dialog had shipped without an entry point.
- Branching a chat into a worktree keeps that chat's workflow, says the checkout starts from the latest commit with uncommitted changes left behind, and removes the new checkout if the branch cannot be created.
- Work Details → Worktrees can remove a checkout from its card (the branch is kept), asks before dropping uncommitted changes, and refuses removal of the main or a locked checkout. New worktrees are created beside the main repository even from inside another checkout, and a checkout whose folder was deleted outside Git can still be removed from the list.
- Workflow review only covers the workers this turn started; an earlier turn's uncollected worker no longer blocks the review or enters its prompt.
- Turning off Full Access or Subagents no longer switches the workflow off in every chat; a run still refuses to start without them, and each chat keeps its saved team.
- Worktree dirty checks report a Git failure instead of treating the checkout as clean.
- Cloud tasks explains missing GitHub repository and model requirements, links to project and provider setup, and enables running only after the API key secret is confirmed. Task updates keep setup checks, and Check again refreshes them from GitHub.
- Chat response footers keep actions, time and usage without the provider/account and model label. Branch in new chat now offers the current workspace or a new Git worktree, carrying the conversation into the selected project.
- Fixed the system tray menu's unresponsive buttons, including Show, New window, Open project, Quick prompt, Agent notch, Open logs and Quit.
- The loading and startup-error page now uses your saved theme, accent and custom colours before the window appears, including when Windows uses a different light/dark mode.
- Subagent monitor: steering instructions now carry honest delivery receipts — Queued while the agent has not reached its next step, **Read** once it took them into its transcript, and **Not read** when a run ended before it could, instead of every instruction claiming "queued for the next step". The pane's rows show live steps, streamed tokens and elapsed time per agent, refreshed every second; the details view lists each instruction with its receipt.
- Side Chat redesign: a dark glass card with a light-catching rim, docked beside the message box (light in light themes). A glass orb speaks for it — Pearl or Ember (More → Orb) — and while it thinks the orb splits into two drifting bubbles, "Thinking…" shimmers and light leaks in at the card's left edge beside it. Look-ups appear as a timeline — each step, the source it used and what it found — then "Writing the answer", and the newest lines fade in as they arrive. It greets you with four suggested questions; the header is just the orb, the name and the chat it follows, with the model, Sources, More and Close appearing when you point at it; and the composer is one glass pill with the microphone and a round send button.
- Side Chat answers can be sent to the agent (click twice; it goes to the session as your next message, after its current step if it is working), saved to memory, copied or added to your message box as a draft.
- Side Chat voice input: the microphone in its composer uses the app's dictation and fills Side Chat's question instead of your message box.
- Ask Side Chat about a change: each file in Work Details → Changes has an Ask Side Chat button that opens Side Chat on that file with the diff look-up on.
- Side Chat session alerts: it notes when the session is waiting for you, fails or finishes, offers Explain the failure or Summarize what it did, and marks its sidebar button when it is closed and the session needs you. More → Session alerts turns this off.
- Side Chat follows your sessions: the header names the chat it reads and shows when that chat is working, switching chats keeps the panel open and loads that chat's own Side Chat, and conversations are saved with each chat by default (More → Save with session turns it off). Reloading the window brings your Side Chat back.
- Side Chat fixes: errors show under the question with a Retry that replaces the failed turn instead of repeating it; a stopped answer keeps its text so you can ask it to continue; saved questions no longer show "Question:" labels; New conversation no longer turns off saving; one device's Side Chat no longer pushes another device's saved turns out.
- Brand: the notch, tray popup and quick window now show the new metallic Z7 mark, matching the app icon, instead of the old flat Z.
- Agent notch: act without opening zer0ne. Each new part has its own switch in Settings → Notch.
  - **Approve & answer**: an approval shows the exact command, whether it runs in the sandbox and what the project's rules say, with Approve, Reject and **Never run it**, which also adds a deny rule. An agent's question shows its answers, or you can type one.
  - **Stop & reply**: a running row has Stop and **Reply…**, which tells the agent something without opening the chat.
  - **Drop & ask**: drop files, images or text on the pinned notch, or use what you copied, and ask about it. It goes to the project you were last in.
  - **Live health** on a running row: checks passing or failing, files changed, and how full the context is.
  - **Next steps** on a finished run: Review changes, Check it, Undo (click twice) and Continue.
  - **Pin & keyboard**: the pin keeps the notch open; ↑ ↓ choose a run, A approves, R rejects, S stops, Enter opens, Esc unpins.
  - **Discreet while presenting**: during a slide show or Windows presentation mode, the notch shows no project names, commands or files, and leaves screen captures.
  - The notch now sits on the display you use (or the primary display), follows Settings → Appearance → Calm motion, and can chime softly when an approval waits or a run fails.
- Computer Use has a new app-permissions panel with a searchable app picker, saved permissions and a live status control. Windows captures only an allowed app window and refuses input outside it, including in Full access. Stop pauses control across projects; Ctrl+Alt+Esc also stops it when available. Restarting or changing app permissions requires Resume. macOS/Linux control is unavailable until it can enforce the same app permissions.
- Agent notch: over other windows its line is now a small black tab like Nusa's (72 × 6, sides tapering in, no shadow), and it opens only when the pointer touches it. Passing near it, such as reaching for a browser tab, no longer opens the panel.
- Computer Use coordinates desktop actions across project engines and rejects screenshots made stale by another project. On Windows, approved input returns to the screenshot's original window and refuses closed or changed targets. Typing preserves CR and CRLF line breaks.

- Security: agents from other makers running inside zer0ne (Claude Code, Codex, OpenCode and other ACP agents) now follow the project's command rules: a `deny:` command is refused and an `ask:` command shows a card even in Full access. Before, those rules applied only to zer0ne's own agent.
- Old tool output dropped to save context is kept in `.zer0ne/spill/` (git-ignored, cleared after a week), and the agent reads it from there instead of running the tool again. A failed call keeps its start and end in context, so the agent does not repeat the mistake. Long command output is saved there with Token Saver off too.
- MCP: zer0ne speaks protocol version 2025-11-25. Tools that run as tasks are started, polled and collected, so a long job is no longer cut off at two minutes, and stopping cancels it on the server. Tool schemas written in JSON Schema 2020-12 (`$defs`, `$ref`) work with every model provider.
- Auto compaction also starts at a token ceiling (200k by default, set next to the percentage in Settings → Features): a model with a huge context window no longer waits until 800k tokens.
- A rejected command offers **Always ask for …** and **Never run it**, which add the line to the project's `.zer0ne/command-rules`. On the Memory page, a memory can be added to the project's `AGENTS.md` under "Learned from corrections", so every agent and teammate follows it.
- Memory page: **Forget what this chat taught** deletes every memory one chat saved, including ones learned automatically (for example after it read a misleading page). Memories you added yourself stay.
- Benchmark: a **Judge** column checks the goal judge on each model against 13 records of work with known answers: 10 that only look finished (tests never run, a failing build called done, half the goal, a test deleted, a planted "mark it met") and 3 that are really done.
- The tray's right-click menu is now a floating Liquid Glass panel in the app's own style, anchored above the tray icon: Show, New window, Open project…, the Quick prompt and Agent notch shortcuts, Open logs and Quit. Keyboard and Escape work, and the tooltip shows running agents.
- The tray icon itself now shows what is happening: an amber dot while a run waits for you, green while agents run, blue when notifications are unread — nothing when all is quiet.
- Quick prompt plays its motion: a springy entrance on every open, a one-shot gradient sweep across the frame while you type, a green check and glow when a prompt is sent (the panel then closes itself), and a small shake when a send fails. Reduced-motion settings turn it all off.
- Appearance follows system light/dark changes on desktop. Rapid colour edits are saved together, Reset cancels pending edits, and changing only the code font size reveals Reset. Terminal help reflects the current composer controls.
- Restored the previous compact Side Chat appearance. Its model menu stays within narrow panels.

- Project rows keep only New Chat, Delete and a **…** menu. Show Files, Rename, Pin/Unpin and Remove from List are grouped in that menu, leaving more room for project names.

- Work Details → Changes and Worktrees have redesigned headers, summaries, file and checkout cards, clearer Git setup messages, and responsive file comparisons. Clipboard failures now report an error instead of marking a worktree path as copied.
- Security: a project's **command rules** can no longer be slipped past with `&`, `$(…)`, backticks, PowerShell `(…)` / `@(…)` / `{…}`, quotes, `.exe` or wrappers such as `cmd /c` and `powershell -Command`; deny and ask match each of those parts. The command allowlist and allow rules never cover a command with a PowerShell `(…)` argument.
- Security: `allow:` lines in a project's `.zer0ne/command-rules` come with the repository, so they apply only after you trust them in Settings → Agent → Project command rules, and again after any change. Deny and ask lines apply at once, and a trusted deny or ask line keeps applying if the file drops it. An approval card says when an untrusted allow line would have covered the command.
- Security: `web_fetch` reaches local and private addresses (localhost, your network, cloud metadata) only on a site you shared in the chat, and checks every redirect again.
- Project folders have a **Show Files** button that opens their file explorer in Work Details, switching to the selected project when needed.

- Projects replaces the panel-size button with Archive / History, confirms project-folder and chat deletion with Yes / No, and lets you rename projects and pin them to the top. Project names and pins are saved across restarts.

- The model picker is larger and opaque even with Liquid Glass enabled. Its shortcuts show only starred Favorites, and the repeated current-model footer is removed.
- Project pages can finish opening when Windows suspends timers and painting in their offscreen view.
- Settings combines Hooks and Memory under **Hooks & Memory**, with tabs for each. Existing links and search results open the corresponding tab; switching tabs preserves an unsaved memory draft.

- Terminal Theme no longer repeats the access mode, project, model and usage beneath the chat box.
- Agent benchmark: Settings → Features → Benchmark runs 37 coding tasks (bug fixes, features, refactors, finding code, staying in scope, terminal work) against up to four of your models in throwaway folders. Hidden tests grade each result, and a scorecard compares pass rate, steps, time, tokens, cache share and cost. `npm run evals` gains `--category` and `--save`.
- Windows command sandbox: prepare a project once in Settings → Agent, and sandboxed commands run with a write-restricted token that can change files only in that project and its own temp folder — not other projects or your user folder. The network stays reachable, and Git uses OpenSSL inside the sandbox. Remove sandbox access undoes the folder permission.
- Goal mode takes an acceptance check and a round count: `/goal <done looks like> --check "npm test" --rounds 10`. The goal is met only when the check passes and the judge agrees; `/goal status` shows each round, and the status panel and notch show rounds used.
- Repository map: the agent starts each task with a compact map of the project's folders, key files and main symbols, about 1,000 tokens that stay cached (Settings → Features → Repository map).
- The on-demand tool list groups tool families onto one line, sending about 700 fewer tokens with every request.
- Compare models recommends a candidate once all runs stop, when it finished with every recorded check passing (cheapest, then smallest change). Applying still needs your review.
- General → Diagnostics can send each turn as an OpenTelemetry trace to your own collector: requests, tools, timings and token counts, never prompts, replies or file contents.
- The notch's cost meter shows the share of input served from the prompt cache.
- The chat's status panel shows a run timeline: Plan, Work, Check, Review and Done.
- Settings view (General → Interaction): Simple keeps the essential pages in the Settings rail; search still finds every setting.
- Appearance → Motion: Calm keeps animation for what is running or changing and stops decorative loops.

- One-shot headless runs: `npm run agent -- --project <folder> --prompt "task"` (or `--stdin`) runs a whole agent turn from a terminal and answers with the result — `--json` for a machine-readable report, `--timeout-sec` as a wall-clock budget, exit code 0/1/2 for completed/failed/stopped.
- zer0ne as an MCP server: `npm run mcp` speaks Model Context Protocol over stdio, so Claude Code, Codex and other MCP clients can delegate coding work with one `zer0ne_prompt` tool call. Each call is an isolated headless run in the folder the client names.
- Settings → Agent → Browser hosts: an allow-list (one host per line, subdomains included) for what the agent's browser may open; empty means any host as before.
- Agent commands gain git: `git_stage`, `git_commit` (staged-only or `all`, message via file, never pushes) and `git_branch` (create/switch/list), each user-approved like other writes.
- Agents in a chat share a task board: the lead and its subagents post, claim, complete and reopen tasks with `task_board` instead of duplicating work.
- MCP servers that expose resources or prompts are fully usable: `mcp_resources` lists and reads them, `mcp_prompts` lists and renders a server's prompt templates.
- Models can be asked for JSON replies: requests support `response_format` (JSON or a named JSON Schema) on OpenAI-format and Gemini providers, retiring the field automatically on servers that refuse it.
- Agent hooks cover the whole lifecycle: `SessionStart`, `SessionEnd`, `Notification`, `PreCompact`, `SubagentStart` and `SubagentStop` join the existing four events; SessionStart output joins the first prompt like UserPromptSubmit's.
- grep gains output modes (`files`, `count`), before/after context lines, case sensitivity and literal search, in both the chat tool and the core tool.
- Binary files a turn produces (images, archives) are checkpointed by content hash and restored as bytes by Undo and Restore, instead of being silently unrestorable; hunk review explains the limit.
- `ZER0NE_TRACE_DIR=<folder>` writes one JSONL trace per agent turn (requests with usage, tools, steering, outcome) for post-hoc debugging.
- Behavioral evals: `npm run evals -- --list` runs scripted agent tasks in throwaway project folders against a configured model and grades the results (files changed, reply, tool budget, steps). The harness itself is unit-tested offline.

- Terminal has a consistent warm palette, readable tool results, clearer status information and optional retro texture or reading-font answers. Custom light colors apply to prompts, replies and Git panels; Appearance can browse other themes while Terminal is active and offers a readable-text adjustment for low-contrast palettes.
- Appearance includes shell font size and line height, cursor shape and blinking, screen-reader output and a terminal reset. Open shells update immediately, follow reduced motion, and use coordinated ANSI and selection colors. Terminal new chats keep a static background without starting the animated scene.
- Features navigation wraps in narrow windows and on paired phones, keeping the Benchmark tab within the page.

- General → Diagnostics can back up and restore chats, settings, memories and checkpoints, with a recovery copy before restore. Saved sign-ins are optional and checked against the OS account; models, project files and caches are excluded. The app restarts after a backup or restore.
- Packaged app code has archive integrity checks, and the external engine runtime is checked for changes before startup. Public-release builds require configured code signing.
- Background project terminals keep their last usable size while their page is hidden.

- Settings has global search with keyboard selection, direct page navigation and highlighted controls; compact navigation keeps labels when space permits.
- Shared theme surfaces, fonts, readable secondary text, larger controls and focus indicators unify chat, Settings, Side Chat and file review. Chat change summaries sit closer to their answer.
- Work Details labels frequent tabs in wider panels, and file previews have clickable path breadcrumbs. New chats show starting prompts before activity statistics are available.
- Failed responses, commands and connected tools show consistent next-step guidance with links to the relevant settings or work panel. Existing results remain visible for review before retrying.
- Expanding chat details updates only the affected turn, preserving unrelated content and controls during long sessions. Interaction transitions use shared timings and honor reduced motion.

- The packaged app includes the Cloud task host and setup templates required by desktop settings, preventing a startup failure from missing files.

- The notch tells you what a run is worth your attention for, each part optional in Settings → Notch → Run insights:
  - **Looks stuck:** a run that fails the same step three times, repeats one step, or makes no progress for 5 minutes turns amber, also while zer0ne is in front.
  - **What changed:** a finished run shows the files and lines it changed, whether its checks passed and the Workflow review, with **Open changes** to go straight to its changes.
  - **Workers & cloud:** a Workflow's workers appear as dots with the review's state. The project's cloud tasks are followed on GitHub even with Settings closed, and a finished one is a notification with **Open pull request**. A project stays open while its cloud tasks run.
  - **Cost meter:** a run's spend against its task budget, with a warning at 80%.
  - **Ctrl+Alt+Z** opens the notch from any app; pressing it again opens what needs you most.
  - **Hide from screen sharing** (off by default) leaves the notch out of screenshots, recordings and shared screens.
- Cloud tasks are back in the desktop app: Settings → Cloud tasks, **Local → Cloud task** under the composer and `/cloud <task>` send a task to a GitHub Actions VM that works on its own branch and opens a pull request. GitHub sign-in uses the gh CLI or a token kept in your system's key store.
- The Workflow chip under the composer is slimmer: a quiet label while off, and an accent pill with a status dot while on that breathes while the workflow runs. The details are in its tooltip.
- Chat shows a compact file-change summary with Review and Undo, expanding only when opened. Reads, searches and routine commands stay in the work history; declared external actions have a separate summary with their results and failures.

- General settings has separate Language, Interaction, Message stream, Dictation, Notifications, Notch and Diagnostics pages, and remembers the page you last opened.
- Stopping a coding-plan agent during session startup is reported as cancelled rather than failed.

- Work Details → Terminal has a classic console layout with Commands, Shells and Actions tabs, theme-matched colors, clearer controls, and smoother terminal resizing and output. Refreshing a live shell preserves its selection and scroll position.

- Git tools and their changes popover stay anchored to the chat column when Work Details opens or resizes.
- Work Details Explorer has a workspace header, file-type icons, folder counts, clearer search results, an Edited filter, collapse/refresh controls and keyboard tree navigation. File previews use a stacked layout in narrow panels and a split layout in wider ones.

- The notch: a Dynamic Island–style pill at the top of the screen for your agents. While zer0ne is in the background it rests with your unread count; it shows each project thinking, writing or running a step (with its plan progress and step count), opens by itself when a run needs your approval, and shows when a run finishes or fails. It steps aside while a zer0ne window is in front, unless another project needs you; over another app's window it shrinks to a thin line you hover to open (approvals and results still pop out), and during full-screen apps only an approval shows, as an amber line. Hover it for every project and your recent notifications, which share their read state with the bell; opening a project reads its notifications. Settings → Notch has a live preview on screen, when to show it, a thin line or small pill over other windows, stepping aside for full-screen apps, which phases, and whether alerts also go to Windows notifications; the bell's panel has a Notch switch too. Options around the runs: keep the computer awake while agents run (on by default, works with the notch off too); Windows activity on the notch (a low battery or a lost connection while agents run, the microphone while you dictate); and a welcome-back briefing of what finished, failed or needs you after you have been away.
- Worker commands follow the original project's command rules and report their actual execution result. Background commands belong to their chat and agent, and failed commands or scripts stay marked as failures even when they produced output.
- Script tools match desktop capabilities and enabled features. Oversized worker and review requests are checked before sending, with instructions for resolving context limits; Git and search failures include clearer diagnostics.
- Windows command supervision also covers commands without a sandbox and keeps launched GUI processes cancellable after their shell exits, including background commands.
- Agent shell commands on Windows run through a compiled job supervisor: the command's whole process tree ends even when the engine dies mid-run, and an approved command cannot be reused for different text or executed twice.
- Command approval cards offer "Always run this command" for the rest of the session — the exact command only, never for outside-the-sandbox or ask-ruled commands; switching chats clears the grants.
- The app writes what blocked its main process (stalls over a second, with the busiest functions) to logs/stalls.log, and wallpaper reads moved to a utility process so page loads cannot hitch on registry reads.
- Skills can declare `tier: always` to keep their description at the head of the prompt catalog when the budget gets tight.
- Project pages can acknowledge readiness and window settings can cross the bridge without being incorrectly rejected for missing project-creation fields.
- Opening a project from a development launch works when Electron switches precede the app directory, and the app repository can still be opened as an explicitly selected project.

- Agent completion notifications wait for the saved result; empty model replies are failures, and timed-out checks cannot appear as passed.
- Secret masking now covers approval results and automatic-check feedback. Agent commands also hide bare token and authorization environment variables, and command directories are checked again after approval.
- Failed editor reviews and project-action display errors release pending work so they cannot leave a task or shutdown waiting indefinitely.
- Isolated writers honor the command-secret setting, and commands started through the shared agent tools stop when their owning task is cancelled.
- Windows command supervision closes unused pipes and drains output, so completed checks do not wait for their timeout or lose their final output.

- Chat responses now reveal new Markdown blocks with a soft blur-and-rise effect and an accent caret. Finished blocks, text selection and code controls stay stable while new text streams; partial formatting is held until it can render cleanly, and reduced-motion preferences are respected.

- Security: the packaged app ignores `NODE_OPTIONS` and `--inspect` and encrypts its browser cookies with your Windows account. The engine trusts the operating system's certificates itself (where company proxies install theirs), and still reads an extra bundle named by `NODE_EXTRA_CA_CERTS`.
- The bundled model advisor runs only when it matches its shipped SHA-256 checksum.
- Agent commands start without environment variables that look like API keys, tokens or passwords (Settings → Agent → Hide secrets from agent commands; on by default).
- Per-project command rules in `.zer0ne/command-rules`: `allow:` runs a command without a card, `ask:` always asks (even in Full access), `deny:` never runs it, checked against every part of a chained command. The approval card says when a rule asked.
- Quick prompt: Ctrl+Alt+Space (⌘⌥Space on macOS) or the tray opens a floating prompt from anywhere; Enter sends it to the project you used last.
- Find in chat: Ctrl+F highlights every match in the conversation, with a count; Enter and Shift+Enter step through them and new messages are searched as they arrive.
- After an update, a What's new card shows that version's release notes once.
- run_script can keep a per-chat REPL (`keep: true`): its `state` object survives between runs for 10 idle minutes.
- A recording workflow shows a floating pill with its time while its dialog is closed; click it to reopen the recorder.
- Chat page freezes longer than a second are written to the engine log.
- Chat reads like a message thread: answers are flat prose with tighter type and a block caret at the tail while they stream, your prompts sit in a quiet rounded bubble with one clipped corner, inline code is a hairline chip, table heads are mono uppercase with tabular figures, and code blocks keep their controls under a mono header that marks "· writing" until the closing fence arrives.
- Browser clients negotiate compatibility, check durable receipts for submitted prompts and controls, and recover missed updates after reconnecting without automatically resubmitting actions.
- Chat updates send changed state fields and load older conversation messages on request; reconnect status stays visible until state catches up.
- Work Details → Terminal includes reusable project actions, reviewed setup commands for new worktrees, and Windows interactive terminal sessions with selected-output attachments. Phone terminal sessions are view-only.
- File restoration records the changed workspace in the conversation. Rewind in new chat restores available file checkpoints and starts a conversation before the selected message while retaining the original chat.

- Chat reasoning is a quiet disclosure: folded as a one-line receipt ("Worked for 12s · 4 steps") with a live clock and current step, opening into a step timeline with status glyphs, kinds, per-step time where recorded, slow-step amber, a filled rail and search sources. The header carries the step count and total, long step details truncate and expand in place, and a 100ms clock keeps the current step and total live. While a turn waits, the receipt's header is the only thinking indicator; the old loader pill is gone. A live trace folds itself when the run ends; failed steps keep it open.
- Removed the Task evidence card from finished chat turns; verification stays recorded in the engine for workflows and subagents.
- The Projects panel follows the DeepSeek sidebar: a zer0ne CODE brand line, a full-width New Project surface button, a quiet search, a Projects section label with the command-palette search, flat folder and chat rows with times and a selected wash. Settings, Remote, Side Chat and notifications stay in the footer.
- The Workflow control beside Stats is now a compact quiet chip: a smaller icon and label and a small on/off switch, with a subtle accent wash only when on. The standalone Configure icon is gone; model setup stays in `/workflow`, the plus menu and the workflow card.
- Side Chat's model picker is now a two-pane menu: providers on the left, that provider's models on the right, with Suggested picks, search across providers and keyboard navigation.
- Removed the Setup Guide card and the unconfigured “Let’s get started” badge from the welcome screen; it now leads straight with the connection action, activity stats and recent work.
- A desktop page no longer shows "1 command awaiting a confirmed outcome…" for a routine receipt: over loopback the banner is reserved for an unconfirmed or failed outcome (it keeps its Dismiss button), while a paired phone still sees pending commands.
- Memory recalls relevant facts by meaning as well as keywords when an embedding model is configured, keeps recurring problem-and-fix entries as solutions, and offers near-duplicates for review on the Memory page instead of deleting them. Optional automatic learning uses the local helper model and never a cloud provider.
- The project index includes documentation as well as code — Markdown, plain text, reStructuredText, AsciiDoc, Org, LaTeX, CSV and PDF text layers — and labels each search result as code or doc.
- Skills can declare triggers that offer them automatically for a matching message, and `/pin-skill` keeps a skill active for the current chat (also from Settings → Plugins & Skills). `/skills` lists what is available and pinned.
- Review individual change blocks from the Agent Ledger with Keep, Undo and Redo, while preserving the original turn checkpoint and protecting later manual edits.
- Compare 2–4 models on the same prompt in isolated worktrees from one Git commit. Review reports, usage, recorded checks and diffs, then apply one candidate with Undo support; other candidates stay available until discarded.

- Revoking a paired phone now cancels pending submissions and checks its access again before accepting a message.
- Runtime cleanup preserves fresh builds and waits while another project installs or maintains the engine, voice or Studio runtime.
- Workflow runs a main agent, workers and reviewers, each on the provider and model you pick: the main agent (this chat's model) plans, delegates and combines the results, workers each run a task in their own conversation in parallel, and a read-only reviewer checks the result (Pass, Changes or Blocked) or is turned off. Turning on the Workflow switch beside Stats, or `/workflow`, opens a menu above the composer with a row per role, each opening its models sorted into provider categories (badge, model count, the one in use; search opens every match), the number of parallel workers, and one-click Full Access and Subagents fixes; every pick applies at once. The run card is a flow: what you asked and the main agent, a card per working agent that glows while it works, and the review with its outcome, joined where the work is handed over. It replaces the agent tree in the chat for the latest workflow turn.
- Workflow summaries show the current task's review outcome and fit desktop layouts without hiding outcomes behind an unnecessary scrollbar.
- Provider compatibility settings stay separate for different server ports and gateway paths; JSON replies use the same size and idle limits as streaming replies.
- Side Chat keeps file lookups within the selected model's context allowance throughout a conversation.
- Features search keeps its input and keyboard focus while filtering capabilities.

- Tasks now show verification receipts with commands, exit codes and workspace snapshots separately from work and review status. Opening a receipt checks whether its evidence is stale and shows recorded tool requests, approvals and outcomes. Interrupted calls remain uncertain, and resumed workers retain their previous tool restrictions.

- Updated the bundled Electron from 44.4.5 to 44.9.3, picking up five patch releases of Chromium and Electron fixes including security updates.

- The answer footer is quiet until you point at the answer; its buttons show tooltips after a beat, Copy turns into a green check with a "Copied" flash, and Retry turns once when pressed.
- The context window popover is a new card: used tokens counting up, a usage pill that turns amber and red as the window fills, a grid of cells coloured by what fills it (point at a category to light its cells), tokens per category, and a footer with what is left and a Compact button.
- Edit and patch approvals pair each changed line with the line that replaced it and highlight only the words that changed.
- The / commands, $ skills and @ mentions menu marks what you typed in each match, glides one highlight between rows, and shows its keys in a footer.
- The model menu leads each model with its provider's tile, dims the others while you point at one, pops in the check on the current model, and names the current model with its context size in a footer.
- Numbers in the Stats strip roll digit by digit to their new value.
- Settings' two-way choices slide a raised indicator to the option you pick. Loading messages in Settings shimmer, and images still loading in the chat show a skeleton.
- Memory facts and skills read as quiet library rows with their actions on hover, and notifications rise in as cards with soft status halos.
- Workflow now uses the Decision Tree design: raised stage cards, fine branching connectors, highlighted review outcomes, and a connected worker/reviewer setup sheet with reduced-motion support.
- Thinking State now separates titled steps correctly when reasoning arrives with Windows line endings.
- The progress checklist uses the Agent Plan design: numbered steps, a spinner and live timer on the step being worked on, drawn checks and an accent rail down finished steps with how long each took, and a footer showing "Running · 3 of 5", "Paused" or "Done in 1m 20s" with the elapsed time.
- The Git tools status panel and Changes review now float directly over the chat conversation as overlay cards instead of pushing messages aside as a docked layout column.

- Work Details → Subagents now uses the Agent Graph design: a central orchestrator, connected agent and recorded-tool nodes, live status motion and selectable task details. The task list and all run controls remain available below the graph.
- Chat no longer repeats a saved thinking step while its tools run.
- The New Chat welcome headline and description now reveal word by word, rising out of a soft blur as they enter view. The motion plays for each new chat and respects Reduce Motion.
- Chat reasoning has a new look: an expanded card with a live "Thinking 12s" clock and each reasoning step on a timeline, the current step highlighted and web searches listed with their sources. When it finishes it reads "Worked for 12s" with a "Finished thinking" step, and its header folds it away; a fold is remembered. The live status line under the chat is a compact loader: a ray spinner with the current activity rolling through.
- Streamed answers fade in word by word out of a soft blur behind a pulsing accent caret, and the copy and retry actions fade in as the answer finishes.
- When the agent starts subagents, the chat shows an Agents tree: the orchestrator and every subagent it started as live cards with status, model, cost and time, linked by lines. Each card's cost includes its sub-agents, a branch folds to one line, failed agents are listed from the header, and clicking a card opens its details.
- Pending approvals use a new Approval Card: what wants to run and where, a Low/Medium/High risk label, a preview, and Reject (Esc) / Approve (Ctrl+Enter or ⌘↵) while the card has focus.
- Chat steps show how long each one took, groups stack their tools as small tiles with a total time, failed steps get a red mark, and an expanded step shows its output in a labelled panel with a copy button, colour-coded JSON and a "Show all" for long output.
- Notifications are redrawn as Toaster cards: an animated check, cross, info or warning mark, a hairline counting down the time left, a close button on hover, and a timer that pauses while you point at it.
- Side Chat now uses the supplied Writing Assistant design: a compact companion card, soft pink/violet/blue glow, minimal composer and quiet controls.
- Session changes now use the Agent Ledger design with before/after file previews, per-file Undo and Redo, and hover or keyboard previews of later edits to the same file. Command and connected-system effects are marked as unable to undo from file checkpoints.

- New Project now opens a name and source folder dialog, followed by a folder trust confirmation before opening the project. Custom project names are saved in the sidebar.
- Local Models Activity keeps its CPU sampling baseline during settings refreshes and stops sampling when you leave the activity page.
- Features now has searchable capabilities, setup filters, scoped evidence and dated activity reports. Checks refresh after configuration changes and expiry, support cancellation, and discard outdated replies.
- Preview project verification stages and npm dependency audits before running them. Reports track the checked project snapshot, stop on failures and can be cancelled; separate windows cannot run checks against the same project simultaneously.
- Connect an installed local language server for read-only diagnostics, definitions, references and symbols. The impact tool can include semantic references and suggest related tests.
- Run declared browser regression scenarios with assertions and screenshots in a separate profile. Workspace watch keeps results and search context current without automatically executing commands.
- Fixed a startup crash reporting "Class constructor AcpHost cannot be invoked without 'new'" when opening a project.
- The app cleans up after itself on disk. On start it sweeps leftover files that no running code owns anymore: interrupted download parts and verification files in every store, stale download markers that hide completed models, cancelled conversion weights, dead runtime versions and stray engine archives — only files older than a week are touched, so resumable downloads are kept.
- The Models page storage card now accounts for every store (models, image and voice, the engine, the converter, private search), not just the models folder, shows the total and leftover downloads, and its cleaner removes leftovers in all of them plus the empty folders deletions leave behind.
- The downloaded zer0ne Engine can be removed again from the Models page (Engine & more). It is offered whenever no model is running, stops this window's idle server first, and downloads again automatically the next time a local model needs it.
- Voice and image-generation runtimes drop the previous version's folder once a new one is installed, instead of keeping every version forever.
- Background projects free their memory: an engine that has not been shown, has been quiet for ten minutes and holds no terminal, remote or router is retired automatically, and opens fresh from its saved chat when you return. The engine log is also trimmed when windows close, not only when a new engine starts.
- A long chat uses the same memory it has after a restart: oversized attached context is cut to the kept size and only the newest browser screenshots stay in the live conversation, matching what was already saved.
- Each chat remembers its provider and model. The model picker shows provider names, favorites and recently used models, and updates the selected model's reasoning controls.
- Switching back to an agent includes the conversation it missed. Retrying after an interruption or edited history starts a fresh agent session from the saved conversation.
- Statistics popups use their final size when opening, keeping them above and centered on their buttons throughout the animation.

- Restoring from the Windows taskbar explicitly shows and refocuses the retained project page. Reopening from the tray or a shortcut keeps the window's previous size instead of forcing it maximized.
- Saving from multiple project windows no longer mistakes a newly created save lock for an abandoned one.

- Computer Use now keeps screenshot coordinates per chat, checks coordinates and inputs before approval, and cancels its helper when stopped. Windows reports rejected input and display changes, refreshes the helper after updates, types Unicode text faster, and removes temporary captures. Unsupported macOS scrolling and Linux Wayland input now report clear errors.

- Side Chat moved from the top bar to the sidebar foot beside Remote and Notifications. The More (⋯) menu has a modern glassmorphic UI with refined typography and integrates Help (Copy device ID and Open logs).
- Liquid Glass displays a luminous status hint and percentage pill when transparency is active, making the controls effortless to locate and adjust over any desktop background. Its options panel now features an upgraded, modern opaque design that stays fully legible in transparency mode, and entering full-screen while transparent automatically hides the Windows Taskbar alongside desktop icons.
- Each chat remembers its file preview, reading position, file filter and expanded folders. Switching chats ignores late previews from the previous chat, and the file tree stays visible beside the preview.
- Typing batches composer updates and draft saves; unfinished IME text is retained when switching chats.
- Scrolling during a reading-position restoration keeps your new position when the chat column resizes.
- Read-only subagents can use the current chat's OCR connection to read scanned PDFs and images.
- Expired MCP App documents are released after one hour even when no further documents are opened.
- Stopped or interrupted runs no longer create completion notifications in the desktop bell or the OS.
- Empty leftover tool cards are hidden, installed marketplace plugins appear first, and tunnel timeouts include the connection's reported error when available.

- Chats cost less on providers that cache prompts (DeepSeek, Anthropic, OpenAI and others): the agent sends the same request prefix on every turn, so the provider can serve it from its cache instead of reading it again at full price. The agent's own thinking is sent back with every turn that produced it, the workspace and OS facts moved to the end of the system prompt, and the summary written when a chat is compacted now replays the conversation it replaces instead of starting from a different prompt.
- A packaged build no longer opens a remote debugging port, so another program on the machine cannot read the engine token and approve tool calls for you.
- The context panel's prefix-stability line now names a changed system prompt as such. On the [OI]-compatible format the system prompt travels as the first message, so it used to be reported as "history message 1".
- A turn that reaches the model's output limit no longer loses the tool calls that were cut off: the agent is told which call was truncated, and the subagent loop does the same.
- Tool cards now redact secrets in their details too, not only in the summary. A file the agent edits is checked for secrets before it is written, and reading a file stops at 20 MB.
- A writer's changes are approved as a whole. A diff too large to review in the chat is refused instead of applied with a shorter approval.
- Cloud task setup always restores its own workflow and runner, and never pushes a setup script you edited yourself.
- Saved chats, providers and settings are written durably, and the last good copy is kept beside the file. A damaged file is never overwritten and the error says where to restore it from. A save lock left behind by a process that died is reclaimed instead of blocking every save for 30 seconds.
- Settings, provider lists, hooks and usage now survive two engine processes saving the same file: each keeps what the other added.
- A task budget starts fresh with the current limits when a task is retried, and a running turn's budget is never evicted from the pool.
- Sending a message while another turn is still starting now queues it instead of starting a second turn in parallel.
- Undo says so when a changed file was too large to snapshot: the turn is marked as not fully undoable and the files that could not be restored are named.
- A signed-in account's access token is no longer written to the CLI credentials file or saved as a GitHub repository secret. Only a real API key is shared; an account sign-in asks you to set one yourself.
- MCP tools keep the order their servers listed them in, and a name that two tools would share is resolved without dropping either.
- Local model downloads, the GGUF converter and the local host now fail closed: a release without a checksum is not installed, a converted archive is verified, and the host's health endpoint needs its key.
- The desktop test host now overrides environment variables by name whatever their case, so a test can really make a command fail to start.

- The Prism glow is a short handoff light along the composer's bottom edge: a curved two-tone ribbon with a travelling shimmer, running once for about 2.5 seconds on focus or Enter before fading out even while the box stays focused. The Appearance preview and reduced motion follow it, and saved colours and intensity are preserved.
- Turning the Prism glow, Glass panels or text reveal back on in the desktop app is saved again; on a new profile the choice used to be dropped and the setting stayed off.
- Appearance tidy-up: the Mode row fills its width, the accent field shows the accent in use instead of an unrelated orange, the Background and Foreground fields show the theme's own colours, the picture options say they need a picture until one is in use, and the glow tone fields are only highlighted for your own tones.
- A new chat now opens the welcome at the top of its dashboard instead of halfway down it, after any scrolled conversation.
- Cloud task setup now shows a warning, not an error, when it skips a file you edited locally.
- Mobile remote feels like a phone app: Projects and Work Details open as full-screen sheets instead of squeezing the chat, the top bar keeps only projects, the title, new chat and ⋯ (history, work details, side chat, phone alerts, settings), approvals and questions use thumb-sized targets, and the composer can attach a photo or a small text file from the phone. A dropped link says “Reconnecting…” and reconnects at once when you return; the screen stays awake while the agent runs, the phone buzzes when it needs you, and phone alerts are one tap in ⋯.
- Each paired phone now has its own session in Settings → Mobile remote (name, address, last seen, Sign out), so a phone can be signed out without the others, and a signed-out phone must pair again instead of slipping back in from its history. The page is redesigned around a status card, the pairing code and the phones list. Approve/Reject arrive as buttons on ntfy push notifications while Remote is reachable, gzip keeps long chats light on mobile data, inline MCP apps open on the phone, Settings itself opens as an icon rail on a phone, and an artifact the agent publishes opens from an eye in the phone's top bar as the same sandboxed document the desktop shows.
- Mobile remote now fits every phone and tablet: the model, permissions and add menus open as bottom sheets instead of clipping at the screen edge on narrow phones, fields use a 16px size so iOS does not zoom the page when one is focused, and the Projects sheet drops desktop-only hints (Ctrl K, “other projects open in separate windows”) and the folder picker.
- Named editing subagents use isolated Git worktrees automatically, including parallel tasks. New workflows start with two workers and retain independent read-only review.
- Subagents show their branch, worktree folder and changed-file totals. View diff, Apply changes and Discard controls review the exact patch, retain conflicting work for correction, and record applied changes for Undo.
- Writers accept instructions between steps. Agent tasks retain their conversations after restart, and interrupted writers resume explicitly in the same checkout. Active writer checkouts stay protected from stale windows applying or discarding them. Live details refresh while focused without overwriting instruction drafts.

- Side Chat is calmer. One Sources button next to the model replaces the row of chips; its menu holds Recent chat or Whole chat and each look-up, with what it does. New conversation, Keep history, Expand and the keyboard shortcuts moved into a ⋯ menu, and the footer row and subtitle are gone. The status strip and folder tab show only while Side Chat is working, or when something needs your attention. The empty state is a single line with four starters, and Copy and Use in chat appear when you hover over an answer.
- Side Chat's model picker is a searchable menu instead of a plain dropdown. Your recent models come first, then fast models recommended for Side Chat, then every model grouped by provider. Each model shows its context size, price and labels (Fast, Local, Free, Thinks, or No look-ups for models that cannot use sources). It works with the keyboard: arrows to move, Enter to choose, Esc to close.
- Side Chat has a new midnight-glass look: a navy card lit by your accent color, a folder tab showing what it is doing, a glowing status strip with See steps, round glass controls and a white send button. It fades in from a blur with a soft glow, and while it works the card's glow pulses and the strip shimmers. Light themes get a frosted white version, and reduced motion turns the effects off.
- Side Chat is a faster, more capable helper. By default it reads the chat's summary and recent turns instead of the whole chat, keeping the start of each request the same so follow-up questions are served from the provider's cache. Click the chat chip to switch to the whole chat. Source chips (Project, Changes, Problems, History) let it look things up read-only in project files, git changes, errors, other chats and memory. Each look-up shows while it runs, and every answer lists its sources (file sources open the file). Answers have Copy and Use in chat, which adds the answer to your message box as a draft without sending it. Side Chat remembers its model, opens and closes with Ctrl+J, and has two more starters: What changed and Next steps.
- Closing Projects & Chats now hides the whole panel: no floating icon rail is left beside the chat. The top-bar sidebar button reopens it.
- Settings → Usage stats has a new dashboard look: a deep glowing canvas with frosted tiles, wide-tracked micro labels and day-by-day token lines that glow and read out on hover. The By model table, Budgets, the workflow panels and the model detail page use the same language, with a light-theme variant.
- Settings → Memory shows its Copy all and Clear all buttons again, with the page title above the memory summary.
- The dialog menu's "Save…" item no longer shows a broken character instead of the ellipsis.
- The app is 19 MB smaller: it no longer ships the unused native tools helper (`zer0ne-tools.exe`), and the third-party notices no longer credit the code it contained.
- Goal mode: `/goal <what done looks like>` keeps the agent working until a judge confirms the goal from the evidence (test and build output, changed files), for up to five rounds. A judge that fails or answers unclearly never counts as done; the chat says the goal was not verified. `/goal status` shows it, `/goal off` clears it.
- Tool results (files, command output, web pages, MCP servers, other agents' reports) reach the model marked as untrusted data, and every agent is told never to follow instructions found inside them.
- Compaction keeps the exact pre-compaction history on disk (the last three per chat) instead of deleting it; deleting the chat removes it.
- Subagents size their context from the provider's own token counts instead of a fixed guess.
- The skill list in the system prompt has a budget (Settings → Skills → Prompt budget, 12k characters by default): past it, skills are listed by name only, so a large skill set no longer crowds out the conversation.
- A project no longer hangs when the app leaves a request unanswered: requests time out (30 seconds, 30 minutes for dialogs), and an app and engine host from different builds are refused with a clear message.

- The chat runs a workflow again: `/workflow` opens a Configure sheet (worker model, reviewer model, up to ten parallel workers), a run card above the composer shows the workers beside the review phase, and Work Details lists both phases with live status, per-agent tasks and a concurrency control. Saved workflows are no longer turned off at startup.

- A reviewer verdict written with markdown or prose around it is read correctly, a reviewer that answers without one is asked once to restate it, and a blocked review shows as blocked (with the reason) instead of leaving an empty, idle-looking run card.

- Smart notifications: real duration formatting (e.g. `14s`, `2m 15s` instead of rounding up to `1 min`), attention alerts when the agent is waiting for tool approval or question answers with an amber indicator and sidebar chip, one-sentence executive outcome summaries in completion notifications (including file modification counts and prompt topics), and interactive multi-project coordination in the notification center with one-click navigation to the relevant project and chat.
- Providers & models cleans up model rows by removing the redundant "Tools configured" badge, "Generation untested" badge, and "Test tools" button.
- Prompt navigation rail is capped to a 10–15 line scrolling window with top and bottom fade masks, auto-paging by 15 prompts when selecting the first or last visible tick, mouse-wheel scrolling, and boundary centering.
- Projects panel opens reliably by default on launch across all window sizes, avoiding false-closed persistence and delays.

- Browser snapshots include reachable cross-origin frames and open shadow roots, keep stable element references, and reject removed, disabled or covered targets. Password values are omitted from snapshot text.
- Browser agents can batch up to twelve known actions with one final snapshot, stop on failure, and request text-only snapshots to reduce repeated screenshots.
- Browser agents own their tabs while sharing the app browser's saved sign-ins. Opening or closing one agent no longer takes over another agent's tab, and snapshots no longer bring the browser to the foreground.
- Skills installed in standard `.agents/skills` and `.codex/skills` folders are discovered alongside Claude skills. The skill catalog includes ego-browser, which requires its separately installed browser.

- Unsent text and attachments now stay with their chat when switching sessions or starting a new chat, including after restarting the app.
- File previews and agent file paths reject links that escape the project folder; previews also reject neighboring folders with matching name prefixes, and Windows agent paths reject alternate data streams.

- Side Chat has a cleaner header, passage-aware starter actions, refined excerpt and answer styling, and a compact composer with a history toggle. The panel adapts to narrow windows and respects reduced motion.
- Running chats in the Projects panel show a glowing particle orb with a shimmering Running label in place of the spinning neon edge. The Projects panel is a quiet list: a plain New project row, a soft search field, and folders and chats as simple rows without tiles or guide lines.
- Chat steps read as verbs with live particle orbs while they run (Thinking, Reading, Listing, Searching, Editing, Writing, Running, Solving) and file-type badges, file chips and colored line counts once done. While the agent works, one plain line under the chat names the current activity beside a glowing pixel grid in the theme's accent colour.
- Git tools, the goal (state, time, tokens) and progress share one status panel, as in ZCode: an expanded card with foldable sections, or a one-line summary you click to expand. It expands by itself beside the conversation in a wide window (which makes room for it) and stays a summary in a narrow one. When the model keeps no checklist, Progress lists the turn's own steps. Git tools appear for a clean tree (+0 −0) and say when the folder is not a Git repository.
- Restore after Maximize returns the window to its previous size; transparent windows on Windows used to stay maximized.
- Work Details has a segmented tab bar (icons, the open tab named), softer empty states and cards, a compact Changes list with Open and Diff on hover, and a Browser tab laid out as a small browser window with its address bar, snapshot, page title and activity.
- A tool call cut off by the output limit is no longer run with repaired, partial input (which could write half a file); the model is told to make the change in smaller pieces.
- Tool calls a model writes as text (`<tool_call>…</tool_call>`, `<function=…>`, or a JSON block naming an offered tool) now run instead of ending the turn — common with small local models.
- An empty reply gets one reminder to continue; if the model still says nothing, the chat says so and suggests Retry or a larger model instead of ending silently. The agent prompt names the app it runs in (zer0ne Code) instead of VS Code.
- MCP servers are listed in groups (your servers, then each plugin's) with a status dot that explains itself on hover, transport, OAuth and tool-count chips, and the server's error inline; click a row to edit it.
- The new-chat binary background drifts gently with the mouse, and the welcome card has a simpler sans headline with a soft light that follows the cursor.

- Reasoning uses only its glowing slider banner, with a larger grab handle and no duplicate choices or explanatory text. Projects no longer show chat counts or the current-project dot.
- Double-clicking the title bar also works when its events reach the page. Compaction summaries stay directly visible in the chat instead of folding into completed tool activity.
- Completed replies retain their expandable thought-process text when Show reasoning is enabled.
- Compacted conversations retain a stable system prompt for provider caching, including when reopening older saved chats. Summary context stays in the conversation and counts toward its token budget; incomplete or cancelled summaries leave the original conversation intact.
- Simplified the Projects panel and refined running-session neon edges across light and dark themes. Reasoning now offers an Inspora-inspired glowing brain slider with a star trail, Auto, and only the selected model's supported levels.
- New chats have a softer binary background and a gentle welcome transition. The effect uses fewer simulation passes, caps rendering at 30 fps and 1.25× pixel density, and pauses when the window is unfocused.

- New-chat backgrounds now use a softer, sparse flow of binary digits. The effect preserves Glass transparency, fades with the transparency slider, and stops at full transparency.
- The title bar, welcome card and Settings now show the supplied `assets/icon.png` logo.
- Antigravity sign-in refreshes Google's agent registry before starting, and the offline installer entry now uses official ACP 1.4.1.
- Updated the Windows app, window and tray icon from the supplied icon.png, and replaced the startup logo with loadingbanner.png.
- Updated the app icon: the tray, window and installer now use the new artwork from `assets/icon.png`.
- Antigravity login ignores verification and help URLs in agent diagnostics, so they cannot replace the fresh Google OAuth sign-in link.
- Antigravity errors offer Copy fresh sign-in link: it starts a new login, copies its live link through the app clipboard and exposes selectable text for trying a private browser window.
- Antigravity’s Sign in again now restarts the agent’s saved OAuth login through its supported logout and personal Google sign-in. Verification errors offer a separate Sign in with Google again action; Try again continues to recheck the current login.
- Removed the Local image, video and voice section from the chat model picker. Side Chat has a refreshed layout, growing composer, prompt shortcuts, clearer model controls and a return-to-latest button that preserves manual scrolling.
- Fixed verification and recovery links inside sign-in dialogs, added Copy verification link, and preserved long signed OAuth links across split agent output. Browser launch failures keep the manual link and code-entry controls available across subscription providers.

- Refined chat inputs, messages, model menus, tool cards, code blocks and sidebars with warmer surfaces, shared rounded controls, spring-style menu motion and a Clay accent. Images support pointer-anchored zoom, panning, fit controls and keyboard navigation. Suggestions respect IME composition; menus support arrow keys. Sidebar chats can be reordered by dragging or Alt+Up/Down, with remembered order. Panel resizing adds a drag threshold and Escape cancellation. Streaming respects manual scrolling with soft edge fades. Tool cards distinguish permission from running, completed, rejected, failed and interrupted execution.

- Local model checks exclude DFlash and other draft helpers from chat models, count raw split-model chunks together, and explain memory limits, unsupported formats and missing standalone weights. Estimated memory fit is distinguished from a successful run; blocked builds have no speed estimate or Download/Run action. Downloaded helpers stay visible in Library with a warning. Generic engine load failures no longer become memory errors.

- Simplified chat and settings: removed Team workflow and Team models controls, disabled saved team workflows on startup, and restored Mobile remote without Feishu. Agent settings separates Behavior from Subagents and folds advanced execution limits away. Plans & subscriptions shows one primary connection per plan without OAuth/agent/key filters or duplicate CLI cards. Reasoning defaults to Auto, detects supported overrides per model, and uses a compact chat menu.

- Work Details → Subagents retains task cards during live updates, shows recorded file previews and explicit task review outcomes, and opens inline Activity, Conversation, Changes and Report views. Running subagents accept steering instructions and individual Stop actions.
- Projects and Work Details use compact headers and scrollable tool tabs. Running rows follow the current theme with a calmer perimeter effect that pauses when unfocused and respects reduced motion. Subagents offers an expanded monitor and a stacked view in narrow panes; composer controls wrap when space is limited.
- Memory never silently evicts facts at capacity. Archive/restore controls, active capacity, source-chat provenance, per-message recall receipts and pin-first recall within a 12 KB budget make retention explicit.
- Local-model Run loads successfully before changing the selected chat model. Speech, image, embedding and helper files identified by name are excluded from chat Run and chat benchmarks; hardware fit remains an estimate until a real test succeeds.
- Feature health distinguishes configuration/discovery from successful execution. Model generation and synthetic tool-call tests have separate saved results; Browser adds launch/refresh testing, screenshot previews and activity in Settings and Work Details.
- Completion hooks now show their output and can require successful validation before a turn finishes. Hooks settings adds sample-input testing and bounded execution history with exit codes, stdout, stderr and duration. Plugin cards report unsupported hooks; MCP settings lists supported transports and capabilities.
- Side Chat can optionally save its last six exchanges with the main chat. Remote separates server connection, authenticated clients and desktop approval guidance.


- Settings → Local models is now Models Fit Studio's screen, run by zer0ne Engine: Check, the model list, Battle, Library and Settings, in zer0ne Code's theme and across the whole width (no side panel). Models downloaded there go into zer0ne Code's models folder and appear in Providers & models under zer0ne Engine; Run loads a model and opens a chat with it; Measure speed and Test quality use zer0ne Engine. The old Models, Battle and My models tabs are gone.
- In the model list, Refresh sits beside Suggest and "Fits this PC" is a switch.
- Suggest gives the same picks as Models Fit Studio: the same list of models that fit (llmfit's, for this computer and its memory budget), the same speed range (this computer's decode rate, corrected for its kind of graphics, or by a real run on it), and the same choice: the highest quality that still feels quick, the smartest one that still writes at reading pace, and the fastest one that still answers well. It showed a single model before, chosen by the old chat-model presets.
- Engine & more, the last tab of Local models, has two tabs: Engine (with the Local assistant and the Local Host router folded under it, the router off until you turn it on) and Activity, which shows the engine's state, the model loaded now, live speed and memory, downloads, and what is on this computer.
- A model whose file name says "MTP" because it carries its draft layers inside (such as a 17 GB Qwen3.8 27B NVFP4 build) is checked as the model again; it was taken for a small draft head, so Check said "Won't fit" with no file while the list said it fits.
- The model list no longer rates a repository by its vision projector: Hugging Face's numbers for such a repository describe the projector (a 27B model showed as 460M parameters and "Fits"); the size in the name is used instead.
- A model the engine cannot load yet (an architecture this zer0ne Engine build does not have) says "Needs engine update" in the list and "Needs an engine update" on Check, instead of "Fits" in the list and "Won't fit" on Check.
- A model that comes with a draft head (an mtp- file in its repository) downloads it too and uses it while Speed boost is on; builds that carry draft layers inside ("MTP" builds) use them as well. On an Arc 140T, Gemma 4 E4B wrote 21 tokens a second alone and 29 (prose) to 47 (rewriting code) with its head; Qwen3.5 2B MTP wrote code at 43 instead of 36. A Check names the head when a repository has one.
- On integrated graphics with the Vulkan build, Qwen models (2.x, 3, 3.5) load with plain attention and a full-precision cache when that fits at the same context. Measured on an Arc 140T, a first long prompt was read 1.3 to 1.9 times faster and follow-up turns waited no longer. Other models keep the engine's choice: Gemma 4 read a first prompt faster this way but then waited twice as long on every turn.
- Engine → Tune for speed measures what an agent does: the first read of a long prompt, then a follow-up turn. It also tries the other attention mode and the processor alone, keeps a change only when it is faster overall and nothing a person waits for gets worse, and says what it kept. It no longer stops with "too few tokens" on models such as Gemma; the first-load speed check had the same fault.
- A Check reads a megabyte of the model file on Hugging Face for its real layer and attention sizes, so the memory a context takes and the longest context are the file's own instead of an estimate from its size.
- Distilled models named after a mixture-of-experts family (MiMo-V2.6-Distill-Qwen-9B) are rated as the dense models they are; their speed was shown about three times too high.
- A model larger than shared graphics memory is no longer advised to "split GPU + RAM": on such a chip a split was measured slower than either the chip or the processor alone.
- Model ratings use what this computer has instead of the memory free at that moment, so the list no longer changes when another app opens. A build larger than fast memory that the computer can still hold says Runs slower and can be downloaded; it is never a recommendation. The check shows a warning when less memory is free than the build needs. Loading a model still fits it to the memory that is free then.
- The recommended build of a model is the largest that fits with room to spare and still writes at working pace, the rule Models Fit Studio uses.
- Models downloaded with Models Fit Studio appear in Local models → Library, used from that app's folder without copying. Fit ratings, helper-file detection and the quality test follow the same rules as Models Fit Studio.

- Chat keeps the visible paragraph in place during resizing and streamed updates. Queued edits retain their input and uploads across updates and chat switches; interrupts keep other queued messages. Damaged message cards are validated on loading.
- Named subagents honor their own model choices. Completed/resumed agents display their current execution status correctly.
- MCP tools with UI resources can display interactive apps inside their messages, with isolated frames, explicit network-domain access and confirmation for app tool actions.
- Browser previews deny site permissions until confirmed, keep camera and microphone grants separate, and offer revocation in their context menu. Opening local links externally reports failures.
- Quota errors keep Usage and model recovery controls visible and show the provider’s retry time when supplied. Workspace startup limits simultaneous engine initialization and avoids repeatedly parsing unchanged shared storage.

- Select text in a session to open Side Chat, with an excerpt, streaming answers, follow-up questions and its own model picker. Side Chat leaves the main conversation and draft unchanged; API and local models are supported.
- Right-click a chat message to copy text or Markdown, send the selection to Side Chat, attach it to your draft, pin a chapter or fork a new session from that message. Pinned chapters are saved and appear in the conversation navigation rail.
- Transparent Projects and Work Details use separate native acrylic surfaces on Windows, including at 100% transparency. The main chat keeps its clear background; full transparency no longer forces whole-window blur.

- Projects and Work Details have redesigned headers, navigation, search and content surfaces. Both panels offer a width slider, size presets, reset, draggable edges and keyboard resizing; sizes are remembered across project switches.
- Running sessions show a rotating neon edge with reduced-motion support. Project and tool panels have refined cards and spacing, Settings → About has a new product overview, and the sidebar shortcut now opens Remote.
- Project folders have a Delete button with a Yes/No confirmation and Recycle Bin/Trash recovery. Active sessions and services must be stopped first; saved chats remain available when the folder is restored and reopened.
- Open Project Folder offers Visual Studio Code, Cursor and a terminal alongside File Manager and Copy Path, and identifies apps that are not installed.

- Running chats save progress periodically. Reopening an interrupted chat retains its last saved partial reply and clears abandoned tools, approvals and questions.
- Plugin and skill discovery runs outside the engine's event loop, keeping chat updates responsive with large catalogs. Activation and execution still check the current plugin contents.

- Stats reveals a compact metric row directly below the chat box. Click session statistics, token/cache usage or context usage to open its detail popup; click again, press Escape or click outside to dismiss it.

- Local Models searches model names, repositories and Hugging Face model links beyond the catalog. Language-model downloads now open a pre-download hardware scan with build comparison, memory fit, disk space and estimated speed; weights download only after choosing a checked build.
- Local Host forwards zer0ne Engine Responses, Anthropic Messages and native token-count requests, preserves protocol headers and stream errors, and shows separate client URLs plus the loaded model’s actual context. Browser-blocked ports are refused before changing a running router.
- Local model agent benchmarks check the exact file path and resulting edit, reject arrays as tool argument objects, and include needless tool calls in the JSON score.
- New Claude connections enable the vendor's current model aliases by default. Older versions remain selectable, and reconnecting preserves your enabled models.
- Vendor-agent catalog refresh removes withdrawn models, updates names and reasoning controls, and preserves settings for models still offered. New choices can be enabled from the refreshed catalog.
- Vendor-agent connection checks require an actual short reply before marking an account connected. Network and model failures no longer automatically request another login; Google verification and unsupported plans have distinct sign-in messages.

- Claude subscription sign-in checks and browser login use the same project settings as chat, so a user-level proxy token cannot skip the real Claude account login. Failed or unchecked agent connections no longer show a green connected label, and authentication errors do not assume the login expired.

- Adjustable reasoning appears for supporting chat models with a clear Auto default. Supported APIs receive their own effort or thinking-budget settings, and signed-in agents use only their advertised reasoning selectors or model variants. Unsupported levels are hidden, and Maximum is separate from the former default “Max” label.
- Google account-verification replies are reported as connection failures, preserve the complete trusted vendor link and offer recovery guidance when Google's verification page returns HTTP 500.

- Claude sign-in accepts OAuth logins whose CLI status omits subscription metadata, then checks access through the vendor agent. Explicit API billing overrides and provider subscription restrictions still produce their own errors.

- Plans & subscriptions combines account sign-in and plan keys in one list. ChatGPT uses OpenAI's current registration and renewable account flow, while Grok Build, Kimi and MiniMax Code join the main plan list. Unsupported legacy OAuth offers and retired GitHub Models no longer appear as working sign-in choices.
- Sign-in cancellation stops pending connections and cannot replace a newer attempt. Agent authentication respects the advertised login arguments, environment and plan-specific method; terminal login waits for the vendor to finish. Plan key replacement preserves the existing provider and model choices, and connection badges distinguish saved, verified and failed connections.
- Connection checks finish with a sign-in error when a session cannot renew, instead of leaving the check button waiting.
- ChatGPT supports separate account registrations and remote-session sign-out, serializes token renewal across project engines, and sends subscription requests with the required Responses settings and local tool namespaces. Plan agents exclude environment keys that could silently select separate API billing.

- Hugging Face browsing spaces requests, reuses recent searches and honours server cooldowns. Saved results remain available during rate limits, the token control is visible in the browser, and temporary token-check failures no longer report a valid token as rejected.
- Local Models adds per-model Hugging Face hardware checks with a real memory benchmark, estimated token speed and fast-memory usage. Recheck explains its purpose, and recommendation reasons open as small popups.
- Model lists keep updating when Electron pauses animation frames in an occluded window, preventing a completed hardware check from leaving the catalog stuck on “Checking this machine”.
- Chat & coding includes general language models; GGUF fit checks cover floating-point, IQ, TQ, MXFP4 and NVFP4 builds against the installed engine’s supported formats. The engine installs automatically when needed, and choosing Ollama can install its verified official portable runtime.
- Activity shows measured system CPU and RAM even with no model loaded, distinguishes missing engine metrics, and replaces Private code search with the local router. Memory values use consistent GB units across the catalog and hardware popup. Local assistant explains its optional summary, text-edit and research routing.
- Local Host exposes authenticated model routes for other harnesses, backend-specific model IDs, API key testing, LAN URL copies and request counts. Cancelled requests no longer load queued models, upstream errors are recorded correctly, and active streams stop with the router.
- A serving Local Host router keeps its project engine alive when switching projects or hiding the window, so other harnesses stay connected. Stopping the router releases that retention.

- Desktop subscription connections now include the vendor agents from the ACP registry, with real terminal sign-in, setup guidance and connection checks. Dedicated plan URLs stay separate from regular API billing, and OpenCode Go routes each model through its required Messages, Responses or Chat Completions API. Custom providers also support Responses and native Gemini.
- Local Models has a redesigned catalog with compact category navigation, a hardware overview, clearer recommendations, grid and list views, sorting and expandable model details. Plan cards explain their sign-in requirements and offer setup links for unavailable agents.
- Quickly reopening Settings keeps the new pane visible instead of allowing the previous close animation to remove it.

- Provider model switches now save correctly in the desktop app and update the chat picker, instead of reporting that the feature is unavailable.

- A plan provider now shows its models in the chat menu by itself: adding it with an API key, saving the key afterwards, and the OpenRouter sign-in read the endpoint's own model list and enable it. Curated plans switch on in full; huge gateways keep the menu readable with the well-known models on. A failed or empty list is reported instead of silently leaving the provider empty.

- Local Models adds Fast, Balanced and Best quality recommendations with reasons, clearer compatibility labels, expandable GGUF builds and grouped Hugging Face conversions. A cancellable first-load speed check measures first-token delay, generation speed and process RAM samples; device and configuration-specific results are shown separately from estimates, with an option to disable the check or test again.

- Models on OpenCode Go work again: the engine sends the gateway's required session header, stable for each conversation, plus a zer0ne user agent, so requests are accepted and routed instead of failing with "missing x-opencode-session".

- Local Models now has one Coding list and includes Hugging Face browsing within Models. All choices stay visible by default; Fits memory and Recommended are separate filters, with search and Show more. Checked catalog builds also appear in Hugging Face results. The refreshed layout uses compact hardware and model cards; Engine keeps everyday controls visible and groups detailed settings and optional runtimes in collapsible sections.

- Local Models integrates llmfit recommendations and a larger bundled catalog with Hugging Face discovery, current metadata and GGUF build checks. Fits account for available memory, context, vision projectors and architecture support in the installed engine release; Refresh models and paginated search bring more choices, with cached browsing offline. Downloads pin one repository revision, reject incomplete shards, and verify file sizes and available checksums before enabling a model.

- Local Models removes the duplicate Design category: screenshot readers are in Coding and image generators in Images. Eight smaller text and vision choices are available, with real download-size and disk checks.
- zer0ne Engine now reads GGUF architecture metadata to fit context, cache, threads and prompt batches to available memory on each machine. Dedicated GPUs can keep MoE experts in RAM; shared GPU memory is counted once. CPU retries retain screenshot support. Tune for speed measures safe settings and saves a profile only after a reliable improvement.



- Full screen now hides the title bar and window controls. Move near the top edge or press F6 to reveal a floating glass bar, which hides again after you leave it.
- Chats now have a prompt navigation rail: hover a line to preview the prompt and response, then click to jump back to that prompt.
- Agents enforce their tool restrictions at execution, including wildcard denies and nested scripts. Read-only agents cannot perform browser actions or evaluate page code, and browser actions require approval.
- Isolated writers follow project instructions, protected-file rules and tool hooks, reject folder-link escapes, and restrict review, merge and discard to their own chat. Writer edits remain unstaged for review without automatic commits.
- Stopped agents cannot finish as successful or deliver pending reports. Agent continuations retain replay protection and complete tool results; long child conversations recover from context overflow, and active streams reset the inactivity timeout. Hooks stop with their run, and children retain authorized web links.
- Saving an agent preserves the previous file if writing or publication fails. Text such as “false” remains text in agent descriptions, and unavailable model overrides or unsupported tool argument restrictions produce a clear error.

- Plugin and skill installs and renames preserve working files on failure, reject unsafe paths and damaged downloads, and report failed installs accurately. GitHub skill previews and installs use the same pinned commit and keep pasted branches or tags.
- Plugin switches and removal select an individual installation. Project plugins and plugins with hooks or MCP require activation; changed plugin contents require activation again. Invalid plugin configurations show an error in Settings.
- Skills now support standard YAML descriptions, respect disabled state and invocation flags, and retain distinguishable copies when names collide. Disabled skills remain editable in Settings. Plugin agents have plugin-qualified names.

- MCP tool switches now persist and are enforced when tools run. Tool names remain distinct across servers, plugins and long or normalized names.
- MCP connections now handle streaming responses, protocol negotiation, session expiry, cancellation and Windows restarts reliably, with bounded and validated server messages.
- MCP sign-in validates OAuth metadata and secure endpoints, protects concurrent token refresh, reports expired authentication and cleans up interrupted sign-in.
- MCP imports preserve disabled servers, reject unsupported legacy SSE, report failed imports accurately and preserve quoted or empty arguments in the JSON argument editor. Registry launch arguments and structured tool results are retained.

- Automatic verification now respects command permissions and the command sandbox. Disabled, declined or interrupted checks cannot appear as successful checks.
- Windows no longer treats Low-integrity commands as safely sandboxed: they could write to other prepared projects. With sandboxing selected in Agent mode, commands require explicit approval, including verification and background commands; allowlists and automatic command approval cannot bypass this.
- Windows verification now uses the same PowerShell syntax as agent and background commands.
- An isolated writer started with `task isolated: true` now runs as the agent it names, and a read-only agent is refused with a clear error instead of being given write tools.

## 0.2.0

- zer0ne Code now runs on Electron. The interface, projects, chats, Liquid Glass, the tray,
  the bell, applet windows and Mobile Remote work as before.
- One app instance: opening it again, or opening a project in a new window, adds a window to
  the running app. Closing a window that still has an agent run, a terminal command or Mobile
  Remote hides it to the tray; other windows close and stop their projects.
- The engine runs on the app's own runtime; the separate Node.js copy is gone.
- Edits only apply to files the agent has read and that have not changed since; writes check
  again after approval. Copied line numbers and over-escaped text are recovered, typographic
  quotes and UTF-8 BOMs are kept, multi-edit matches the original file and refuses overlaps.
- Auto compact measures the context with the provider's own token count, retries an oversized
  summary, lists files read and modified, and pauses after three failures in a row.
- The app adds itself to the Start Menu (as "zer0ne Code", or "zer0ne Code (Electron)" when another install
  uses that name) so its notifications appear. Opening Settings no longer shows an error toast.
- Text fields have a right-click menu (cut, copy, paste, spelling suggestions); Ctrl +, Ctrl −
  and Ctrl 0 zoom.
