import type { AcpConfigOption, AcpSessionInfo } from './client';
import type { ReasoningControl, ReasoningEffort } from '../reasoning';

const level = (value: string): ReasoningEffort | undefined => {
	const v = value.toLowerCase().trim().replace(/[_ -]/g, '');
	return v === 'max' || v === 'maximum' ? 'maximum' : v === 'extrahigh' ? 'xhigh' : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(v) ? v as ReasoningEffort : v === 'off' || v === 'disabled' ? 'none' : undefined;
};
export function thoughtOption(session: Pick<AcpSessionInfo, 'configOptions'>): AcpConfigOption | undefined {
	const options = (session.configOptions ?? []).filter(o => (!o.type || o.type === 'select') && o.options?.length);
	return options.find(o => o.category === 'thought_level') ?? options.find(o => /^(?:reasoning[_-]effort|thought[_-]level|thinking[_-]level|effort)$/i.test(o.id));
}
export function thoughtControl(session: Pick<AcpSessionInfo, 'configOptions'>): ReasoningControl | undefined {
	const option = thoughtOption(session);
	if (!option) return undefined;
	const flat = (option.options ?? []).flatMap(o => 'value' in o ? [o] : o.options);
	const choices = flat.flatMap(o => { const effort = level(o.value) ?? level(o.name ?? ''); return effort ? [{ effort, value: o.value, name: o.name }] : []; });
	return choices.length ? { protocol: 'agent', configId: option.id, defaultValue: option.currentValue, levels: [...new Set(choices.map(c => c.effort))], choices, note: 'Uses the reasoning choices advertised by this agent. Auto restores its session default; available levels can change with the model.' } : undefined;
}

/** Named effort variants are choices only when the same model actually advertises multiple levels. */
export function variantControls(models: Array<{ id: string; name?: string }>): Map<string, ReasoningControl> {
	const parsed = models.flatMap(model => {
		const display = model.name || model.id;
		const found = /(?:\s*\((none|minimal|low|medium|high|xhigh|max)\)|[-_ ](none|minimal|low|medium|high|xhigh|max))$/i.exec(display);
		if (!found) return [];
		const effort = level(found[1] ?? found[2]);
		return effort ? [{ model, effort, base: display.slice(0, found.index).trim().toLowerCase() }] : [];
	});
	const result = new Map<string, ReasoningControl>();
	for (const item of parsed) {
		const siblings = parsed.filter(p => p.base === item.base);
		const levels = [...new Set(siblings.map(p => p.effort))];
		if (levels.length < 2) continue;
		result.set(item.model.id, { protocol: 'agent', levels, choices: siblings.map(p => ({ effort: p.effort, value: p.model.id, name: p.model.name, model: true })), note: 'This agent exposes effort through separate model variants. Selecting a level uses that exact advertised model ID; Auto keeps the model selected in chat.' });
	}
	return result;
}

export async function applyThoughtLevel(conn: { setConfigOption(sessionId: string, id: string, value: string): Promise<unknown> }, session: AcpSessionInfo, effort: ReasoningEffort | undefined, defaultValue?: string): Promise<AcpSessionInfo> {
	const c = thoughtControl(session);
	if (!c?.configId) {
		if (effort) throw new Error('This agent does not advertise that reasoning control. Choose Auto or select an advertised model variant.');
		return session;
	}
	const value = effort ? c.choices?.find(choice => choice.effort === effort)?.value : defaultValue;
	if (effort && value === undefined) throw new Error('This reasoning level is unavailable for the selected agent model. Choose Auto or fetch its models again.');
	if (value === undefined || thoughtOption(session)?.currentValue === value) return session;
	const response: any = await conn.setConfigOption(session.sessionId, c.configId, value);
	return { ...session, configOptions: Array.isArray(response?.configOptions) ? response.configOptions : session.configOptions?.map(option => option.id === c.configId ? { ...option, currentValue: value } : option) };
}
