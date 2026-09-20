import { describe, expect, it, vi } from "vitest";
import {
	addDial,
	DIAL_NAME_LIMIT,
	dialHostName,
	dialIconSources,
	dialIconUrl,
	extractTitle,
	extractTouchIcon,
	fetchDialMetadata,
	fillDialMetadata,
	HTML_SCAN_LIMIT,
	parseDialUrl,
	readSpeedDial,
	removeDial,
	reorderSpeedDial,
	SPEED_DIAL_CAP,
	type SpeedDial,
	sameDials,
} from "./speedDial";
import { type KeyValueStorage, SPEED_DIAL_KEY } from "./types";

function memoryStorage(
	initial: Record<string, unknown> = {},
): KeyValueStorage & { values: Record<string, unknown> } {
	const values = { ...initial };
	return {
		values,
		async get(key) {
			return values[key];
		},
		async set(key, value) {
			values[key] = value;
		},
	};
}

/** Storage holding `dials`, the shape the `speedDial` key actually carries. */
function dialStorage(dials: unknown) {
	return memoryStorage({ [SPEED_DIAL_KEY]: { dials } });
}

function dial(over: Partial<SpeedDial> = {}): SpeedDial {
	return {
		id: "id-1",
		name: "example.com",
		url: "https://example.com/",
		...over,
	};
}

/** What the storage value holds now, as a plain list of ids. */
function storedIds(storage: { values: Record<string, unknown> }): string[] {
	const value = storage.values[SPEED_DIAL_KEY] as
		| { dials?: SpeedDial[] }
		| undefined;
	return (value?.dials ?? []).map((entry) => entry.id);
}

function htmlResponse(
	body: string,
	status = 200,
	type = "text/html",
): Response {
	return new Response(body, { status, headers: { "Content-Type": type } });
}

/** The request a mocked fetch actually received, typed for assertions. */
function firstCall(fetchImpl: ReturnType<typeof vi.fn>): [string, RequestInit] {
	const call = fetchImpl.mock.calls[0];
	if (call === undefined) throw new Error("fetch was never called");
	return call as [string, RequestInit];
}

let minted = 0;
function mintId(): string {
	minted += 1;
	return `minted-${minted}`;
}

describe("parseDialUrl", () => {
	it("prepends https:// to a bare host and returns the canonical href", () => {
		expect(parseDialUrl("example.com")).toEqual({
			ok: true,
			url: "https://example.com/",
		});
	});

	it("leaves an explicit scheme alone, case-insensitively", () => {
		expect(parseDialUrl("http://example.com/a")).toEqual({
			ok: true,
			url: "http://example.com/a",
		});
		// `HTTPS://` must not collect a second `https://` prefix.
		expect(parseDialUrl("HTTPS://Example.com")).toEqual({
			ok: true,
			url: "https://example.com/",
		});
	});

	it("trims the draft", () => {
		expect(parseDialUrl("  https://example.com/a  ")).toEqual({
			ok: true,
			url: "https://example.com/a",
		});
	});

	it("keeps the query and fragment the user typed", () => {
		expect(parseDialUrl("example.com/a?b=1#c")).toEqual({
			ok: true,
			url: "https://example.com/a?b=1#c",
		});
	});

	it("treats an empty or whitespace-only draft as a no-op, not an error", () => {
		expect(parseDialUrl("")).toEqual({ ok: false, empty: true });
		expect(parseDialUrl("   ")).toEqual({ ok: false, empty: true });
	});

	it("rejects a non-http(s) scheme", () => {
		// None of these carry an http(s) prefix, so each is first given one —
		// and `https://ftp://example.com` has no hostname worth dialling.
		for (const draft of [
			"ftp://example.com",
			"javascript:alert(1)",
			"chrome://extensions",
			"file:///etc/hosts",
		]) {
			expect(parseDialUrl(draft)).toEqual({
				ok: false,
				empty: false,
				error: "not a valid URL",
			});
		}
	});

	it("rejects a dotless host but accepts localhost", () => {
		expect(parseDialUrl("example")).toEqual({
			ok: false,
			empty: false,
			error: "not a valid URL",
		});
		expect(parseDialUrl("localhost:3000")).toEqual({
			ok: true,
			url: "https://localhost:3000/",
		});
		expect(parseDialUrl("http://localhost:3000/feed")).toEqual({
			ok: true,
			url: "http://localhost:3000/feed",
		});
	});

	it("rejects a draft that cannot be parsed at all", () => {
		expect(parseDialUrl("https://")).toEqual({
			ok: false,
			empty: false,
			error: "not a valid URL",
		});
	});

	it("rejects userinfo, which is how a mailto: draft survives the prepend", () => {
		for (const draft of [
			"mailto:a@example.com",
			"https://user:pass@example.com",
			"user@example.com",
		]) {
			expect(parseDialUrl(draft)).toEqual({
				ok: false,
				empty: false,
				error: "not a valid URL",
			});
		}
	});
});

describe("dialHostName", () => {
	it("drops a leading www. and nothing else", () => {
		expect(dialHostName("https://www.example.com/a")).toBe("example.com");
		expect(dialHostName("https://wwworld.example.com/")).toBe(
			"wwworld.example.com",
		);
		expect(dialHostName("https://news.example.com/")).toBe("news.example.com");
	});

	it("returns the raw string when there is no URL to read", () => {
		expect(dialHostName("not a url")).toBe("not a url");
	});
});

describe("dialIconUrl", () => {
	it("asks the icon service for the encoded ORIGIN at size 128", () => {
		expect(dialIconUrl("https://example.com/deep/path?q=1")).toBe(
			"https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https%3A%2F%2Fexample.com&size=128",
		);
	});

	it("encodes a port in the origin", () => {
		expect(dialIconUrl("http://localhost:3000/x")).toContain(
			"url=http%3A%2F%2Flocalhost%3A3000&size=128",
		);
	});
});

describe("dialIconSources", () => {
	it("tries the stored touch icon first, then the service", () => {
		expect(
			dialIconSources(
				dial({ iconUrl: "https://example.com/apple-touch-icon.png" }),
			),
		).toEqual([
			"https://example.com/apple-touch-icon.png",
			dialIconUrl("https://example.com/"),
		]);
	});

	it("is the service alone when nothing was stored", () => {
		expect(dialIconSources(dial())).toEqual([
			dialIconUrl("https://example.com/"),
		]);
	});

	it("lists a stored icon that IS the service URL only once", () => {
		const service = dialIconUrl("https://example.com/");
		expect(dialIconSources(dial({ iconUrl: service }))).toEqual([service]);
	});

	// The s2 endpoint the log rows use serves 16–32 px favicons (SPEC §16.3).
	it("never offers the s2 favicon endpoint", () => {
		for (const src of dialIconSources(
			dial({ iconUrl: "https://example.com/touch.png" }),
		)) {
			expect(src).not.toContain("s2/favicons");
		}
	});
});

describe("sameDials", () => {
	const a = dial({ id: "a", url: "https://a.test/" });
	const b = dial({ id: "b", url: "https://b.test/" });

	it("is true for the same row, field for field", () => {
		expect(sameDials([a, b], [{ ...a }, { ...b }])).toBe(true);
		expect(sameDials([], [])).toBe(true);
	});

	it("is false on a different length or a different order", () => {
		expect(sameDials([a, b], [a])).toBe(false);
		expect(sameDials([a, b], [b, a])).toBe(false);
	});

	it("is false when a name, url or icon differs", () => {
		expect(sameDials([a], [{ ...a, name: "Renamed" }])).toBe(false);
		expect(sameDials([a], [{ ...a, url: "https://a.test/x" }])).toBe(false);
		// A fill that landed is exactly the change the echo skip must NOT skip.
		expect(sameDials([a], [{ ...a, iconUrl: "https://a.test/t.png" }])).toBe(
			false,
		);
		expect(sameDials([{ ...a, iconUrl: "https://a.test/t.png" }], [a])).toBe(
			false,
		);
	});
});

describe("readSpeedDial", () => {
	it("is empty when the key is absent", async () => {
		await expect(readSpeedDial(memoryStorage())).resolves.toEqual([]);
	});

	it("is empty for a corrupt or legacy value", async () => {
		for (const raw of ["nope", 7, null, [], { dials: "nope" }, {}]) {
			const storage = memoryStorage({ [SPEED_DIAL_KEY]: raw });
			await expect(readSpeedDial(storage)).resolves.toEqual([]);
		}
	});

	it("is empty when the storage read itself fails", async () => {
		// A new tab paints this before anything else — it must never throw.
		const storage: KeyValueStorage = {
			get: async () => {
				throw new Error("storage is gone");
			},
			set: async () => undefined,
		};
		await expect(readSpeedDial(storage)).resolves.toEqual([]);
	});

	it("skips entries that are not a usable dial", async () => {
		const storage = dialStorage([
			dial({ id: "a" }),
			null,
			"nope",
			{ id: "", name: "x", url: "https://a.test/" },
			{ id: "b", name: 7, url: "https://b.test/" },
			{ id: "c", name: "c", url: "ftp://c.test/" },
			{ id: "d", name: "d" },
			dial({ id: "e", url: "https://e.test/" }),
		]);
		const dials = await readSpeedDial(storage);
		expect(dials.map((entry) => entry.id)).toEqual(["a", "e"]);
	});

	it("keeps an entry whose iconUrl is unusable, dropping only the icon", async () => {
		const storage = dialStorage([
			dial({ id: "a", url: "https://a.test/", iconUrl: "not a url" }),
			dial({ id: "b", url: "https://b.test/", iconUrl: "/relative.png" }),
			dial({ id: "c", url: "https://c.test/", iconUrl: 7 as never }),
			dial({
				id: "d",
				url: "https://d.test/",
				iconUrl: "javascript:alert(1)",
			}),
			dial({
				id: "e",
				url: "https://e.test/",
				iconUrl: "https://e.test/t.png",
			}),
		]);
		const dials = await readSpeedDial(storage);
		expect(dials.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e"]);
		expect(dials.slice(0, 4).map((entry) => entry.iconUrl)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(dials[4]?.iconUrl).toBe("https://e.test/t.png");
	});

	it("keeps the first of a repeated id", async () => {
		const storage = dialStorage([
			dial({ id: "a", name: "first" }),
			dial({ id: "a", name: "second" }),
			dial({ id: "b", name: "b" }),
		]);
		const dials = await readSpeedDial(storage);
		expect(dials.map((entry) => entry.name)).toEqual(["first", "b"]);
	});

	it("truncates to the cap", async () => {
		const stored = Array.from({ length: SPEED_DIAL_CAP + 5 }, (_, i) =>
			dial({ id: `id-${i}`, url: `https://s${i}.test/` }),
		);
		const dials = await readSpeedDial(dialStorage(stored));
		expect(dials).toHaveLength(SPEED_DIAL_CAP);
		expect(dials[SPEED_DIAL_CAP - 1]?.id).toBe(`id-${SPEED_DIAL_CAP - 1}`);
	});
});

describe("addDial", () => {
	it("appends at the end with a minted id and the hostname as the name", async () => {
		const storage = dialStorage([dial({ id: "a", url: "https://a.test/" })]);
		const result = await addDial(storage, "www.example.com", () => "new-id");
		if (!result.ok) throw new Error("expected the add to succeed");
		// The URL keeps the `www.` the user typed; only the NAME drops it.
		expect(result.dial).toEqual({
			id: "new-id",
			name: "example.com",
			url: "https://www.example.com/",
		});
		expect(result.dials.map((entry) => entry.id)).toEqual(["a", "new-id"]);
		expect(storedIds(storage)).toEqual(["a", "new-id"]);
	});

	it("passes a draft error straight through without writing", async () => {
		const storage = memoryStorage();
		const set = vi.spyOn(storage, "set");
		expect(await addDial(storage, "ftp://x.test", mintId)).toEqual({
			ok: false,
			empty: false,
			error: "not a valid URL",
		});
		expect(await addDial(storage, "   ", mintId)).toEqual({
			ok: false,
			empty: true,
		});
		expect(set).not.toHaveBeenCalled();
	});

	it("refuses a URL already in the list", async () => {
		const storage = dialStorage([dial({ id: "a", url: "https://a.test/" })]);
		const minter = vi.fn(mintId);
		// The canonical href is what is compared, so a bare draft collides too.
		expect(await addDial(storage, "a.test", minter)).toEqual({
			ok: false,
			empty: false,
			error: "already added",
		});
		expect(minter).not.toHaveBeenCalled();
		expect(storedIds(storage)).toEqual(["a"]);
	});

	it("refuses an add past the cap", async () => {
		const stored = Array.from({ length: SPEED_DIAL_CAP }, (_, i) =>
			dial({ id: `id-${i}`, url: `https://s${i}.test/` }),
		);
		const storage = dialStorage(stored);
		expect(await addDial(storage, "https://new.test/", mintId)).toEqual({
			ok: false,
			empty: false,
			error: "speed dial is full",
		});
		expect(storedIds(storage)).toHaveLength(SPEED_DIAL_CAP);
	});

	it("reports a duplicate before the cap", async () => {
		const stored = Array.from({ length: SPEED_DIAL_CAP }, (_, i) =>
			dial({ id: `id-${i}`, url: `https://s${i}.test/` }),
		);
		expect(await addDial(dialStorage(stored), "s0.test", mintId)).toEqual({
			ok: false,
			empty: false,
			error: "already added",
		});
	});

	it("builds on a fresh read rather than a stale list", async () => {
		const storage = dialStorage([dial({ id: "a", url: "https://a.test/" })]);
		// Another writer (an open new tab's reorder) lands first.
		storage.values[SPEED_DIAL_KEY] = {
			dials: [dial({ id: "b", url: "https://b.test/" })],
		};
		const result = await addDial(storage, "c.test", () => "c");
		if (!result.ok) throw new Error("expected the add to succeed");
		expect(storedIds(storage)).toEqual(["b", "c"]);
	});
});

describe("removeDial", () => {
	it("writes the shortened list immediately", async () => {
		const storage = dialStorage([
			dial({ id: "a", url: "https://a.test/" }),
			dial({ id: "b", url: "https://b.test/" }),
		]);
		const dials = await removeDial(storage, "a");
		expect(dials.map((entry) => entry.id)).toEqual(["b"]);
		expect(storedIds(storage)).toEqual(["b"]);
	});

	it("is a no-op for an unknown id, and writes nothing", async () => {
		const storage = dialStorage([dial({ id: "a", url: "https://a.test/" })]);
		const set = vi.spyOn(storage, "set");
		const dials = await removeDial(storage, "missing");
		expect(dials.map((entry) => entry.id)).toEqual(["a"]);
		expect(set).not.toHaveBeenCalled();
	});
});

describe("reorderSpeedDial", () => {
	const three = [
		dial({ id: "a", url: "https://a.test/" }),
		dial({ id: "b", url: "https://b.test/" }),
		dial({ id: "c", url: "https://c.test/" }),
	];

	it("places the listed ids first, in list order", async () => {
		const storage = dialStorage(three);
		const dials = await reorderSpeedDial(storage, ["c", "a", "b"]);
		expect(dials.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
		expect(storedIds(storage)).toEqual(["c", "a", "b"]);
	});

	it("drops an id that no longer exists — a removed dial is not resurrected", async () => {
		const storage = dialStorage(three);
		const dials = await reorderSpeedDial(storage, ["gone", "c", "b", "a"]);
		expect(dials.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
	});

	it("ignores a repeated id after the first", async () => {
		const storage = dialStorage(three);
		const dials = await reorderSpeedDial(storage, ["b", "b", "a"]);
		expect(dials.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
	});

	it("appends dials missing from the list in their stored order", async () => {
		const storage = dialStorage(three);
		const dials = await reorderSpeedDial(storage, ["c"]);
		expect(dials.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
	});

	it("writes nothing when the order is unchanged", async () => {
		const storage = dialStorage(three);
		const set = vi.spyOn(storage, "set");
		const dials = await reorderSpeedDial(storage, ["a", "b", "c"]);
		expect(dials.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
		expect(set).not.toHaveBeenCalled();
	});

	it("propagates a rejected write so the caller can revert", async () => {
		const storage = dialStorage(three);
		storage.set = async () => {
			throw new Error("quota");
		};
		await expect(reorderSpeedDial(storage, ["c", "b", "a"])).rejects.toThrow(
			"quota",
		);
	});
});

// A total read feeding a read-modify-write would store "no dials" the first
// time `storage.get` hiccuped (SPEC §16.1): the WRITERS read strictly.
describe("the strict read the writers use", () => {
	function failingStorage(): KeyValueStorage & {
		set: ReturnType<typeof vi.fn>;
	} {
		const set = vi.fn(async () => undefined);
		return {
			get: async () => {
				throw new Error("storage is gone");
			},
			set,
		};
	}

	it("fails addDial without writing", async () => {
		const storage = failingStorage();
		await expect(addDial(storage, "example.com", mintId)).rejects.toThrow(
			"storage is gone",
		);
		expect(storage.set).not.toHaveBeenCalled();
	});

	it("fails removeDial without writing", async () => {
		const storage = failingStorage();
		await expect(removeDial(storage, "a")).rejects.toThrow("storage is gone");
		expect(storage.set).not.toHaveBeenCalled();
	});

	it("fails reorderSpeedDial without writing", async () => {
		const storage = failingStorage();
		await expect(reorderSpeedDial(storage, ["a", "b"])).rejects.toThrow(
			"storage is gone",
		);
		expect(storage.set).not.toHaveBeenCalled();
	});

	// The fill keeps its never-throws contract instead (SPEC §16.2).
	it("makes fillDialMetadata return false without writing", async () => {
		const storage = failingStorage();
		await expect(
			fillDialMetadata(storage, "a", { title: "Example" }),
		).resolves.toBe(false);
		expect(storage.set).not.toHaveBeenCalled();
	});
});

describe("extractTitle", () => {
	it("reads the first title element", () => {
		expect(extractTitle("<html><head><title>One</title></head>")).toBe("One");
	});

	it("reads through attributes on the tag", () => {
		expect(extractTitle('<title data-x="1" lang="en">Two</title>')).toBe("Two");
	});

	it("decodes the entities a title actually carries", () => {
		expect(
			extractTitle(
				"<title>A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&apos; &#65; &#x42;</title>",
			),
		).toBe(`A & B <C> "D" 'E' A B`);
	});

	it("leaves an entity it does not know verbatim", () => {
		expect(extractTitle("<title>caf&eacute;</title>")).toBe("caf&eacute;");
	});

	it("collapses whitespace and trims", () => {
		expect(extractTitle("<title>\n  Spaced   out\n</title>")).toBe(
			"Spaced out",
		);
	});

	it("caps the name", () => {
		expect(extractTitle(`<title>${"x".repeat(200)}</title>`)).toHaveLength(
			DIAL_NAME_LIMIT,
		);
	});

	it("is undefined when there is no title, or it is empty", () => {
		expect(extractTitle("<html><body>hi</body></html>")).toBeUndefined();
		expect(extractTitle("<title></title>")).toBeUndefined();
		expect(extractTitle("<title>   </title>")).toBeUndefined();
	});

	it("does not mistake a longer tag name for <title>", () => {
		expect(extractTitle("<titlebar>Nope</titlebar>")).toBeUndefined();
	});

	it("considers only the first 512 KiB", () => {
		const late = `${"x".repeat(HTML_SCAN_LIMIT)}<title>Late</title>`;
		expect(extractTitle(late)).toBeUndefined();
		const early = `${"x".repeat(HTML_SCAN_LIMIT - 40)}<title>Early</title>`;
		expect(extractTitle(early)).toBe("Early");
	});
});

describe("extractTouchIcon", () => {
	const base = "https://example.com/index.html";

	it("takes an apple-touch-icon and resolves it against the base URL", () => {
		expect(
			extractTouchIcon(
				'<link rel="apple-touch-icon" href="/icons/touch.png">',
				base,
			),
		).toBe("https://example.com/icons/touch.png");
	});

	it("takes the precomposed variant too", () => {
		expect(
			extractTouchIcon(
				'<link rel="apple-touch-icon-precomposed" href="t.png">',
				base,
			),
		).toBe("https://example.com/t.png");
	});

	it("reads rel as a token list, case-insensitively, in any attribute order", () => {
		expect(
			extractTouchIcon(
				"<link href=t.png REL='icon APPLE-TOUCH-ICON' sizes=180x180>",
				base,
			),
		).toBe("https://example.com/t.png");
	});

	it("ignores a rel that merely contains the token as a substring", () => {
		expect(
			extractTouchIcon(
				'<link rel="apple-touch-icon-image" href="/t.png">',
				base,
			),
		).toBeUndefined();
	});

	it("ignores link tags that are not touch icons", () => {
		expect(
			extractTouchIcon(
				'<link rel="stylesheet" href="/a.css"><link rel="icon" href="/f.ico">',
				base,
			),
		).toBeUndefined();
	});

	it("takes the largest declared sizes edge", () => {
		expect(
			extractTouchIcon(
				[
					'<link rel="apple-touch-icon" sizes="76x76" href="/s.png">',
					'<link rel="apple-touch-icon" sizes="180x180" href="/l.png">',
					'<link rel="apple-touch-icon" sizes="120x120" href="/m.png">',
				].join(""),
				base,
			),
		).toBe("https://example.com/l.png");
	});

	it("counts a missing or unparseable sizes as 0", () => {
		expect(
			extractTouchIcon(
				[
					'<link rel="apple-touch-icon" href="/none.png">',
					'<link rel="apple-touch-icon" sizes="any" href="/any.png">',
					'<link rel="apple-touch-icon" sizes="152x152" href="/big.png">',
				].join(""),
				base,
			),
		).toBe("https://example.com/big.png");
		// …and with nothing else on offer, a sizeless tag still wins.
		expect(
			extractTouchIcon('<link rel="apple-touch-icon" href="/none.png">', base),
		).toBe("https://example.com/none.png");
	});

	it("keeps the first of equally sized tags", () => {
		expect(
			extractTouchIcon(
				[
					'<link rel="apple-touch-icon" sizes="180x180" href="/first.png">',
					'<link rel="apple-touch-icon" sizes="180x180" href="/second.png">',
				].join(""),
				base,
			),
		).toBe("https://example.com/first.png");
	});

	it("resolves against the FINAL url, so a www. redirect lands on the right host", () => {
		expect(
			extractTouchIcon(
				'<link rel="apple-touch-icon" href="/t.png">',
				"https://www.example.com/home",
			),
		).toBe("https://www.example.com/t.png");
	});

	it("decodes entities in the href", () => {
		expect(
			extractTouchIcon(
				'<link rel="apple-touch-icon" href="/t.png?a=1&amp;b=2">',
				base,
			),
		).toBe("https://example.com/t.png?a=1&b=2");
	});

	it("skips a tag whose href will not resolve to absolute http(s)", () => {
		expect(
			extractTouchIcon(
				[
					'<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,AAAA">',
					'<link rel="apple-touch-icon" sizes="120x120" href="/ok.png">',
				].join(""),
				base,
			),
		).toBe("https://example.com/ok.png");
		expect(
			extractTouchIcon('<link rel="apple-touch-icon" href="">', base),
		).toBeUndefined();
		expect(
			extractTouchIcon(
				'<link rel="apple-touch-icon" href="/t.png">',
				"not a url",
			),
		).toBeUndefined();
	});

	it("is undefined when there is no link tag at all", () => {
		expect(
			extractTouchIcon("<html><body>hi</body></html>", base),
		).toBeUndefined();
	});
});

// The page being read is untrusted and the work runs on the Options page's
// MAIN THREAD, so extraction has to stay linear (SPEC §16.2). The bounds here
// are generous: the same inputs cost 9–18 s against the patterns these
// replaced, and well under 10 ms against these.
describe("linear-time extraction", () => {
	const HOSTILE = 512 * 1024;
	/** Wall time of one call. Generous by design — this catches seconds. */
	function millis(run: () => void): number {
		const started = performance.now();
		run();
		return performance.now() - started;
	}

	it("walks half a megabyte of unclosed <link tags without stalling", () => {
		// The leading `<html>` matters: it gives the scan a closing bracket to
		// start from, so the whole half megabyte is actually walked rather than
		// short-circuited on "no `>` in the document at all".
		const html = `<html>${"<link ".repeat(Math.ceil(HOSTILE / 6)).slice(0, HOSTILE)}`;
		let result: string | undefined = "unset";
		expect(
			millis(() => {
				result = extractTouchIcon(html, "https://example.com/");
			}),
		).toBeLessThan(1000);
		expect(result).toBeUndefined();
	});

	it("skips a <link> tag whose body is one enormous word run", () => {
		const html = `<link ${"a".repeat(HOSTILE)}>`;
		let result: string | undefined = "unset";
		expect(
			millis(() => {
				result = extractTouchIcon(html, "https://example.com/");
			}),
		).toBeLessThan(1000);
		expect(result).toBeUndefined();
	});

	// Skipping the padding must not mean giving up on the rest of the document.
	it("still finds a real tag sitting after an overlong one", () => {
		const html = `<link ${"a".repeat(4096)}><link rel="apple-touch-icon" href="/t.png">`;
		expect(extractTouchIcon(html, "https://example.com/")).toBe(
			"https://example.com/t.png",
		);
	});

	it("walks half a megabyte of unclosed <title> tags without stalling", () => {
		const html = "<title>".repeat(Math.ceil(HOSTILE / 7)).slice(0, HOSTILE);
		let result: string | undefined = "unset";
		expect(
			millis(() => {
				result = extractTitle(html);
			}),
		).toBeLessThan(1000);
		expect(result).toBeUndefined();
	});
});

describe("fetchDialMetadata", () => {
	it("sends one uncredentialed GET and returns the title and touch icon", async () => {
		const fetchImpl = vi.fn(async () =>
			htmlResponse(
				'<title>Example Domain</title><link rel="apple-touch-icon" href="/t.png">',
			),
		);
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({
			title: "Example Domain",
			// `new Response` reports an empty `url`, so the requested URL stands in.
			iconUrl: "https://example.com/t.png",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = firstCall(fetchImpl);
		expect(url).toBe("https://example.com/");
		expect(init.credentials).toBe("omit");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("resolves a relative icon against the response's FINAL url", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			// Redirected: the body came from `www.`, so its hrefs are relative to it.
			url: "https://www.example.com/home",
			headers: new Headers({ "Content-Type": "text/html" }),
			text: async () => '<link rel="apple-touch-icon" href="/t.png">',
		}));
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({ iconUrl: "https://www.example.com/t.png" });
	});

	it("is empty on a non-2xx", async () => {
		const fetchImpl = vi.fn(async () =>
			htmlResponse("<title>Nope</title>", 404),
		);
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({});
	});

	it("is empty for a content type that is not HTML", async () => {
		const fetchImpl = vi.fn(async () =>
			htmlResponse("<title>Nope</title>", 200, "application/pdf"),
		);
		await expect(
			fetchDialMetadata(
				"https://example.com/a.pdf",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({});
	});

	it("accepts a charset-qualified HTML content type", async () => {
		const fetchImpl = vi.fn(async () =>
			htmlResponse("<title>Ok</title>", 200, "Text/HTML; charset=utf-8"),
		);
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({ title: "Ok" });
	});

	it("is empty when the fetch rejects, and never throws", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({});
	});

	// The body is a stranger's stream: it is read to the scan limit and no
	// further, and the reader is cancelled there (SPEC §16.2).
	it("stops an endless body at the scan limit and cancels the reader", async () => {
		const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
		let pulls = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			url: "https://example.com/",
			headers: new Headers({ "Content-Type": "text/html" }),
			body,
			text: async () => {
				throw new Error("text() buffers everything — it must not be used");
			},
		}));
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({});
		expect(cancelled).toBe(true);
		// Eight 64 KiB chunks cover the limit; anything near the stream's real
		// length would mean the cap was not applied.
		expect(pulls).toBeLessThanOrEqual(HTML_SCAN_LIMIT / chunk.length + 2);
	});

	it("caps a body-less response at the scan limit too", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			url: "https://example.com/",
			headers: new Headers({ "Content-Type": "text/html" }),
			// A test double, or any response Chrome hands over without a stream.
			text: async () =>
				`${"x".repeat(HTML_SCAN_LIMIT)}<link rel="apple-touch-icon" href="/t.png">`,
		}));
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({});
	});

	it("is empty when the abort fires during the body read", async () => {
		const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const signal = init?.signal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					// A first chunk arrives, then the stream simply stalls — the
					// 5 s budget covers the body, not just the headers.
					controller.enqueue(new TextEncoder().encode("<title>Slow</title>"));
					signal?.addEventListener("abort", () => {
						controller.error(new DOMException("aborted", "AbortError"));
					});
				},
			});
			return {
				ok: true,
				url: "https://slow.test/",
				headers: new Headers({ "Content-Type": "text/html" }),
				body,
			};
		});
		await expect(
			fetchDialMetadata(
				"https://slow.test/",
				fetchImpl as unknown as typeof fetch,
				{ timeoutMs: 5 },
			),
		).resolves.toEqual({});
		const [, init] = firstCall(
			fetchImpl as unknown as ReturnType<typeof vi.fn>,
		);
		expect(init.signal?.aborted).toBe(true);
	});

	it("is empty when the body read rejects", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			url: "https://example.com/",
			headers: new Headers({ "Content-Type": "text/html" }),
			text: async () => {
				throw new Error("stream broke");
			},
		}));
		await expect(
			fetchDialMetadata(
				"https://example.com/",
				fetchImpl as unknown as typeof fetch,
			),
		).resolves.toEqual({});
	});

	it("aborts on the timeout and is empty", async () => {
		// The injected fetch honours the signal, as a real one does; the budget
		// is a few ms so the test doesn't sit out the 5 s production one.
		const fetchImpl = vi.fn(
			(_input: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
				}),
		);
		await expect(
			fetchDialMetadata(
				"https://slow.test/",
				fetchImpl as unknown as typeof fetch,
				{ timeoutMs: 5 },
			),
		).resolves.toEqual({});
		const [, init] = firstCall(
			fetchImpl as unknown as ReturnType<typeof vi.fn>,
		);
		expect(init.signal?.aborted).toBe(true);
	});
});

describe("fillDialMetadata", () => {
	it("fills a name that is still the hostname default, and the missing icon", async () => {
		const storage = dialStorage([
			dial({ id: "a", name: "example.com", url: "https://www.example.com/" }),
		]);
		await expect(
			fillDialMetadata(storage, "a", {
				title: "Example Domain",
				iconUrl: "https://example.com/t.png",
			}),
		).resolves.toBe(true);
		const dials = await readSpeedDial(storage);
		expect(dials[0]?.name).toBe("Example Domain");
		expect(dials[0]?.iconUrl).toBe("https://example.com/t.png");
	});

	it("never overwrites a name the user is already looking at", async () => {
		const storage = dialStorage([
			dial({ id: "a", name: "Example Domain", url: "https://example.com/" }),
		]);
		const set = vi.spyOn(storage, "set");
		// A second fill (a late duplicate fetch) finds a filled name and stops.
		await expect(
			fillDialMetadata(storage, "a", { title: "Something Else" }),
		).resolves.toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it("never overwrites an icon that is already stored", async () => {
		const storage = dialStorage([
			dial({ id: "a", iconUrl: "https://example.com/kept.png" }),
		]);
		await expect(
			fillDialMetadata(storage, "a", {
				iconUrl: "https://example.com/new.png",
			}),
		).resolves.toBe(false);
		const dials = await readSpeedDial(storage);
		expect(dials[0]?.iconUrl).toBe("https://example.com/kept.png");
	});

	it("fills the icon even when the name is already the user's", async () => {
		const storage = dialStorage([
			dial({ id: "a", name: "Mine", url: "https://example.com/" }),
		]);
		await expect(
			fillDialMetadata(storage, "a", {
				title: "Example Domain",
				iconUrl: "https://example.com/t.png",
			}),
		).resolves.toBe(true);
		const dials = await readSpeedDial(storage);
		expect(dials[0]?.name).toBe("Mine");
		expect(dials[0]?.iconUrl).toBe("https://example.com/t.png");
	});

	it("does not resurrect a dial removed while the fetch was out", async () => {
		const storage = dialStorage([dial({ id: "b", url: "https://b.test/" })]);
		const set = vi.spyOn(storage, "set");
		await expect(
			fillDialMetadata(storage, "a", {
				title: "Gone",
				iconUrl: "https://gone.test/t.png",
			}),
		).resolves.toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it("writes nothing for an empty result, an empty title or an unusable icon", async () => {
		const storage = dialStorage([
			dial({ id: "a", name: "example.com", url: "https://example.com/" }),
		]);
		const set = vi.spyOn(storage, "set");
		await expect(fillDialMetadata(storage, "a", {})).resolves.toBe(false);
		await expect(
			fillDialMetadata(storage, "a", { title: "   " }),
		).resolves.toBe(false);
		await expect(
			fillDialMetadata(storage, "a", { title: "example.com" }),
		).resolves.toBe(false);
		await expect(
			fillDialMetadata(storage, "a", { iconUrl: "/relative.png" }),
		).resolves.toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it("swallows a storage failure rather than throwing at the caller", async () => {
		const storage = dialStorage([
			dial({ id: "a", name: "example.com", url: "https://example.com/" }),
		]);
		storage.set = async () => {
			throw new Error("quota");
		};
		await expect(
			fillDialMetadata(storage, "a", { title: "Example" }),
		).resolves.toBe(false);
	});
});
