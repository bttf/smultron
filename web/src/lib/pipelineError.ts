// Shared failure type for the article pipeline (SPEC §10).
//
// Every external step — scrape, LLM clean, LLM summarize, TTS, storage —
// throws this instead of a bare Error, so the job runner can persist a
// stable machine-readable code alongside a message safe to show the user,
// and decide whether a retry could plausibly succeed.

/** Which external step failed. Persisted in the UI-visible error string. */
export type PipelineStep =
	| "scrape"
	| "clean"
	| "summarize"
	| "speech"
	| "storage";

export class PipelineError extends Error {
	readonly step: PipelineStep;
	/** Short machine code, e.g. `rate_limited`, `empty_content`, `http_500`. */
	readonly code: string;
	/**
	 * Whether retrying the same request could plausibly succeed (rate limits,
	 * timeouts, 5xx). False for configuration and content problems, which
	 * would fail identically on every retry.
	 */
	readonly retryable: boolean;

	constructor(
		step: PipelineStep,
		code: string,
		message: string,
		options: { retryable?: boolean; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "PipelineError";
		this.step = step;
		this.code = code;
		this.retryable = options.retryable ?? false;
	}

	/** The form persisted to `articles.error` and rendered in the UI. */
	toDisplayString(): string {
		return `${this.step}: ${this.message}`;
	}
}

/**
 * Normalizes anything thrown inside the pipeline into a `PipelineError` so
 * the runner always has a step and a code to persist. An `AbortError` from a
 * fetch timeout is mapped to a retryable `timeout`.
 */
export function asPipelineError(
	step: PipelineStep,
	error: unknown,
): PipelineError {
	if (error instanceof PipelineError) {
		return error;
	}
	if (error instanceof Error) {
		const timedOut =
			error.name === "AbortError" || error.name === "TimeoutError";
		return new PipelineError(
			step,
			timedOut ? "timeout" : "unexpected",
			error.message || String(error),
			{ retryable: timedOut, cause: error },
		);
	}
	return new PipelineError(step, "unexpected", String(error));
}
