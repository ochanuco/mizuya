import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-support.ts";
import { credentialsPathOf, runMemoryCli, seatThreadOf } from "./cli.ts";

const SECRET = "very-secret-value";

const setup = () => {
	const dir = tempDir();
	writeFileSync(
		credentialsPathOf(dir),
		JSON.stringify({
			url: "https://worker.example/",
			client_id: "cid",
			client_secret: SECRET,
			discord_user_id: "owner-1",
			partner_id: "yukarin",
		}),
	);
	return { MIZUYA_STATE_DIR: dir };
};

const respond = (status: number, body: unknown) =>
	vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	);

describe("runMemoryCli", () => {
	it("read は持ち主の記憶を GET し、応答をそのまま出す", async () => {
		const env = setup();
		const f = respond(200, { facts: [], episodes: [], open_loops: [] });
		const out = await runMemoryCli(["read"], env, f as typeof fetch);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			facts: [],
			episodes: [],
			open_loops: [],
		});
		const [url, init] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://worker.example/v1/partners/yukarin/working/memory?discord_user_id=owner-1",
		);
		expect(init?.headers).toMatchObject({
			"CF-Access-Client-Id": "cid",
			"CF-Access-Client-Secret": SECRET,
		});
	});

	it("YUNOMI_PARTNER があればそのパートナーの記憶を読む", async () => {
		const env = { ...setup(), YUNOMI_PARTNER: "akarin" };
		const f = respond(200, { facts: [], episodes: [], open_loops: [] });
		await runMemoryCli(["read"], env, f as typeof fetch);
		const [url] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://worker.example/v1/partners/akarin/working/memory?discord_user_id=owner-1",
		);
	});

	it("watch-checked の --partner は YUNOMI_PARTNER より優先し、見張りを持つパートナーの記憶に残す", async () => {
		const env = { ...setup(), YUNOMI_PARTNER: "yukarin" };
		const f = respond(200, { id: "w1", checked: true });
		const out = await runMemoryCli(
			["watch-checked", "--id", "w1", "--partner", "akarin"],
			env,
			f as typeof fetch,
		);
		expect(out.code).toBe(0);
		const [url] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://worker.example/v1/partners/akarin/working/memory",
		);
	});

	it("write は 1 行を POST する", async () => {
		const env = setup();
		const f = respond(201, { id: "n1" });
		const out = await runMemoryCli(
			["write", "--kind", "decided", "--summary", " 朝会は 9 時 "],
			env,
			f as typeof fetch,
		);
		expect(out.code).toBe(0);
		const [, init] = f.mock.calls[0] ?? [];
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			discord_user_id: "owner-1",
			kind: "decided",
			summary: "朝会は 9 時",
		});
	});

	it("goal を足すと id を返し、close で達成か取り下げにする", async () => {
		const env = setup();
		const added = await runMemoryCli(
			["write", "--kind", "goal", "--summary", "本を 1 冊書く"],
			env,
			respond(201, { id: "g1" }) as typeof fetch,
		);
		expect(added.stdout).toBe("残した: goal 本を 1 冊書く (id: g1)\n");

		const f = respond(200, { id: "g1" });
		const closed = await runMemoryCli(
			["close", "--id", "g1", "--status", "achieved"],
			env,
			f as typeof fetch,
		);
		expect(closed.code).toBe(0);
		const [url, init] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://worker.example/v1/partners/yukarin/working/memory",
		);
		expect(init?.method).toBe("PATCH");
		expect(JSON.parse(String(init?.body))).toEqual({
			discord_user_id: "owner-1",
			id: "g1",
			status: "achieved",
		});
	});

	it("watch-checked は知らせたものの key を付けて PATCH する", async () => {
		const env = setup();
		const f = respond(200, { id: "w1", checked: true });
		const out = await runMemoryCli(
			[
				"watch-checked",
				"--id",
				"w1",
				"--seen",
				"https://shop.example/items/1",
				"--seen",
				" https://shop.example/items/2 ",
			],
			env,
			f as typeof fetch,
		);
		expect(out.code).toBe(0);
		const [, init] = f.mock.calls[0] ?? [];
		expect(init?.method).toBe("PATCH");
		expect(JSON.parse(String(init?.body))).toEqual({
			discord_user_id: "owner-1",
			watch_id: "w1",
			seen: ["https://shop.example/items/1", "https://shop.example/items/2"],
		});
		// 新着が無かった回も、調べ終えたことは残す
		const none = respond(200, {});
		await runMemoryCli(
			["watch-checked", "--id", "w1"],
			env,
			none as typeof fetch,
		);
		expect(JSON.parse(String(none.mock.calls[0]?.[1]?.body)).seen).toEqual([]);
	});

	it("watch-add は何を・どこを・間隔・期限を POST し、登録した内容を出す", async () => {
		const env = { ...setup(), YUNOMI_PARTNER: "akarin" };
		const f = respond(201, { id: "w1" });
		const out = await runMemoryCli(
			[
				"watch-add",
				"--query",
				" RTX3090 の中古、24GB ",
				"--source",
				"じゃんぱら",
				"--source",
				"https://shop.example/gpu",
				"--interval-hours",
				"6",
				"--until",
				"2026-12-31T23:59:00+09:00",
			],
			env,
			f as typeof fetch,
		);
		expect(out.code).toBe(0);
		const [url, init] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://worker.example/v1/partners/akarin/working/memory",
		);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			discord_user_id: "owner-1",
			watch: {
				query: "RTX3090 の中古、24GB",
				sources: ["じゃんぱら", "https://shop.example/gpu"],
				interval_hours: 6,
				until: "2026-12-31T23:59:00+09:00",
			},
		});
		expect(out.stdout).toBe(
			[
				"見張りを足した (id: w1)",
				"何を: RTX3090 の中古、24GB",
				"どこを: じゃんぱら、https://shop.example/gpu",
				"間隔: 6 時間おき",
				"期限: 2026-12-31T23:59:00+09:00",
				"",
			].join("\n"),
		);
	});

	it("watch-add を席の中で呼ぶと、その席の投稿を新着を書く先として送る", async () => {
		const env = { ...setup(), MIZUYA_SEATS_DIR: "/seats" };
		const f = respond(201, { id: "w1" });
		await runMemoryCli(
			["watch-add", "--query", "中古の万年筆"],
			env,
			f as typeof fetch,
			"/seats/seat-1234567890/repo",
		);
		const [, init] = f.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body))).toMatchObject({
			notify_thread_id: "1234567890",
		});
	});

	it("seatThreadOf は席の外や朝会の席では null", () => {
		expect(seatThreadOf("/seats", "/home/worker/work")).toBeNull();
		expect(seatThreadOf("/seats", "/seats/standup-abc")).toBeNull();
		expect(seatThreadOf(undefined, "/seats/seat-1")).toBeNull();
		expect(seatThreadOf("/seats", "/seats/seat-12/x/y")).toBe("12");
	});

	it("watch-add は場所・間隔・期限を省くと普通の検索、24 時間おき、期限なし", async () => {
		const env = setup();
		const f = respond(201, { id: "w2" });
		const out = await runMemoryCli(
			["watch-add", "--query", "中古の万年筆"],
			env,
			f as typeof fetch,
		);
		expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body)).watch).toEqual({
			query: "中古の万年筆",
			sources: [],
			interval_hours: 24,
			until: null,
		});
		expect(out.stdout).toContain("どこを: 普通の検索");
		expect(out.stdout).toContain("間隔: 24 時間おき");
		expect(out.stdout).toContain("期限: なし");
	});

	it("watch-add が Worker に弾かれたら理由を出す", async () => {
		const out = await runMemoryCli(
			["watch-add", "--query", "q", "--until", "2020-01-01T00:00:00+09:00"],
			setup(),
			respond(400, {
				error: "validation_failed",
				message: "until: 過去の日時",
			}) as typeof fetch,
		);
		expect(out.code).toBe(1);
		expect(out.stderr).toContain("validation_failed (until: 過去の日時)");
	});

	it("watch-stop は見張りの id を止める PATCH を送る", async () => {
		const env = setup();
		const f = respond(200, { id: "w1", query: "中古の万年筆", stopped: true });
		const out = await runMemoryCli(
			["watch-stop", "--id", " w1 "],
			env,
			f as typeof fetch,
		);
		expect(out.code).toBe(0);
		const [, init] = f.mock.calls[0] ?? [];
		expect(init?.method).toBe("PATCH");
		expect(JSON.parse(String(init?.body))).toEqual({
			discord_user_id: "owner-1",
			watch_id: "w1",
			status: "stopped",
		});
		expect(out.stdout).toBe("見張りを止めた: 中古の万年筆 (id: w1)\n");
	});

	it("書き方が違えば呼ばずに断る", async () => {
		const env = setup();
		const f = respond(201, {});
		for (const argv of [
			["write", "--kind", "other", "--summary", "x"],
			["write", "--kind", "done", "--summary", "a\nb"],
			["write", "--kind", "done", "--summary", "あ".repeat(201)],
			["write", "--kind", "done"],
			["delete"],
			["read", "extra"],
			["read", "--kind", "done"],
			["write", "--kind", "done", "--summary", "x", "--id", "g1"],
			["close", "--id", "g1"],
			["close", "--id", "g1", "--status", "open"],
			["close", "--status", "achieved"],
			["watch-checked", "--seen", "x"],
			["watch-checked", "--id", "w1", "--seen", "a\nb"],
			["watch-checked", "--id", "w1", "--partner", "Akarin"],
			["read", "--partner", "akarin"],
			["watch-checked", "--id", "w1", "--seen", "あ".repeat(201)],
			["close", "--id", "g1", "--status", "achieved", "--seen", "x"],
			["watch-add"],
			["watch-add", "--query", "  "],
			["watch-add", "--query", "a\nb"],
			["watch-add", "--query", "あ".repeat(201)],
			["watch-add", "--query", "q", "--source", " "],
			["watch-add", "--query", "q", "--source", "a\nb"],
			["watch-add", "--query", "q", "--source", "あ".repeat(301)],
			[
				"watch-add",
				"--query",
				"q",
				...Array.from({ length: 6 }, (_, i) => ["--source", `店${i}`]).flat(),
			],
			["watch-add", "--query", "q", "--interval-hours", "1"],
			["watch-add", "--query", "q", "--interval-hours", "169"],
			["watch-add", "--query", "q", "--interval-hours", "1.5"],
			["watch-add", "--query", "q", "--interval-hours", "毎日"],
			["watch-add", "--query", "q", "--until", ""],
			["watch-add", "--query", "q", "--id", "w1"],
			["watch-stop"],
			["watch-stop", "--id", " "],
			["watch-stop", "--id", "w1", "--query", "q"],
		]) {
			expect((await runMemoryCli(argv, env, f as typeof fetch)).code).toBe(2);
		}
		expect(f).not.toHaveBeenCalled();
	});

	it("失敗しても接続情報を出さない", async () => {
		const env = setup();
		const out = await runMemoryCli(
			["read"],
			env,
			respond(403, { error: "forbidden" }) as typeof fetch,
		);
		expect(out.code).toBe(1);
		expect(out.stderr).toContain("403");
		expect(out.stderr).toContain("forbidden");
		expect(`${out.stdout}${out.stderr}`).not.toContain(SECRET);
		expect(`${out.stdout}${out.stderr}`).not.toContain("cid");
	});

	it("接続情報がなければ呼ばない", async () => {
		const f = respond(200, {});
		const out = await runMemoryCli(
			["read"],
			{ MIZUYA_STATE_DIR: tempDir() },
			f as typeof fetch,
		);
		expect(out.code).toBe(1);
		expect(f).not.toHaveBeenCalled();
	});
});
