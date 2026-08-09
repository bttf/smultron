import { describe, expect, it } from "vitest";
import { createCoalescedSender } from "./coalesce";

/**
 * Manually-resolved send: records every value it is called with and hands
 * back the resolver for each call, so tests drive the timeline without timers.
 */
function manualSend<T>(): {
	send: (value: T) => Promise<boolean>;
	calls: T[];
	settle: (index: number, outcome: boolean | Error) => Promise<void>;
} {
	const calls: T[] = [];
	const settlers: Array<{
		resolve: (ok: boolean) => void;
		reject: (error: Error) => void;
	}> = [];
	return {
		calls,
		send: (value: T) =>
			new Promise<boolean>((resolve, reject) => {
				calls.push(value);
				settlers.push({ resolve, reject });
			}),
		settle: async (index, outcome) => {
			const settler = settlers[index];
			if (settler === undefined) throw new Error(`no send #${index}`);
			if (outcome instanceof Error) settler.reject(outcome);
			else settler.resolve(outcome);
			// Let the serializer's continuation (and any trailing send) run.
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

describe("createCoalescedSender", () => {
	it("sends immediately when idle", () => {
		const { send, calls } = manualSend<number>();
		createCoalescedSender(send)(1);
		expect(calls).toEqual([1]);
	});

	it("keeps at most one send in flight", async () => {
		const { send, calls, settle } = manualSend<number>();
		const push = createCoalescedSender(send);
		push(1);
		push(2);
		push(3);
		expect(calls).toEqual([1]);
		await settle(0, true);
		expect(calls).toEqual([1, 3]);
	});

	it("collapses a burst into one trailing send carrying the latest value", async () => {
		const { send, calls, settle } = manualSend<number>();
		const push = createCoalescedSender(send);
		push(0);
		for (let i = 1; i <= 20; i += 1) push(i);
		expect(calls).toEqual([0]);
		await settle(0, true);
		// Exactly one trailing send, and it carries the last value only.
		expect(calls).toEqual([0, 20]);
		await settle(1, true);
		expect(calls).toEqual([0, 20]);
	});

	it("never sends values out of order", async () => {
		const { send, calls, settle } = manualSend<string>();
		const push = createCoalescedSender(send);
		push("a");
		push("b");
		await settle(0, true);
		push("c");
		// "c" only starts after "b" settles.
		expect(calls).toEqual(["a", "b"]);
		await settle(1, true);
		expect(calls).toEqual(["a", "b", "c"]);
	});

	it("continues the chain after a send resolves false", async () => {
		const { send, calls, settle } = manualSend<number>();
		const push = createCoalescedSender(send);
		push(1);
		push(2);
		await settle(0, false);
		expect(calls).toEqual([1, 2]);
		await settle(1, false);
		push(3);
		expect(calls).toEqual([1, 2, 3]);
	});

	it("continues the chain after a send rejects", async () => {
		const { send, calls, settle } = manualSend<number>();
		const push = createCoalescedSender(send);
		push(1);
		push(2);
		await settle(0, new Error("network down"));
		expect(calls).toEqual([1, 2]);
		await settle(1, new Error("still down"));
		// Fully settled again: the next push sends straight away.
		push(3);
		expect(calls).toEqual([1, 2, 3]);
	});

	it("sends straight away once everything has settled", async () => {
		const { send, calls, settle } = manualSend<number>();
		const push = createCoalescedSender(send);
		push(1);
		await settle(0, true);
		push(2);
		expect(calls).toEqual([1, 2]);
		await settle(1, true);
		push(3);
		expect(calls).toEqual([1, 2, 3]);
	});

	it("carries values the caller owns, including empty arrays", async () => {
		const { send, calls, settle } = manualSend<string[]>();
		const push = createCoalescedSender(send);
		push(["rust"]);
		push(["rust", "reading"]);
		push([]);
		await settle(0, true);
		expect(calls).toEqual([["rust"], []]);
	});
});
