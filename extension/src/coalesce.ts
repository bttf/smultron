/**
 * Coalescing serializer for state pushes (SPEC §6, m15 popup tag saves).
 *
 * Contract: at most ONE `send` is in flight at any moment. Calls arriving
 * during a flight collapse into a single trailing send carrying the LATEST
 * value — intermediate values may never be sent, but values are never sent
 * out of order (the next send starts only after the previous one settles).
 * `send` resolving false (a rejected write) or rejecting outright must not
 * wedge the chain: the trailing send still fires. Callers own their own
 * success/failure reporting inside `send` — this helper stays pure: no
 * Chrome, DOM or timer access.
 *
 * The value carried is whatever the caller passes; for the popup that is a
 * COPY of the tags array, since the live array keeps mutating.
 */
export function createCoalescedSender<T>(
	send: (value: T) => Promise<boolean>,
): (value: T) => void {
	let inFlight = false;
	// `pending` is a one-slot box (not the value itself) so that `undefined`
	// or `null` are legal values of T.
	let pending: { value: T } | undefined;

	function run(value: T): void {
		inFlight = true;
		void (async () => {
			try {
				// Called synchronously: an idle sender sends on the spot.
				await send(value);
			} catch {
				// A rejected send must not wedge the chain; `send` reports.
			}
			inFlight = false;
			const next = pending;
			pending = undefined;
			if (next !== undefined) run(next.value);
		})();
	}

	return (value: T): void => {
		if (inFlight) {
			pending = { value };
			return;
		}
		run(value);
	};
}
