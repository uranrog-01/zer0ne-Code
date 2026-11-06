/** Static webview markup, kept free of the vscode module so Mobile Remote can load it. */

export const CHAT_BODY = `
<div id="fs-hot" class="fs-hot" title="Show the full-screen bar" aria-hidden="true"><span></span></div>
<header id="fs-banner" class="fs-banner" role="toolbar" aria-label="Full screen"></header>
<aside id="fs-files" class="fs-layer fs-files" aria-label="Workspace files"></aside>
<section id="fs-preview" class="fs-layer fs-preview" aria-label="File preview"></section>
<div id="app" class="chat-app">
	<canvas id="fx-canvas" class="fx-canvas" aria-hidden="true"></canvas>
	<header class="topbar">
		<div class="topbar-left">
				<button id="btn-sidebar" class="icon-btn" title="Projects and chats" aria-label="Toggle sidebar" aria-controls="sidebar" aria-expanded="false" data-icon="sidebar"></button>
				<div class="topbar-title"><span class="brand-logo" aria-hidden="true"></span><span id="session-title">New chat</span></div>
		</div>
		<div class="topbar-right">
			<button id="btn-side-chat" class="icon-btn" title="Side Chat — ask about this session" aria-label="Side Chat" aria-controls="side-chat" aria-expanded="false" data-icon="chat"></button>
			<span class="remote-dot" title="Connected to VS Code"></span>
			<button id="btn-fullscreen" class="icon-btn fullscreen-btn" title="Full screen (Ctrl+Alt+F)" aria-label="Full screen" data-icon="expand"></button>
			<button id="btn-auxiliary" class="icon-btn" title="Toggle auxiliary panel (files, subagents, uploads)" aria-label="Toggle auxiliary panel" aria-controls="auxiliary" aria-expanded="false" data-icon="panelRight"></button>
			<button id="btn-history" class="icon-btn" title="History" aria-label="History" data-icon="history"></button>
			<button id="btn-new" class="icon-btn" title="New chat" aria-label="New chat" data-icon="newChat"></button>
			<button id="btn-more" class="icon-btn" title="More" aria-label="More" data-icon="more"></button>
			<button id="btn-settings" class="icon-btn" title="Settings" aria-label="Settings" data-icon="gear"></button>
		</div>
	</header>

	<div class="coding-workspace">
	<aside id="sidebar" class="sidebar hidden" aria-label="Projects and Chats">
		<div class="sidebar-head">
			<div class="sidebar-title">Projects</div>
			<div class="sidebar-head-tools">
				<button id="btn-project-add" class="icon-btn" title="Add project folder" aria-label="Add project folder" data-icon="folderPlus"></button>
				<button id="btn-project-refresh" class="icon-btn" title="Refresh projects" aria-label="Refresh projects" data-icon="refresh"></button>
				<button id="btn-sidebar-close" class="icon-btn" title="Close sidebar" aria-label="Close" data-icon="close"></button>
			</div>
		</div>
			<div id="project-search-box" class="ps-box">
				<span class="ps-icon" data-icon="search"></span>
				<input id="project-search" class="project-search" type="text" aria-label="Search projects and chats" placeholder="Quick search…" autocomplete="off" spellcheck="false">
				<span class="ps-kbd" aria-hidden="true"><span id="ps-kbd-key">Ctrl</span><span>K</span></span>
				<button id="project-search-clear" class="ps-clear hidden" title="Clear search" aria-label="Clear search" data-icon="close"></button>
			</div>
			<div id="sidebar-content" class="sidebar-content"><div class="aux-empty">Loading projects…</div></div>
			<p class="panel-note">Other projects open in separate windows so agents can work in parallel.</p>
	</aside>
	<section class="primary-chat" aria-label="Primary model chat">
	<div class="conversation">
		<main id="messages" class="messages" aria-live="polite"></main>
		<nav id="prompt-nav" class="prompt-nav hidden" aria-label="Jump to a prompt"><div id="prompt-nav-list" class="prompt-nav-list"></div></nav>
		<div id="prompt-preview" class="prompt-preview hidden" role="tooltip"><strong id="prompt-preview-title"></strong><p id="prompt-preview-answer"></p></div>
		<aside id="progress" class="progress-card hidden" aria-label="Progress"></aside>
		<button id="btn-scroll-bottom" class="scroll-bottom hidden" title="Scroll to latest" aria-label="Scroll to latest" data-icon="arrowDown"></button>
	</div>

	<div id="wf-card" class="wf-card hidden" aria-label="Workflow run"></div>

	<footer class="composer" id="composer">
		<div id="mention-popup" class="popover mention-popup hidden" role="listbox"></div>
		<div id="queue" class="queue hidden"></div>
		
		
		<div class="input-card" id="input-card">
			<div class="streak" aria-hidden="true"></div>
			<div id="attachments" class="attach-row hidden"></div>
			<textarea id="input" rows="1" aria-label="Message" aria-autocomplete="list" aria-controls="mention-popup" aria-expanded="false" spellcheck="true"></textarea>
			<div class="composer-bar">
				<div class="bar-left">
					<div class="menu-anchor">
						<button id="btn-plus" class="icon-btn" title="Add context, tools & plugins" aria-label="Add" data-icon="plus"></button>
						<div id="plus-menu" class="popover menu up left hidden"></div>
					</div>
					<div class="menu-anchor">
						<button id="btn-mode" class="chip-btn" title="Permissions"><span id="mode-icon" class="chip-icon"></span><span id="mode-label">Agent</span><span class="chev" data-icon="chevronDown"></span></button>
						<div id="mode-menu" class="popover menu up left hidden"></div>
					</div>
					<button id="btn-plan" class="chip-btn plan-chip hidden" title="Plan mode — read-only; click to turn off"><span class="chip-icon" data-icon="list"></span><span id="plan-label">Plan</span></button>
				</div>
				<div class="bar-right">
					<div class="menu-anchor">
						<button id="btn-context" class="icon-btn ctx-btn" title="Context window" aria-label="Context window"></button>
						<div id="context-menu" class="popover menu up right hidden context-pop"></div>
					</div>
					<div class="menu-anchor model-anchor">
						<button id="btn-model" class="chip-btn model-btn" title="Model"><span id="model-label">No model</span><span class="chev" data-icon="chevronDown"></span></button>
						<div id="model-menu" class="popover menu up right hidden"></div>
					</div>
					<div class="menu-anchor">
						<button id="btn-effort" class="chip-btn effort-btn" title="Reasoning: Auto"><span class="chip-icon" data-icon="zap"></span><span id="effort-label">Auto</span></button>
						<div id="effort-menu" class="popover up right hidden effort-pop"></div>
					</div>
					<button id="btn-mic" class="icon-btn mic-btn" title="Dictate (microphone)" aria-label="Dictate" data-icon="mic"></button>
					<button id="btn-send" class="send-btn" title="Send (Enter)" aria-label="Send"></button>
				</div>
			</div>
		</div>
		<section id="stats-banner" class="stats-banner" aria-label="Chat statistics" aria-hidden="true" inert>
			<div class="stats-reveal"><div class="stats-surface" id="stats-content"></div></div>
		</section>
			<div class="workspace-controls"><div id="ws-row" class="ws-row" aria-label="Workspace"></div><button id="btn-workflow" type="button" class="ws-chip workflow-btn" role="switch" aria-checked="false" aria-label="Workflow" title="Workflow"><span data-icon="workflow"></span><span class="workflow-label">Workflow</span><span class="workflow-dot" aria-hidden="true"></span></button><button id="btn-stats" type="button" class="ws-chip stats-btn" aria-controls="stats-banner" aria-expanded="false" title="Session statistics"><span data-icon="chart"></span><span>Stats</span><span class="stats-chevron" data-icon="chevronDown"></span></button></div>
	</footer>
	</section>
	<aside id="auxiliary" class="auxiliary hidden" aria-label="Work Details">
		<div class="auxiliary-head">
			<div class="auxiliary-title"><span data-icon="layers"></span><span>Work Details</span></div>
			<div class="auxiliary-head-tools">
				<button id="btn-aux-refresh" class="icon-btn" title="Refresh" aria-label="Refresh" data-icon="refresh"></button>
				<button id="btn-auxiliary-close" class="icon-btn" title="Close panel" aria-label="Close" data-icon="close"></button>
			</div>
		</div>
		<div class="auxiliary-tabs" role="tablist">
			<button id="aux-tab-explorer" class="auxiliary-tab active" data-tab="explorer" role="tab" aria-selected="true"><span data-icon="folder"></span>Explorer</button>
			<button id="aux-tab-files" class="auxiliary-tab" data-tab="files" role="tab" aria-selected="false"><span data-icon="code"></span>Changes<span class="aux-count hidden" data-aux-count="files"></span></button>
			<button id="aux-tab-subagents" class="auxiliary-tab" data-tab="subagents" role="tab" aria-selected="false"><span data-icon="agent"></span>Subagents<span class="aux-count hidden" data-aux-count="subagents"></span></button>
			<button id="aux-tab-worktrees" class="auxiliary-tab" data-tab="worktrees" role="tab" aria-selected="false"><span data-icon="branch"></span>Worktrees<span class="aux-count hidden" data-aux-count="worktrees"></span></button>
			
			<button id="aux-tab-uploads" class="auxiliary-tab" data-tab="uploads" role="tab" aria-selected="false"><span data-icon="paperclip"></span>Uploads<span class="aux-count hidden" data-aux-count="uploads"></span></button>
			<button id="aux-tab-browser" class="auxiliary-tab" data-tab="browser" role="tab" aria-selected="false"><span data-icon="globe"></span>Browser</button>
			<button id="aux-tab-terminal" class="auxiliary-tab" data-tab="terminal" role="tab" aria-selected="false"><span data-icon="terminal"></span>Terminal</button>
		</div>
		<div id="auxiliary-content" class="auxiliary-content">
			<div id="aux-content-explorer" class="aux-panel active" role="tabpanel" aria-labelledby="aux-tab-explorer">
				<div class="explorer-head"><div class="explorer-project"><span class="explorer-project-icon" data-icon="folder"></span><div><span class="explorer-eyebrow">Workspace</span><strong id="aux-explorer-root">Project files</strong></div></div><div class="explorer-actions"><button type="button" class="icon-btn" data-explorer-collapse title="Collapse all folders" aria-label="Collapse all folders" data-icon="collapse"></button><button type="button" class="icon-btn" id="aux-explorer-refresh" data-explorer-refresh title="Refresh files" aria-label="Refresh files" data-icon="refresh"></button></div></div>
				<div class="aux-toolbar"><label class="aux-search"><span data-icon="search"></span><input id="aux-explorer-filter" type="search" placeholder="Find a file or folder…" aria-label="Filter files" spellcheck="false" autocomplete="off"><button type="button" class="explorer-clear" id="aux-explorer-clear" data-explorer-clear aria-label="Clear file search" title="Clear search" hidden data-icon="close"></button></label></div>
				<div class="explorer-summary"><div class="explorer-filters" role="group" aria-label="File filter"><button type="button" data-explorer-scope="all" aria-pressed="true">All files</button><button type="button" data-explorer-scope="edited" aria-pressed="false" title="Files edited in this chat">Edited</button></div><span id="aux-explorer-count" role="status" aria-live="polite"></span></div>
				<div class="aux-tree" id="aux-explorer-tree" role="tree" aria-label="Workspace files"><div class="aux-empty"><span class="spinner"></span><b>Reading the workspace…</b></div></div>
				<div class="aux-fsp" id="aux-explorer-preview" aria-live="polite"></div>
			</div>
			<div id="aux-content-worktrees" class="aux-panel hidden" role="tabpanel"><div class="aux-empty">Loading worktrees…</div></div>
			<div id="aux-content-subagents" class="aux-panel hidden" role="tabpanel">
				<div class="aux-empty">No subagents yet</div>
			</div>
			<div id="aux-content-browser" class="aux-panel hidden" role="tabpanel"><div class="aux-empty">Browser snapshots appear after browser activity.</div></div>
			<div id="aux-content-terminal" class="aux-panel hidden" role="tabpanel">
				<div class="term-head">
					<span class="term-cwd" id="term-cwd" title="Working directory"></span>
					<span class="term-actions">
						<button class="icon-btn" id="term-copy" title="Copy output" aria-label="Copy output" data-icon="copy" disabled></button>
						<button class="icon-btn" id="term-clear" title="Clear the terminal" aria-label="Clear the terminal" data-icon="trash"></button>
						<button class="icon-btn" id="term-stop" title="Stop the running command" aria-label="Stop the running command" data-icon="stop"></button>
					</span>
				</div>
				<div class="term-meta"><span id="term-shell">Shell</span><span id="term-status" role="status">Ready</span></div>
				<div class="term-out" id="term-out" role="log" aria-live="polite" tabindex="0" aria-label="Terminal output"></div>
				<button class="term-latest" id="term-latest" hidden>Jump to latest</button>
				<div class="term-hint" id="term-hint">One command at a time · No interactive input or TUI · Ctrl+C stops</div>
				<div class="term-in">
					<span class="term-chev" aria-hidden="true">&gt;</span>
					<input id="term-input" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Run a command…" aria-label="Terminal command" aria-describedby="term-hint">
				</div>
			</div>
			<div id="aux-content-files" class="aux-panel hidden" role="tabpanel">
				<div class="aux-empty">No files changed yet</div>
			</div>
			<div id="aux-content-uploads" class="aux-panel hidden" role="tabpanel">
				<div class="aux-empty">No uploads yet</div>
			</div>
			
		</div>
	</aside>
	</div>

	<aside id="history" class="drawer hl" aria-label="History">
		<div class="hl-shell" id="hl-shell">
			<nav class="hl-rail" aria-label="History sections">
				<button id="btn-history-close" class="hl-rail-btn" title="Close history" aria-label="Close" data-icon="close"></button>
				<span class="hl-rail-sep" aria-hidden="true"></span>
				<span class="hl-rail-spacer"></span>
				<button id="btn-history-new" class="hl-rail-btn primary" title="New chat" aria-label="New chat" data-icon="plus"></button>
			</nav>
			<div class="hl-side">
				<div class="hl-side-top">
					<button class="hl-workspace" id="hl-workspace" title="This workspace" aria-haspopup="menu" aria-expanded="false">
						<span class="hl-logo" aria-hidden="true"></span>
						<span id="hl-workspace-name">Workspace</span>
						<span class="chev" data-icon="chevronDown"></span>
					</button>
					<button id="btn-folder-new" class="hl-icon-btn" title="New folder" aria-label="New folder" data-icon="folderPlus"></button>
					<button id="btn-history-import" class="hl-icon-btn" title="Continue a Claude Code or Codex chat" aria-label="Import a chat" data-icon="swap"></button>
				</div>
				<div class="hl-side-title">
					<span class="hl-side-title-text" id="history-title">Library</span>
					<span class="hl-side-title-tools"><button id="hl-side-toggle" class="hl-icon-btn" title="Hide the folder panel" aria-label="Hide the folder panel" aria-pressed="false" data-icon="panelRight"></button></span>
				</div>
				<label class="hl-search">
					<span data-icon="search"></span>
					<input id="history-search" type="search" autocomplete="off" aria-label="Search chats" placeholder="Search">
					<span class="hl-kbd" aria-hidden="true">⌘K</span>
					<button id="history-search-clear" class="hl-icon-btn hidden" title="Clear search" aria-label="Clear search" data-icon="close"></button>
				</label>
				<div class="hl-tree" id="hl-tree" aria-label="Chat folders"></div>
				<div class="hl-side-foot" id="history-stats"></div>
			</div>
			<section class="hl-main">
				<header class="hl-top">
					<div class="hl-crumbs">
						<button class="hl-crumb" id="hl-crumb-root">History</button>
						<i aria-hidden="true">/</i>
						<button class="hl-crumb is-current" id="hl-crumb-current" aria-haspopup="menu" aria-expanded="false"><span id="hl-crumb-label">All chats</span><span class="chev" data-icon="chevronDown"></span></button>
					</div>
					<div class="hl-top-actions">
						<div class="hl-stack" id="hl-stack" aria-hidden="true"></div>
						<button id="history-reset" class="hl-ghost hidden">Reset</button>
						<button id="history-select" class="hl-ghost" aria-pressed="false">Select</button>
						<button id="btn-history-new-top" class="hl-primary"><span data-icon="plus"></span>New chat</button>
					</div>
				</header>
				<div class="hl-body" id="hl-body">
					<div class="hl-section">
						<h2>Folders <span class="hl-count" id="hl-folders-count">0</span></h2>
					</div>
					<div class="hl-folders" id="hl-folders"></div>
					<div class="hl-section">
						<h2>Chats <span class="hl-count" id="history-results" role="status"></span></h2>
						<div class="hl-section-tools">
							<label id="history-select-all-wrap" class="hl-check-all hidden"><input id="history-select-all" type="checkbox" aria-label="Select all matching chats"></label>
							<button id="hl-sort-btn" class="hl-ghost" aria-haspopup="menu" aria-expanded="false"><span data-icon="arrowDown"></span><span id="hl-sort-label">Newest</span></button>
							<select id="history-sort" class="hidden" aria-label="Sort chats"></select>
						</div>
					</div>
					<div class="hl-table">
						<div class="hl-thead" aria-hidden="true">
							<span class="hl-col-check"></span>
							<span></span>
							<span>Name</span>
							<span class="hl-col-model">Model</span>
							<span class="hl-col-count">Chats</span>
							<span class="hl-col-when">Updated</span>
							<span></span>
						</div>
						<div id="history-list" class="hl-rows" role="tabpanel" aria-labelledby="history-tab-chats"></div>
					</div>
				</div>
				<div id="history-bulk" class="hl-bulk hidden" role="toolbar" aria-label="Manage selected chats">
					<span id="history-selection-count" class="hl-bulk-count"></span>
					<button id="history-bulk-move" class="hl-btn-secondary"><span data-icon="folder"></span><span id="history-move-label">Move to</span></button>
					<button id="history-bulk-archive" class="hl-btn-secondary accent"><span data-icon="archive"></span><span id="history-archive-label">Archive</span></button>
					<button id="history-bulk-clear" class="hl-icon-btn" title="Clear selection" aria-label="Clear selection" data-icon="close"></button>
				</div>
				<div id="hl-toast" class="hl-toast hidden" role="status" aria-live="polite"></div>
			</section>
		</div>
		<svg class="hl-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
			<linearGradient id="hl-fd-body" x1="0" y1="0" x2="0.28" y2="1"><stop offset="0" stop-color="var(--hl-fd-top, #34343a)"/><stop offset="1" stop-color="var(--hl-fd-bottom, #1d1d21)"/></linearGradient>
		</defs></svg>
	</aside>

	<div id="lightbox" class="lightbox hidden" role="dialog" aria-modal="true" aria-label="Image viewer" aria-describedby="lightbox-help">
		<div class="lightbox-toolbar" role="toolbar" aria-label="Image controls">
			<button type="button" class="btn btn-ghost" data-image-action="out" aria-label="Zoom out" title="Zoom out (−)">−</button>
			<output class="lightbox-scale" aria-label="Zoom relative to fitted image">100%</output>
			<button type="button" class="btn btn-ghost" data-image-action="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
			<button type="button" class="btn btn-ghost" data-image-action="fit" title="Fit image (0)">Fit</button>
			<button type="button" class="btn btn-ghost" data-image-action="close" aria-label="Close image viewer" title="Close (Esc)">Close</button>
		</div>
		<div class="lightbox-viewport"><img id="lightbox-img" alt="Image preview" draggable="false"><p class="lightbox-error hidden" role="status">This image could not be loaded.</p></div>
		<div id="lightbox-cap" class="lightbox-cap"></div>
		<p id="lightbox-help" class="lightbox-help">Scroll to zoom · Drag to pan · Double-click to zoom · + / − Zoom · 0 Fit · Arrow keys Pan · Esc Close</p>
	</div>
</div>
<div id="settings-root"></div>
<div id="dialog-root"></div>
<div id="toast" class="toast hidden" role="status"></div>`;
