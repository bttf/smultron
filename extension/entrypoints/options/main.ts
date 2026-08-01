// Options page: save API token + base URL to chrome.storage.local, then
// verify pairing with POST {baseUrl}/api/hello (SPEC §6, §7).

import {
	CONFIG_KEY,
	DEFAULT_BASE_URL,
	type ExtensionConfig,
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

void loadConfig();
