import { describe, expect, it } from "vitest";
import { createKeyedQueue } from "./keyed-queue.ts";

const deferred = () => {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("createKeyedQueue", () => {
	it("同じ key は前が終わるまで待ち、別の key は待たない", async () => {
		const q = createKeyedQueue();
		const log: string[] = [];
		const gate = deferred();
		const a1 = q.run("a", async () => {
			await gate.promise;
			log.push("a1");
		});
		const a2 = q.run("a", async () => {
			log.push("a2");
		});
		await q.run("b", async () => {
			log.push("b");
		});
		expect(log).toEqual(["b"]);
		gate.resolve();
		await Promise.all([a1, a2]);
		expect(log).toEqual(["b", "a1", "a2"]);
		expect(q.size()).toBe(0);
	});

	it("前の仕事が失敗しても次は走る", async () => {
		const q = createKeyedQueue();
		void q.run("a", async () => {
			throw new Error("x");
		});
		let ran = false;
		await q.run("a", async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});
});
