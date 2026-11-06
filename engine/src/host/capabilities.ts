import type * as vscodeApi from 'vscode';

/** The host's `vscode.env`, loaded lazily: pure modules (plugins, tools) import this file outside any host. */
function hostEnv(): (typeof vscodeApi.env & { desktopServiceOwner?: boolean }) | undefined {
	try {
		return (require('vscode') as typeof vscodeApi).env;
	} catch {
		return undefined;
	}
}

export const DESKTOP_CAPABILITIES = Object.freeze({
	id: 'desktop',
	editor: false,
	diagnostics: false,
	debugger: false,
	languageModels: false,
	subscriptionAgents: true,
	scheduling: false,
	cloud: true,
	remote: true,
	remoteTunnels: true,
	channels: false,
	cli: false,
	mods: false,
	plugins: true,
	hooks: true,
	marketplace: true,
	modelFinder: false,
	embeddedBrowser: false,
	settingsSections: ['general', 'appearance', 'models', 'local', 'browser', 'agent', 'memory', 'features', 'plugins', 'skills', 'hooks', 'mcp', 'cloud', 'remote', 'usage', 'about'],
	removedSettings: ['verifyDiagnostics', 'reviewInEditor', 'debugTools', 'autocomplete', 'autocompleteModel', 'scheduledTasks', 'mods'],
});

export function isDesktopHost(): boolean {
	return hostEnv()?.appName === 'zer0ne Code';
}

export function desktopServicesOwned(): boolean {
	return !isDesktopHost() || hostEnv()?.desktopServiceOwner !== false;
}

// Saved extension settings cannot enable a service absent from this host.
export function hostSettings<T extends object>(settings: T, runtime = true): T {
	if (!isDesktopHost()) return settings;
	return { ...settings, ...(runtime && !desktopServicesOwned() ? { mcp:false, browserAgent:false, remoteEnabled:false } : {}), verifyDiagnostics: false, reviewInEditor: false, debugTools: false, autocomplete: false, autocompleteModel: '', scheduledTasks: false, mods: false };
}

const EDITOR_TOOLS = new Set(['get_diagnostics', 'get_editor_context', 'code_intel', 'rename_symbol', 'edit_symbol']);
export function hostToolAllowed(name: string): boolean {
	return !isDesktopHost() || (!EDITOR_TOOLS.has(name) && !name.startsWith('debug_') && name !== 'schedule_task');
}

export function hostProviderAllowed(provider: { apiFormat?: string; auth?: string }): boolean {
	return !isDesktopHost() || (provider.apiFormat !== 'vscode-lm' && provider.auth !== 'vscode');
}

export function hostMessageAllowed(type: string): boolean {
	if (!isDesktopHost()) return true;
	return !/^(finder|analysis|cli|telegram|discord|ntfy|channels|mods|mod[A-Z]|toggleMod$|hideMod|restartMod|newMod|reloadMods|installMod|removeMod|openModsFolder|keepMod|validateMod)/.test(type)
		&& !['showModsHelp', 'jobs', 'saveJob', 'deleteJob', 'runJob', 'readJobResults', 'stopJobRun', 'openJobResult', 'openJobSession', 'openBrowserWindow'].includes(type);
}
