// Adapter registry and runner for page snapshots (SPEC §17.5).
import { genericAdapter } from "./generic";
import { redditPostAdapter } from "./reddit";
import type { Adapter, AdapterContext, ScrapeResult } from "./types";

export { collectMetadata } from "./metadata";
export type {
	Adapter,
	AdapterContext,
	AdapterOutput,
	PageMetadata,
	ScrapeResult,
} from "./types";
export { genericAdapter };

/** Site adapters in priority order. The generic adapter is the fallback and is not listed. */
export const siteAdapters: Adapter[] = [redditPostAdapter];

/** Every adapter, generic last, for the Options toggles. */
export const allAdapters: Adapter[] = [...siteAdapters, genericAdapter];

/** First enabled site adapter matching the URL, else the generic adapter (always enabled). */
export function findAdapter(url: URL, disabledIds: string[] = []): Adapter {
	return (
		siteAdapters.find((a) => !disabledIds.includes(a.id) && a.matches(url)) ??
		genericAdapter
	);
}

/** Runs the chosen adapter. A site adapter that throws falls back to the generic adapter. */
export async function runAdapter(
	ctx: AdapterContext,
	disabledIds: string[] = [],
): Promise<ScrapeResult> {
	const adapter = findAdapter(ctx.url, disabledIds);
	try {
		const output = await adapter.extract(ctx);
		return {
			...output,
			adapterId: adapter.id,
			adapterVersion: adapter.version,
		};
	} catch (err) {
		if (adapter === genericAdapter) throw err;
		const output = await genericAdapter.extract(ctx);
		const error = err instanceof Error ? err.message : String(err);
		return {
			...output,
			adapterId: genericAdapter.id,
			adapterVersion: genericAdapter.version,
			data: {
				...(output.data as object | undefined),
				fallbackFrom: adapter.id,
				error,
			},
		};
	}
}
