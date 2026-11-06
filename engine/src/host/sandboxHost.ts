import * as vscode from 'vscode';
import { HostContext, HostFeature, HostSurface } from './context';
import { denyReadPaths, prepareWorkspace, sandboxDenyPaths, sandboxStatus, unprepareWorkspace } from '../tools/sandbox';
import { addCommandRule, commandRulesStatus, trustCommandRules, untrustCommandRules } from '../tools/commandRules';

/** Settings → Agent: the command sandbox (its status, preparing a Windows project or undoing it) and trusting the project's command rules. */
export class SandboxHost implements HostFeature {
	constructor(
		private readonly ctx: HostContext,
		private readonly storageDir: string,
		private readonly sourceFile: string
	) {}

	private root(): string | undefined {
		const f = vscode.workspace.workspaceFolders?.[0];
		return f?.uri.scheme === 'file' ? f.uri.fsPath : undefined;
	}

	/** The user's deny list plus what the app protects on its own. */
	private denyRead(): string[] {
		return sandboxDenyPaths(this.ctx.store.getSettings(), this.storageDir);
	}

	/** How many paths the user chose (the app's own data is separate). */
	private userDenyRead(): number {
		return denyReadPaths(this.ctx.store.getSettings().sandboxDenyRead).length;
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		if (msg.type === 'sandboxStatus') {
			surface.post({ type: 'sandboxStatus', status: sandboxStatus(this.root(), this.storageDir, this.sourceFile, this.denyRead(), this.userDenyRead()), platform: process.platform });
			return true;
		}
		if (msg.type === 'sandboxPrepare' || msg.type === 'sandboxUnprepare') {
			const root = this.root();
			// A phone can see the status; changing a folder's permissions happens on the desktop.
			if (surface.kind === 'remote') this.ctx.status('Prepare the sandbox from the desktop app.', 'error');
			else if (!root) this.ctx.status('Open a project folder first.', 'error');
			else if (process.platform !== 'win32') this.ctx.status(sandboxStatus(root, this.storageDir, this.sourceFile, this.denyRead(), this.userDenyRead()).detail, '');
			else {
				try {
					if (msg.type === 'sandboxPrepare') {
						await prepareWorkspace(root, this.storageDir, this.sourceFile, this.denyRead());
						this.ctx.status('Sandbox ready: commands in this project can write only inside it and its sandbox temp folder.', 'ok');
					} else {
						await unprepareWorkspace(root, this.storageDir, this.sourceFile);
						this.ctx.status('Sandbox access removed from this project. Commands require approval again.', 'ok');
					}
				} catch (error) {
					this.ctx.status(error instanceof Error ? error.message : String(error), 'error');
				}
			}
			surface.post({ type: 'sandboxStatus', status: sandboxStatus(root, this.storageDir, this.sourceFile, this.denyRead(), this.userDenyRead()), platform: process.platform });
			return true;
		}
		if (msg.type === 'addCommandRule') {
			// Ask and deny only tighten what runs, so the phone may add them too.
			const root = this.root();
			const verdict = msg.verdict === 'deny' ? 'deny' : msg.verdict === 'ask' ? 'ask' : undefined;
			if (!root || !verdict) this.ctx.status(root ? 'Choose ask or deny.' : 'Open a project folder first.', 'error');
			else {
				try {
					const pattern = String(msg.pattern ?? '');
					const added = addCommandRule(root, verdict, pattern);
					this.ctx.status(added ? `Added to .zer0ne/command-rules: ${verdict}: ${pattern}` : `.zer0ne/command-rules already has ${verdict}: ${pattern}`, 'ok');
				} catch (error) {
					this.ctx.status(error instanceof Error ? error.message : String(error), 'error');
				}
			}
			surface.post({ type: 'commandRulesStatus', status: root ? commandRulesStatus(root) : null });
			return true;
		}
		if (msg.type === 'commandRulesStatus' || msg.type === 'commandRulesTrust' || msg.type === 'commandRulesUntrust') {
			const root = this.root();
			if (msg.type !== 'commandRulesStatus') {
				// Trusting lets commands run without a card; that decision is made at the desktop.
				if (surface.kind === 'remote') this.ctx.status('Trust command rules from the desktop app.', 'error');
				else if (!root) this.ctx.status('Open a project folder first.', 'error');
				else {
					try {
						if (msg.type === 'commandRulesTrust') {
							trustCommandRules(root);
							this.ctx.status('Command rules trusted. Their allow lines now run without a card; a later change that loosens them waits for you again.', 'ok');
						} else {
							untrustCommandRules(root);
							this.ctx.status('Command rules no longer trusted. Allow lines wait for you; deny and ask lines still apply.', 'ok');
						}
					} catch (error) {
						this.ctx.status(error instanceof Error ? error.message : String(error), 'error');
					}
				}
			}
			surface.post({ type: 'commandRulesStatus', status: root ? commandRulesStatus(root) : null });
			return true;
		}
		return false;
	}
}
