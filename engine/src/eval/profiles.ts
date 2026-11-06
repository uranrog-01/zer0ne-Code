import { createHash } from 'crypto';
import type { AgentSettings, ModelEntry, ProviderConfig } from '../providerStore';
import type { ReasoningEffort } from '../reasoning';
import { requestProfileFor, type RequestProfile } from '../requestProfile';
import { productionSettings } from './production';

export type ProfileName = 'current' | 'thorough' | 'lean' | 'strict';
export interface EvalProfile {
	name: ProfileName;
	id: string;
	kind: 'core' | 'production';
	settings: Partial<AgentSettings>;
	request: RequestProfile;
	tools: 'auto' | 'lean' | 'full';
}
export function evalProfile(name: ProfileName, kind: EvalProfile['kind'], settings: Partial<AgentSettings>, provider: ProviderConfig, model: ModelEntry, effort?: ReasoningEffort): EvalProfile {
	const control = requestProfileFor(settings, provider, model).reasoningControl!;
	const preferred = name === 'thorough' ? 'high' : name === 'lean' ? 'low' : effort;
	const selected = preferred && control.levels.includes(preferred) ? preferred : effort;
	const tools = name === 'current' ? settings.toolProfile ?? 'auto' : name === 'lean' ? 'lean' : 'full';
	const snapshot = productionSettings({ ...settings, toolProfile: tools, ...(name === 'strict' ? { strictTools: 'on' as const } : {}) });
	const request: RequestProfile = { ...requestProfileFor(snapshot, provider, model, selected), maxTokens: model.maxOutput };
	const id = createHash('sha256').update(JSON.stringify({ name, kind, snapshot, request, model: model.id, endpoint: provider.baseUrl, context: model.contextWindow })).digest('hex');
	return { name, id, kind, settings: snapshot, request, tools };
}
export function evalOptions(raw: Record<string, unknown>): { kind: EvalProfile['kind']; profiles: ProfileName[]; trials: number } {
	if (raw.execution !== undefined && !['core', 'production'].includes(String(raw.execution))) throw new Error('Unknown benchmark execution mode.');
	const kind = raw.execution === 'production' ? 'production' : 'core';
	const profiles = raw.profiles === undefined ? ['current'] : raw.profiles;
	if (!Array.isArray(profiles) || !profiles.length || profiles.length > 4 || profiles.some(p => !['current', 'thorough', 'lean', 'strict'].includes(p))) throw new Error('Choose 1–4 known benchmark profiles.');
	const trials = raw.trials === undefined ? 1 : raw.trials;
	if (!Number.isInteger(trials) || Number(trials) < 1 || Number(trials) > 10) throw new Error('Benchmark trials must be between 1 and 10.');
	return { kind, profiles: [...new Set(profiles)] as ProfileName[], trials: Number(trials) };
}
