/**
 * Browse-event capture orchestration (m19, SPEC §13).
 *
 * Everything that decides WHETHER and WHAT to record lives here — the opt-in
 * gate, capture-session boundaries (`bootId` + `capture_start`/`capture_stop`),
 * enrichment, and the drain triggers. The
 * background service worker is left as pure Chrome glue: it translates events
 * into these calls and injects the adapters (extension/AGENTS.md — no Chrome
 * imports in `src/`).
 *
 * Gating (SPEC §13 — "off means OFF"): every `record*` method returns without
 * observing, buffering or enriching ANYTHING while the toggle is off. The one
 * event captured with the toggle off is `capture_stop`, emitted by
 * `handleToggleChange` at the disable edge — the capture's own final edge.
 */

import type {
	BrowseBuffer,
	BrowseEventFactory,
	CaptureSession,
} from "./browseEvents";
import { parseCaptureToggle, shouldDrainAfterAppend } from "./browseEvents";
import type { BrowseEvent } from "./types";

/** What `tabs.get` contributes to an event (all optional). */
export interface TabInfo {
	tabId?: number;
	url?: string;
	title?: string;
}

export interface NavObservation {
	tabId: number;
	url: string;
	/** The webNavigation event's OWN timeStamp (SPEC §13). */
	occurredAtMs?: number;
	transition?: string;
	documentLifecycle?: string;
}

export interface BrowseCaptureDeps {
	buffer: BrowseBuffer;
	session: CaptureSession;
	events: BrowseEventFactory;
	/** Reads the capture toggle; must resolve false on any failure. */
	isEnabled: () => Promise<boolean>;
	/** `tabs.get` enrichment; undefined when the lookup fails. */
	getTab: (tabId: number) => Promise<TabInfo | undefined>;
	/** Ships whatever the drain enqueued (the outbox flush). */
	flush: () => Promise<void>;
}

export interface BrowseCapture {
	/** `webNavigation.onCommitted` / `onHistoryStateUpdated`, main frame. */
	recordNav(observation: NavObservation): Promise<void>;
	/** `tabs.onActivated` — `activeInfo` always carries both ids. */
	recordTabActivated(input: { tabId: number; windowId: number }): Promise<void>;
	/** `storage.onChanged` on the `attention` key. */
	handleToggleChange(oldValue: unknown, newValue: unknown): Promise<void>;
	/**
	 * Browser startup / install: begin a session when the toggle is on
	 * (minting only if `storage.session` came up empty), and ship whatever
	 * the last run left buffered — even when the toggle is off.
	 */
	start(): Promise<void>;
	/** Drain the buffer into the outbox and flush (alarm + explicit calls). */
	drainAndFlush(): Promise<void>;
}

export function createBrowseCapture(deps: BrowseCaptureDeps): BrowseCapture {
	const { buffer, session, events, isEnabled, getTab, flush } = deps;

	/**
	 * In-worker memo of the current session, so concurrent events can't each
	 * mint a `bootId`. Reset on worker death — `session.ensure()` then reads
	 * the SAME id back out of `chrome.storage.session` and emits nothing
	 * (worker death/revival mid-session is not a capture boundary, §13).
	 */
	let sessionPromise: Promise<string> | undefined;

	const drainAndFlush = async (): Promise<void> => {
		const drained = await buffer.drain();
		// Nothing to ship: the minute-by-minute drain alarm must NOT double as a
		// flush alarm, or a halted queue (broken pairing, offline) would retry
		// every minute instead of the designed 5 (SPEC §6).
		if (drained === 0) return;
		await flush();
	};

	/** Buffer one event, draining once the buffer hits the §13 threshold. */
	const push = async (event: BrowseEvent): Promise<void> => {
		const size = await buffer.append(event);
		if (shouldDrainAfterAppend(size)) await drainAndFlush();
	};

	/** The first event of a capture session is always `capture_start`. */
	const beginSession = async (bootId: string): Promise<void> => {
		await push(events.captureStart({ bootId }));
	};

	const currentBootId = async (): Promise<string> => {
		if (sessionPromise === undefined) {
			const started = (async () => {
				const { bootId, minted } = await session.ensure();
				if (minted) await beginSession(bootId);
				return bootId;
			})();
			// A failed read must not pin a rejected promise for the worker's life.
			sessionPromise = started;
			started.catch(() => {
				if (sessionPromise === started) sessionPromise = undefined;
			});
		}
		return sessionPromise;
	};

	/** The gate: off = nothing observed, enriched or buffered (SPEC §13). */
	const record = async (
		build: (bootId: string) => Promise<BrowseEvent> | BrowseEvent,
	): Promise<void> => {
		if (!(await isEnabled())) return;
		const bootId = await currentBootId();
		await push(await build(bootId));
	};

	return {
		recordNav: (observation) => {
			// Defensive: `url` is REQUIRED for nav (§13) with a server bound of
			// min(1), so an empty url would 400 — and poison-drop — the whole
			// batch it rides in. webNavigation always supplies a url in practice;
			// if one ever arrives empty, skipping the event beats certain loss of
			// up to 500 neighbors.
			if (observation.url === "") return Promise.resolve();
			return record((bootId) =>
				events.nav({
					bootId,
					tabId: observation.tabId,
					url: observation.url,
					occurredAtMs: observation.occurredAtMs,
					transition: observation.transition,
					documentLifecycle: observation.documentLifecycle,
				}),
			);
		},

		recordTabActivated: ({ tabId, windowId }) =>
			record(async (bootId) => {
				// Enrichment is best-effort: a failed lookup omits url AND title,
				// but the activation is still recorded (§13).
				const tab = await getTab(tabId);
				return events.tabActivated({
					bootId,
					tabId,
					windowId,
					url: tab?.url,
					title: tab?.title,
				});
			}),

		handleToggleChange: async (oldValue, newValue) => {
			const edge = parseCaptureToggle(oldValue, newValue);
			if (edge === undefined) return;
			if (edge === "enabled") {
				// A fresh capture session even if storage.session still holds the
				// previous one: the off gap is a session boundary.
				const bootId = await session.restart();
				sessionPromise = Promise.resolve(bootId);
				await beginSession(bootId);
			} else {
				// The capture's own final edge, under the CURRENT bootId — the one
				// event recorded past the gate (§13).
				const bootId = await session.current();
				if (bootId !== undefined) {
					await push(events.captureStop({ bootId }));
				}
				// Drop the session id too: a listener that raced past the gate
				// before the toggle landed would otherwise record UNDER the
				// stopped boot, after its own capture_stop.
				await session.clear();
				sessionPromise = undefined;
			}
			// Ship promptly either way: the start edge shouldn't wait a minute for
			// the alarm, and the stop edge closes out the session.
			await drainAndFlush();
		},

		start: async () => {
			// Buffered events from the previous run ship regardless of the toggle
			// — they were captured while it was on.
			if (await isEnabled()) await currentBootId();
			await drainAndFlush();
		},

		drainAndFlush,
	};
}
