/**
 * Attention-tracking primitives (m19, SPEC §13): the opt-in gate, the
 * capture-session (`bootId`) store, the per-kind event constructors, and the
 * storage-backed browse-event buffer.
 *
 * Pure logic only — every dependency (storage, clock, uuid, outbox enqueue)
 * is injected, so the whole thing is unit-testable and contains NO Chrome
 * imports (extension/AGENTS.md). Chrome wiring lives in
 * `entrypoints/background.ts`; the orchestration that sits between the two is
 * `src/attentionCapture.ts`.
 *
 * Buffer discipline (SPEC §13 — loss-proofing):
 * - Appends AND drains serialize through the SAME promise-chain mutex. An
 *   append interleaving into a drain's read→clear window would otherwise be
 *   silently lost.
 * - A drain enqueues the outbox entries FIRST, then removes exactly the
 *   drained events from the buffer by id. Worker death between the two steps
 *   yields a duplicate batch (safe — the server dedupes on `clientEventId`),
 *   never a lost one.
 * - Drop-oldest at BROWSE_BUFFER_CAP: telemetry degrades, bookmark capture
 *   never does.
 */

import { chunk } from "./tree";
import type {
	BrowseEvent,
	BrowseOutboxEntry,
	IdleState,
	KeyValueStorage,
} from "./types";
import {
	BOOT_ID_KEY,
	BROWSE_BATCH_LIMIT,
	BROWSE_BUFFER_CAP,
	BROWSE_BUFFER_KEY,
	BROWSE_DOCUMENT_LIFECYCLE_LIMIT,
	BROWSE_DRAIN_THRESHOLD,
	BROWSE_TITLE_LIMIT,
	BROWSE_TRANSITION_LIMIT,
	BROWSE_URL_LIMIT,
	MAX_TIMESTAMP_MS,
} from "./types";

// ---------------------------------------------------------------------------
// The opt-in gate.

/**
 * Is capture enabled? The `attention` value is `{enabled: boolean}`; ANY
 * other shape — key missing, `undefined`, a stray legacy value — is disabled
 * (SPEC §13: off means off, and the default is off).
 */
export function isCaptureEnabled(raw: unknown): boolean {
	return (
		typeof raw === "object" &&
		raw !== null &&
		(raw as { enabled?: unknown }).enabled === true
	);
}

/**
 * Classify a `storage.onChanged` transition of the `attention` key. Only the
 * EDGES matter: a write that leaves the effective state unchanged (e.g. the
 * popup re-saving `{enabled: true}`) is not a capture-session boundary.
 */
export function parseAttentionToggle(
	oldValue: unknown,
	newValue: unknown,
): "enabled" | "disabled" | undefined {
	const before = isCaptureEnabled(oldValue);
	const after = isCaptureEnabled(newValue);
	if (before === after) return undefined;
	return after ? "enabled" : "disabled";
}

// ---------------------------------------------------------------------------
// Event constructors.
//
// Per-kind required/forbidden fields (SPEC §13) are enforced BY CONSTRUCTION:
// each constructor takes exactly the fields its kind may carry, and optional
// fields are omitted from the object entirely when undefined (the server
// rejects unknown/undeclared fields, and `undefined` survives structuredClone
// into storage where JSON would have dropped it).

/**
 * Clamp a required string field to the server's §13 bounds: length-capped AND
 * stripped of NUL (U+0000). Postgres `text` cannot store a NUL, so the
 * server 400s any field containing one — and a page can put U+0000 into
 * `document.title` via JS, which `tabs.get` enrichment would pass through.
 * One such byte would poison-drop a whole ≤500-event batch.
 */
function truncate(value: string, limit: number): string {
	const clean = value.includes("\u0000")
		? value.replaceAll("\u0000", "")
		: value;
	return clean.length > limit ? clean.slice(0, limit) : clean;
}

/**
 * An OPTIONAL string field: absent when undefined AND when empty (after NUL
 * stripping). Chrome hands out `""` for `Tab.url`/`Tab.title` before a tab
 * commits (routine on ⌘T and open-in-new-tab-and-switch), and the server's
 * bounds are `min(1)` — one empty string would 400, and therefore
 * poison-drop, a whole 500-event batch. Empty means "not known", which is
 * exactly an omitted field.
 */
function optionalText(
	value: string | undefined,
	limit: number,
): string | undefined {
	if (value === undefined) return undefined;
	const clean = truncate(value, limit);
	return clean === "" ? undefined : clean;
}

/**
 * `webNavigation` timestamps are floats and any clock can be absurd; the
 * server requires an integer in [0, MAX_TIMESTAMP_MS] and 400s the WHOLE
 * batch otherwise (which the poison rule would then drop — up to 500 events
 * lost over one bad number).
 */
function normalizeTimestamp(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(Math.max(Math.floor(value), 0), MAX_TIMESTAMP_MS);
}

/**
 * `transition` = `[transitionType, ...transitionQualifiers].join("|")`
 * (SPEC §13), e.g. `typed|from_address_bar`. Undefined when the event
 * carries no transition type at all.
 */
export function formatTransition(
	transitionType: string | undefined,
	transitionQualifiers: readonly string[] | undefined,
): string | undefined {
	if (transitionType === undefined || transitionType === "") return undefined;
	return [transitionType, ...(transitionQualifiers ?? [])].join("|");
}

/**
 * Is this `webNavigation` commit the tab's MAIN frame (SPEC §13)?
 *
 * `frameId === 0` alone is wrong: a **prerendered** outermost frame commits
 * with a NONZERO frameId (which is why Chrome 106 added `frameType` /
 * `documentLifecycle`), and activation fires no second `onCommitted` — so
 * filtering on frameId drops the prerendered page's ONLY nav edge, the exact
 * loss §13's documentLifecycle clause exists to prevent. Prefer `frameType`
 * and fall back to `frameId` only when Chrome didn't supply it.
 */
export function isMainFrameNavigation(details: {
	frameId: number;
	frameType?: string;
}): boolean {
	if (details.frameType !== undefined)
		return details.frameType === "outermost_frame";
	return details.frameId === 0;
}

interface BaseInput {
	bootId: string;
	/** Defaults to `now()`; `nav` passes the webNavigation event's own stamp. */
	occurredAtMs?: number;
}

export interface NavInput extends BaseInput {
	tabId: number;
	url: string;
	windowId?: number;
	transition?: string;
	documentLifecycle?: string;
}

export interface TabActivatedInput extends BaseInput {
	tabId: number;
	windowId: number;
	url?: string;
	title?: string;
}

export interface WindowFocusInput extends BaseInput {
	windowId: number;
	tabId?: number;
	url?: string;
	title?: string;
}

export interface IdleInput extends BaseInput {
	idleState: IdleState;
}

export interface BrowseEventFactory {
	nav(input: NavInput): BrowseEvent;
	tabActivated(input: TabActivatedInput): BrowseEvent;
	windowFocus(input: WindowFocusInput): BrowseEvent;
	windowBlur(input: BaseInput): BrowseEvent;
	idle(input: IdleInput): BrowseEvent;
	captureStart(input: BaseInput): BrowseEvent;
	captureStop(input: BaseInput): BrowseEvent;
}

export interface EventFactoryDeps {
	uuid: () => string;
	now: () => number;
}

export function createEventFactory(deps: EventFactoryDeps): BrowseEventFactory {
	const { uuid, now } = deps;

	const base = (kind: BrowseEvent["kind"], input: BaseInput): BrowseEvent => ({
		id: uuid(),
		bootId: input.bootId,
		kind,
		occurredAtMs: normalizeTimestamp(input.occurredAtMs ?? now()),
	});

	return {
		nav(input) {
			const event = base("nav", input);
			// Required by §13; no `title` — at commit time the tab still has the
			// PREVIOUS page's title.
			event.tabId = input.tabId;
			event.url = truncate(input.url, BROWSE_URL_LIMIT);
			if (input.windowId !== undefined) event.windowId = input.windowId;
			const transition = optionalText(
				input.transition,
				BROWSE_TRANSITION_LIMIT,
			);
			if (transition !== undefined) event.transition = transition;
			const lifecycle = optionalText(
				input.documentLifecycle,
				BROWSE_DOCUMENT_LIFECYCLE_LIMIT,
			);
			// Recorded verbatim when present — prerendered commits are captured
			// WITH the flag rather than dropped (§13).
			if (lifecycle !== undefined) event.documentLifecycle = lifecycle;
			return event;
		},
		tabActivated(input) {
			const event = base("tab_activated", input);
			event.tabId = input.tabId;
			// windowId is REQUIRED: without it a slicer can't tell whether the
			// activation happened in the focused window (§13).
			event.windowId = input.windowId;
			const url = optionalText(input.url, BROWSE_URL_LIMIT);
			if (url !== undefined) event.url = url;
			const title = optionalText(input.title, BROWSE_TITLE_LIMIT);
			if (title !== undefined) event.title = title;
			return event;
		},
		windowFocus(input) {
			const event = base("window_focus", input);
			event.windowId = input.windowId;
			if (input.tabId !== undefined) event.tabId = input.tabId;
			const url = optionalText(input.url, BROWSE_URL_LIMIT);
			if (url !== undefined) event.url = url;
			const title = optionalText(input.title, BROWSE_TITLE_LIMIT);
			if (title !== undefined) event.title = title;
			return event;
		},
		windowBlur(input) {
			return base("window_blur", input);
		},
		idle(input) {
			const event = base("idle", input);
			event.idleState = input.idleState;
			return event;
		},
		captureStart(input) {
			return base("capture_start", input);
		},
		captureStop(input) {
			return base("capture_stop", input);
		},
	};
}

// ---------------------------------------------------------------------------
// Capture sessions (`bootId`).

export interface CaptureSession {
	/** The current session's id, or undefined when none is stored. */
	current(): Promise<string | undefined>;
	/**
	 * Startup/wake path: reuse the stored id (service-worker death keeps its
	 * session — state didn't change while the worker was dead), else mint one.
	 * `minted: true` means a NEW capture session began.
	 */
	ensure(): Promise<{ bootId: string; minted: boolean }>;
	/** Toggle-enable path: ALWAYS a fresh session, replacing any stored id. */
	restart(): Promise<string>;
	/**
	 * End the session (the disable edge, after `capture_stop`). A listener
	 * that raced past the gate must not then record under the stopped boot's
	 * id: with the id gone, such an event opens a NEW session instead of
	 * landing after its own `capture_stop`.
	 */
	clear(): Promise<void>;
}

export interface CaptureSessionDeps {
	/** `chrome.storage.session` — survives worker death, resets on restart. */
	sessionStorage: KeyValueStorage;
	uuid: () => string;
}

export function createCaptureSession(deps: CaptureSessionDeps): CaptureSession {
	const { sessionStorage, uuid } = deps;

	const current = async (): Promise<string | undefined> => {
		const raw = await sessionStorage.get(BOOT_ID_KEY);
		return typeof raw === "string" && raw !== "" ? raw : undefined;
	};

	return {
		current,
		ensure: async () => {
			const existing = await current();
			if (existing !== undefined) return { bootId: existing, minted: false };
			const bootId = uuid();
			await sessionStorage.set(BOOT_ID_KEY, bootId);
			return { bootId, minted: true };
		},
		restart: async () => {
			const bootId = uuid();
			await sessionStorage.set(BOOT_ID_KEY, bootId);
			return bootId;
		},
		// "" rather than a removal: KeyValueStorage is get/set only, and
		// `current()` already reads an empty value as "no session".
		clear: async () => {
			await sessionStorage.set(BOOT_ID_KEY, "");
		},
	};
}

// ---------------------------------------------------------------------------
// The browse-event buffer.

/** A drain triggers right after an append once the buffer reaches §13's mark. */
export function shouldDrainAfterAppend(bufferSize: number): boolean {
	return bufferSize >= BROWSE_DRAIN_THRESHOLD;
}

export interface BrowseBuffer {
	/** Append one event; resolves with the buffer's size afterwards. */
	append(event: BrowseEvent): Promise<number>;
	/**
	 * Package the whole buffer into `browse` outbox entries of ≤500 events,
	 * enqueue them, then remove exactly those events. Resolves with the number
	 * of events drained.
	 */
	drain(): Promise<number>;
	/** Current buffered event count (serialized like every other operation). */
	size(): Promise<number>;
}

export interface BrowseBufferDeps {
	storage: KeyValueStorage;
	/** Appends the entries to the outbox, applying the browse-entry cap. */
	enqueueBrowse: (entries: BrowseOutboxEntry[]) => Promise<void>;
	uuid: () => string;
}

export function createBrowseBuffer(deps: BrowseBufferDeps): BrowseBuffer {
	const { storage, enqueueBrowse, uuid } = deps;

	// ONE mutex over appends AND drains (SPEC §13). The chain always continues,
	// success or failure, so a thrown task can never wedge the buffer.
	let chain: Promise<unknown> = Promise.resolve();
	function serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = chain.then(task, task);
		chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	const read = async (): Promise<BrowseEvent[]> => {
		const raw = await storage.get(BROWSE_BUFFER_KEY);
		return Array.isArray(raw) ? (raw as BrowseEvent[]) : [];
	};

	return {
		append: (event) =>
			serialize(async () => {
				const buffer = await read();
				buffer.push(event);
				// Drop-oldest: telemetry degrades rather than growing unbounded
				// while a flush is halted (broken pairing, long offline stretch).
				const capped =
					buffer.length > BROWSE_BUFFER_CAP
						? buffer.slice(buffer.length - BROWSE_BUFFER_CAP)
						: buffer;
				await storage.set(BROWSE_BUFFER_KEY, capped);
				return capped.length;
			}),

		drain: () =>
			serialize(async () => {
				const buffered = await read();
				if (buffered.length === 0) return 0;
				const entries: BrowseOutboxEntry[] = chunk(
					buffered,
					BROWSE_BATCH_LIMIT,
				).map((events) => ({ id: uuid(), kind: "browse", events }));

				// Enqueue FIRST: dying here re-drains the same events into a
				// duplicate batch (the server dedupes), which beats losing them.
				await enqueueBrowse(entries);

				const drained = new Set(buffered.map((event) => event.id));
				const remaining = (await read()).filter(
					(event) => !drained.has(event.id),
				);
				await storage.set(BROWSE_BUFFER_KEY, remaining);
				return buffered.length;
			}),

		size: () => serialize(async () => (await read()).length),
	};
}
