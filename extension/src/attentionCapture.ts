/**
 * Browse-event capture orchestration (m19, SPEC §13).
 *
 * Everything that decides WHETHER and WHAT to record lives here — the opt-in
 * gate, capture-session boundaries (`bootId` + `capture_start`/`capture_stop`
 * + the baseline activation), enrichment, and the drain triggers. The
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
} from "./attention";
import { parseAttentionToggle, shouldDrainAfterAppend } from "./attention";
import type { BrowseEvent, IdleState } from "./types";

/** What `tabs.get` / `tabs.query` contribute to an event (both optional). */
export interface TabInfo {
	tabId?: number;
	url?: string;
	title?: string;
}

/** The synthetic baseline activation's target (SPEC §13). */
export interface BaselineTarget {
	tabId: number;
	windowId: number;
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

export interface AttentionCaptureDeps {
	buffer: BrowseBuffer;
	session: CaptureSession;
	events: BrowseEventFactory;
	/** Reads the `attention` toggle; must resolve false on any failure. */
	isEnabled: () => Promise<boolean>;
	/**
	 * The active tab of the LAST-FOCUSED window, or undefined when no Chrome
	 * window has focus (then the baseline is skipped — the stream starts
	 * blurred until a `window_focus` arrives).
	 */
	getBaselineTarget: () => Promise<BaselineTarget | undefined>;
	/** `tabs.get` enrichment; undefined when the lookup fails. */
	getTab: (tabId: number) => Promise<TabInfo | undefined>;
	/** The active tab of a window; undefined when the query fails. */
	getActiveTabInWindow: (windowId: number) => Promise<TabInfo | undefined>;
	/** Ships whatever the drain enqueued (the outbox flush). */
	flush: () => Promise<void>;
}

export interface AttentionCapture {
	/** `webNavigation.onCommitted` / `onHistoryStateUpdated`, main frame. */
	recordNav(observation: NavObservation): Promise<void>;
	/** `tabs.onActivated` — `activeInfo` always carries both ids. */
	recordTabActivated(input: { tabId: number; windowId: number }): Promise<void>;
	/** `windows.onFocusChanged` with a real window id. */
	recordWindowFocus(windowId: number): Promise<void>;
	/** `windows.onFocusChanged` = WINDOW_ID_NONE. */
	recordWindowBlur(): Promise<void>;
	/** `idle.onStateChanged`. */
	recordIdle(idleState: IdleState): Promise<void>;
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

export function createAttentionCapture(
	deps: AttentionCaptureDeps,
): AttentionCapture {
	const {
		buffer,
		session,
		events,
		isEnabled,
		getBaselineTarget,
		getTab,
		getActiveTabInWindow,
		flush,
	} = deps;

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

	/**
	 * First events of a capture session: `capture_start`, then immediately the
	 * synthetic baseline `tab_activated` so the slicer has an initial dwell
	 * target (skipped when no window has focus).
	 */
	const beginSession = async (bootId: string): Promise<void> => {
		await push(events.captureStart({ bootId }));
		const target = await getBaselineTarget();
		if (target === undefined) return;
		await push(events.tabActivated({ bootId, ...target }));
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
		recordNav: (observation) =>
			record((bootId) =>
				events.nav({
					bootId,
					tabId: observation.tabId,
					url: observation.url,
					occurredAtMs: observation.occurredAtMs,
					transition: observation.transition,
					documentLifecycle: observation.documentLifecycle,
				}),
			),

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

		recordWindowFocus: (windowId) =>
			record(async (bootId) => {
				const tab = await getActiveTabInWindow(windowId);
				return events.windowFocus({
					bootId,
					windowId,
					tabId: tab?.tabId,
					url: tab?.url,
					title: tab?.title,
				});
			}),

		recordWindowBlur: () => record((bootId) => events.windowBlur({ bootId })),

		recordIdle: (idleState) =>
			record((bootId) => events.idle({ bootId, idleState })),

		handleToggleChange: async (oldValue, newValue) => {
			const edge = parseAttentionToggle(oldValue, newValue);
			if (edge === undefined) return;
			if (edge === "enabled") {
				// A fresh capture session even if storage.session still holds the
				// previous one: dwell must never be computed across the off gap.
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
