

export interface ThreadEvent { id: string; at: number; source: string; text: string }
export interface Thread {
	id: string;
	sessionId: string;
	label: string;
	agents: Set<string>;
	events: ThreadEvent[];
	/** Events before the kept window, so a summary can say how much it left out. */
	dropped: number;
}

const KEEP_EVENTS = 50;
const EVENT_CHARS = 4000;












/** A message in a thread whose agent already finished: that agent continues it, with its context (pure; tested). */
export function resumeHint(agentId: string): string {
	return `Agent ${agentId} worked on this conversation and has finished: if the message continues that work, continue it with agent_send {"id":"${agentId}","message":"…"} so it keeps its context, instead of starting a new agent.`;
}

/** What an agent reads when a message arrives in a conversation it owns (pure; tested). */
export function passThroughMessage(where: string, threadId: string, text: string): string {
	return `[${where} (${threadId})]\n${text}\n\n(This reached you because you own this conversation. If it asks for something outside your task, do not do it: say so in one line at the end of your report, so the main agent can route it.)`;
}

/** A phone answer that ran long: its first sentences up to about `words` words, and where the rest is (pure; tested). */


/** A thread id is a short printable key (th-tg-…, th-pr-…): the model passes it back to recall (pure; tested). */
export function threadId(kind: string, ...parts: Array<string | number>): string {
	return ['th', kind, ...parts].map((p) => String(p).replace(/[^\w.-]+/g, '_')).join('-').slice(0, 120);
}

export class ThreadTable {
	private readonly threads = new Map<string, Thread>();
	private seq = 0;

	/** The thread for an outside conversation, created on its first message. A thread stays with the chat it started in. */
	open(id: string, sessionId: string, label: string): Thread {
		let t = this.threads.get(id);
		if (!t) {
			t = { id, sessionId, label: label.slice(0, 200), agents: new Set(), events: [], dropped: 0 };
			this.threads.set(id, t);
			// Every phone message opens or joins a thread; the oldest ones nobody owns are let go first.
			if (this.threads.size > 300) {
				const idle = [...this.threads.values()].find((x) => !x.agents.size) ?? this.threads.values().next().value!;
				this.threads.delete(idle.id);
			}
		}
		return t;
	}

	get(id: string): Thread | undefined {
		return this.threads.get(id);
	}

	list(sessionId?: string): Thread[] {
		return [...this.threads.values()].filter((t) => !sessionId || t.sessionId === sessionId);
	}

	/** Keep one message of the thread; its id lets the model recall it later. */
	record(threadId: string, source: string, text: string): ThreadEvent | undefined {
		const t = this.threads.get(threadId);
		if (!t) return undefined;
		const ev = { id: `ev${++this.seq}`, at: Date.now(), source: source.slice(0, 60), text: text.slice(0, EVENT_CHARS) };
		t.events.push(ev);
		if (t.events.length > KEEP_EVENTS) {
			t.dropped += t.events.length - KEEP_EVENTS;
			t.events.splice(0, t.events.length - KEEP_EVENTS);
		}
		return ev;
	}

	event(id: string): { thread: Thread; event: ThreadEvent } | undefined {
		for (const thread of this.threads.values()) {
			const event = thread.events.find((e) => e.id === id);
			if (event) return { thread, event };
		}
		return undefined;
	}

	subscribe(threadId: string, agentId: string): boolean {
		const t = this.threads.get(threadId);
		if (!t) return false;
		t.agents.add(agentId);
		return true;
	}

	unsubscribe(threadId: string, agentId: string): boolean {
		return this.threads.get(threadId)?.agents.delete(agentId) ?? false;
	}

	/** The threads an agent owns, newest first. */
	ofAgent(agentId: string): string[] {
		return [...this.threads.values()].filter((t) => t.agents.has(agentId)).map((t) => t.id).reverse();
	}

	/**
	 * Who gets a new message in this thread: the most recently subscribed agent that is still running.
	 * Undefined sends it to the lead (pure given `running`; tested).
	 */
	route(threadId: string, running: (agentId: string) => boolean): string | undefined {
		const t = this.threads.get(threadId);
		if (!t) return undefined;
		return [...t.agents].reverse().find(running);
	}

	/** The agent that owned this thread last, running or not: a finished owner resumes with agent_send instead of a fresh start. */
	owner(threadId: string): string | undefined {
		return [...(this.threads.get(threadId)?.agents ?? [])].at(-1);
	}

	removeAgent(agentId: string): void {
		for (const t of this.threads.values()) t.agents.delete(agentId);
	}

	removeSession(sessionId: string): void {
		for (const t of [...this.threads.values()]) if (t.sessionId === sessionId) this.threads.delete(t.id);
	}
}
