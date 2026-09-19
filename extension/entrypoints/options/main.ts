// Options page: save API token + base URL to chrome.storage.local, then
// verify pairing with POST {baseUrl}/api/hello (SPEC §6, §7).
//
// Since m24 it also holds the speed dial editor (SPEC §16) — extension-local,
// independent of pairing, and working without a token.

import {
	addDial,
	type DialError,
	dialIconSources,
	fetchDialMetadata,
	fillDialMetadata,
	readSpeedDial,
	removeDial,
	type SpeedDial,
} from "@/src/speedDial";
import {
	CONFIG_KEY,
	DEFAULT_BASE_URL,
	type ExtensionConfig,
	type KeyValueStorage,
	SPEED_DIAL_KEY,
} from "@/src/types";

function mustGet<T extends Element>(selector: string): T {
	const el = document.querySelector<T>(selector);
	if (el === null) throw new Error(`missing element: ${selector}`);
	return el;
}

const form = mustGet<HTMLFormElement>("#config-form");
const tokenInput = mustGet<HTMLInputElement>("#token");
const baseUrlInput = mustGet<HTMLInputElement>("#base-url");
const saveButton = mustGet<HTMLButtonElement>("#save");
const statusEl = mustGet<HTMLParagraphElement>("#status");
const dialListEl = mustGet<HTMLDivElement>("#dial-list");
const dialUrlInput = mustGet<HTMLInputElement>("#dial-url");
const dialAddButton = mustGet<HTMLButtonElement>("#dial-add");
const dialErrorEl = mustGet<HTMLParagraphElement>("#dial-error");

function setStatus(text: string, kind?: "ok" | "err"): void {
	statusEl.textContent = text;
	statusEl.className = kind ?? "";
}

async function loadConfig(): Promise<void> {
	const raw = (await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as
		| ExtensionConfig
		| undefined;
	if (raw?.token !== undefined) tokenInput.value = raw.token;
	if (raw?.baseUrl !== undefined) baseUrlInput.value = raw.baseUrl;
}

async function saveAndPair(): Promise<void> {
	const token = tokenInput.value.trim();
	const baseUrl = (baseUrlInput.value.trim() || DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	if (token === "") {
		setStatus("Enter an API token first.", "err");
		return;
	}

	const config: ExtensionConfig = { token, baseUrl };
	await browser.storage.local.set({ [CONFIG_KEY]: config });

	saveButton.disabled = true;
	setStatus("Pairing…");
	try {
		const response = await fetch(`${baseUrl}/api/hello`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: "{}",
		});
		if (response.ok) {
			setStatus("Paired ✓", "ok");
		} else {
			setStatus(`Pairing failed: HTTP ${response.status}`, "err");
		}
	} catch (error) {
		setStatus(
			`Pairing failed: ${error instanceof Error ? error.message : String(error)}`,
			"err",
		);
	} finally {
		saveButton.disabled = false;
	}
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	void saveAndPair();
});

// ---------------------------------------------------------------------------
// Speed dial (m24, SPEC §16). Every write is immediate — there is no save
// button for this section — and the list is the storage value, re-read on
// every change rather than held here.

/** `chrome.storage.local` as the injectable shape `src/` speaks. */
const storage: KeyValueStorage = {
	get: async (key) => (await browser.storage.local.get(key))[key],
	set: async (key, value) => {
		await browser.storage.local.set({ [key]: value });
	},
};

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	// Dial names and URLs are user data and come from pages the user visited —
	// they only ever reach the DOM as text.
	if (text !== undefined) node.textContent = text;
	return node;
}

function setDialError(text: string): void {
	dialErrorEl.textContent = text;
}

/** The first character of the name, once every icon source has failed. */
function dialLetter(name: string): string {
	return (Array.from(name)[0] ?? "").toUpperCase();
}

/**
 * The 26 px circular frame (SPEC §16.3): the stored touch icon, then the icon
 * service, then the name's first character. Each `error` advances one step.
 */
function dialIcon(dial: SpeedDial): HTMLElement {
	const frame = el("span", "dial-icon");
	const sources = dialIconSources(dial);
	let next = 0;
	const img = el("img");
	img.alt = "";
	img.addEventListener("error", () => {
		const src = sources[next];
		next += 1;
		if (src === undefined) {
			img.remove();
			frame.textContent = dialLetter(dial.name);
			return;
		}
		img.src = src;
	});
	const first = sources[next];
	next += 1;
	if (first === undefined) {
		frame.textContent = dialLetter(dial.name);
		return frame;
	}
	img.src = first;
	frame.append(img);
	return frame;
}

function renderDialRow(dial: SpeedDial): HTMLElement {
	const row = el("div", "dial-row");
	const text = el("div", "dial-text");
	text.append(
		el("div", "dial-name", dial.name),
		el("div", "dial-url", dial.url),
	);
	const remove = el("button", "dial-remove", "✕");
	remove.type = "button";
	remove.setAttribute("aria-label", `Remove ${dial.name}`);
	remove.addEventListener("click", () => {
		void removeDial(storage, dial.id).then(renderDials, () => {
			setDialError("couldn't save");
		});
	});
	row.append(dialIcon(dial), text, remove);
	return row;
}

function renderDials(dials: SpeedDial[]): void {
	if (dials.length === 0) {
		dialListEl.replaceChildren(
			el("p", "dial-empty", "No sites yet — add one below."),
		);
		return;
	}
	dialListEl.replaceChildren(...dials.map(renderDialRow));
}

async function paintDials(): Promise<void> {
	renderDials(await readSpeedDial(storage));
}

/**
 * Add the draft, then try the page itself for a name and a touch icon
 * (SPEC §16.2). The row appears BEFORE the fetch: the add is already written,
 * and the metadata is decoration that may never arrive.
 */
async function onAddDial(): Promise<void> {
	setDialError("");
	let result: Awaited<ReturnType<typeof addDial>>;
	try {
		result = await addDial(storage, dialUrlInput.value, () =>
			crypto.randomUUID(),
		);
	} catch {
		setDialError("couldn't save");
		return;
	}
	if (!result.ok) {
		// An empty draft is a no-op, not an error (SPEC §16.2).
		if (!result.empty) setDialError(result.error satisfies DialError);
		return;
	}
	dialUrlInput.value = "";
	renderDials(result.dials);

	const metadata = await fetchDialMetadata(result.dial.url, fetch);
	if (await fillDialMetadata(storage, result.dial.id, metadata)) {
		await paintDials();
	}
}

dialAddButton.addEventListener("click", () => {
	void onAddDial();
});

dialUrlInput.addEventListener("keydown", (event) => {
	if (event.key !== "Enter") return;
	event.preventDefault();
	void onAddDial();
});

// The error clears on the next keystroke (SPEC §16.2).
dialUrlInput.addEventListener("input", () => {
	setDialError("");
});

// A new tab's reorder shows up in an already-open Options page.
browser.storage.onChanged.addListener((changes, area) => {
	if (area !== "local" || changes[SPEED_DIAL_KEY] === undefined) return;
	void paintDials();
});

void loadConfig();
void paintDials();
