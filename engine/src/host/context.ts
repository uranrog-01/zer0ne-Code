import type { ProviderStore } from '../providerStore';

/** A webview or remote page the controller talks to. */
export interface HostSurface {
	kind: string;
	post(message: Record<string, unknown>): void;
}

/**
 * What a feature module needs from the controller. Features live in
 * src/host/* and receive this instead of the whole ChatController, so each
 * one can be read, tested and changed on its own.
 */
export interface HostContext {
	readonly store: ProviderStore;
	postAll(message: Record<string, unknown>): void;
	status(message: string, kind?: 'ok' | 'warn' | 'error' | ''): void;
	sendState(): Promise<void>;
}

/** A feature that handles some webview messages; returns true when it took the message. */
export interface HostFeature {
	handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean>;
	dispose?(): void;
}
