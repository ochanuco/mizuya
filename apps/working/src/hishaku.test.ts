import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnExec } from "./exec.ts";
import { createHishaku } from "./hishaku.ts";
import { tempDir } from "./test-support.ts";

/**
 * hs の偽物。引数と環境変数を残し、HS_EXIT の終了コードで HS_OUT を出す。
 * 本物の hs と同じく、標準出力に JSON を 1 行だけ書く。
 */
const fakeHs = () => {
	const dir = tempDir("fake-hs-");
	const bin = join(dir, "hs");
	writeFileSync(
		bin,
		`#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
printf '%s %s\\n' "$HISHAKU_HOLDER" "$XDG_CACHE_HOME" >> "${dir}/env"
[ -n "$HS_OUT" ] && printf '%s\\n' "$HS_OUT"
echo "hs: $HS_ERR" >&2
exit "\${HS_EXIT:-0}"
`,
	);
	chmodSync(bin, 0o755);
	const read = (name: string) =>
		readFileSync(join(dir, name), "utf8").trim().split("\n");
	return { dir, bin, calls: () => read("calls"), env: () => read("env") };
};

const make = (
	hs: ReturnType<typeof fakeHs>,
	run: Record<string, string> = {},
	fetchImpl?: typeof fetch,
) =>
	createHishaku({
		url: "https://hishaku.example.com/",
		clientId: "cid",
		clientSecret: "csecret",
		holder: "box01",
		bin: hs.bin,
		exec: spawnExec,
		env: {
			PATH: process.env.PATH ?? "",
			XDG_CACHE_HOME: "/state/cache",
			...run,
		},
		cwd: hs.dir,
		...(fetchImpl ? { fetch: fetchImpl } : {}),
	});

describe("hishaku", () => {
	it("番号は service token を付けて POST /v1/sessions で取る", async () => {
		const hs = fakeHs();
		const f = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ number: 4321, post_id: "p1", agent: "claude" }),
					{ status: 201 },
				),
		);
		const h = make(hs, {}, f as unknown as typeof fetch);
		const r = await h.createSession({
			postId: "p1",
			agent: "claude",
			title: "件名",
			repo: "example/app",
			branch: null,
		});
		expect(r).toEqual({ ok: true, value: { number: 4321 } });
		const [url, init] = f.mock.calls[0] ?? [];
		expect(url).toBe("https://hishaku.example.com/v1/sessions");
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			"CF-Access-Client-Id": "cid",
			"CF-Access-Client-Secret": "csecret",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			post_id: "p1",
			agent: "claude",
			title: "件名",
			repo: "example/app",
			branch: null,
		});
	});

	it("Manager に届かない・断られたときは例外でなく失敗を返す", async () => {
		const hs = fakeHs();
		const down = make(hs, {}, (async () => {
			throw new Error("connect refused");
		}) as unknown as typeof fetch);
		const r1 = await down.createSession({
			postId: "p1",
			agent: "codex",
			title: "件名",
			repo: null,
			branch: null,
		});
		expect(!r1.ok && r1.error.type).toBe("HishakuFailed");
		// Access の login 画面への redirect も成功にしない
		const redirected = make(
			hs,
			{},
			(async () =>
				new Response("", {
					status: 302,
				})) as unknown as typeof fetch,
		);
		const r2 = await redirected.createSession({
			postId: "p1",
			agent: "codex",
			title: "件名",
			repo: null,
			branch: null,
		});
		expect(r2).toEqual({
			ok: false,
			error: { type: "HishakuFailed", reason: "POST /v1/sessions 302" },
		});
	});

	it("prepare は holder と cwd を渡し、JSON から起こし方を読む", async () => {
		const hs = fakeHs();
		const h = make(hs, {
			HS_OUT: JSON.stringify({
				number: 1234,
				agent: "claude",
				session_id: "0b0b0b0b-1111-4222-8333-444444444444",
				resume: true,
				generation: 3,
				lease_expires_at: "2026-11-08T00:00:00.000Z",
			}),
		});
		const r = await h.prepare({ number: 1234, cwd: "/seats/seat-1" });
		expect(r).toEqual({
			ok: true,
			value: {
				agent: "claude",
				sessionId: "0b0b0b0b-1111-4222-8333-444444444444",
				resume: true,
				generation: 3,
			},
		});
		expect(hs.calls()).toEqual([
			"prepare 1234 --holder box01 --cwd /seats/seat-1 --json",
		]);
		// hs の prepare と push の間の状態は、受付が渡したキャッシュの場所に残る
		expect(hs.env()).toEqual(["box01 /state/cache"]);
	});

	it("prepare の終了コード 2 は持ち主を返し、takeover で取り直せる", async () => {
		const hs = fakeHs();
		const held = make(hs, {
			HS_EXIT: "2",
			HS_OUT: JSON.stringify({
				holder: "mac-example",
				lease_expires_at: "2026-11-08T00:02:00.000Z",
			}),
		});
		const r = await held.prepare({ number: 1234, cwd: "/w", takeover: true });
		expect(r).toEqual({
			ok: false,
			error: {
				type: "LeaseHeld",
				holder: "mac-example",
				leaseExpiresAt: "2026-11-08T00:02:00.000Z",
			},
		});
		expect(hs.calls()[0]).toContain("--takeover");
	});

	it("端末のコマンドに入る session_id は shell の文字を通さない", async () => {
		const hs = fakeHs();
		const h = make(hs, {
			HS_OUT: JSON.stringify({
				number: 1234,
				agent: "claude",
				session_id: "x; rm -rf ~",
				resume: true,
				generation: 1,
			}),
		});
		const r = await h.prepare({ number: 1234, cwd: "/w" });
		expect(!r.ok && r.error.type).toBe("HishakuFailed");
	});

	it("hs が無い・失敗したときは理由を返す", async () => {
		const hs = fakeHs();
		const missing = createHishaku({
			url: "https://hishaku.example.com",
			clientId: "cid",
			clientSecret: "csecret",
			holder: "box01",
			bin: join(hs.dir, "no-such-hs"),
			exec: spawnExec,
			env: { PATH: process.env.PATH ?? "" },
			cwd: hs.dir,
		});
		const r1 = await missing.prepare({ number: 1234, cwd: "/w" });
		expect(!r1.ok && r1.error.type).toBe("HishakuFailed");
		const failing = make(hs, { HS_EXIT: "1", HS_ERR: "Manager に届きません" });
		const r2 = await failing.prepare({ number: 1234, cwd: "/w" });
		expect(r2).toEqual({
			ok: false,
			error: { type: "HishakuFailed", reason: "hs: Manager に届きません" },
		});
	});

	it("push は世代と cwd を渡し、release で返す。3 は取られていた", async () => {
		const hs = fakeHs();
		const r = await make(hs).push({
			number: 1234,
			generation: 3,
			cwd: "/seats/seat-1",
			release: true,
		});
		expect(r.ok).toBe(true);
		expect(hs.calls()).toEqual([
			"push 1234 --generation 3 --holder box01 --cwd /seats/seat-1 --release",
		]);
		const stolen = await make(hs, { HS_EXIT: "3" }).push({
			number: 1234,
			generation: 3,
			cwd: "/w",
			release: false,
		});
		expect(stolen).toEqual({ ok: false, error: { type: "LeaseStolen" } });
		expect(hs.calls()[1]).not.toContain("--release");
	});

	it("renew は世代を渡す。3 は取られていた", async () => {
		const hs = fakeHs();
		expect(await make(hs).renew({ number: 1234, generation: 2 })).toEqual({
			ok: true,
			value: { releaseRequestedBy: null },
		});
		expect(hs.calls()).toEqual([
			"renew 1234 --generation 2 --holder box01 --json",
		]);
		const stolen = await make(hs, { HS_EXIT: "3" }).renew({
			number: 1234,
			generation: 2,
		});
		expect(!stolen.ok && stolen.error.type).toBe("LeaseStolen");
	});

	it("renew は返してほしいと頼んだ持ち主を返す", async () => {
		const hs = fakeHs();
		const r = await make(hs, {
			HS_OUT:
				'{"generation":2,"lease_expires_at":"2026-11-05T08:02:00.000Z","release_requested_by":"mac-example"}',
		}).renew({ number: 1234, generation: 2 });
		expect(r).toEqual({
			ok: true,
			value: { releaseRequestedBy: "mac-example" },
		});
	});

	it("meta は service token を付けて GET し、持ち主と最後に置いた時刻を読む", async () => {
		const hs = fakeHs();
		const f = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						number: 1234,
						post_id: "p1",
						agent: "claude",
						session_id: null,
						title: "件名",
						repo: null,
						branch: null,
						holder: "mac-example",
						generation: 3,
						lease_expires_at: "2026-11-05T08:02:00.000Z",
						pushed_at: "2026-11-05T07:40:00.000Z",
						expires_at: "2026-12-05T08:00:00.000Z",
						updated_at: "2026-11-05T08:00:00.000Z",
					}),
					{ status: 200 },
				),
		);
		const r = await make(hs, {}, f as unknown as typeof fetch).meta(1234);
		expect(r).toEqual({
			ok: true,
			value: {
				holder: "mac-example",
				generation: 3,
				leaseExpiresAt: new Date("2026-11-05T08:02:00.000Z"),
				pushedAt: new Date("2026-11-05T07:40:00.000Z"),
			},
		});
		const [url, init] = f.mock.calls[0] ?? [];
		expect(url).toBe("https://hishaku.example.com/v1/sessions/1234");
		expect(init?.headers).toMatchObject({
			"CF-Access-Client-Id": "cid",
			"CF-Access-Client-Secret": "csecret",
		});
	});

	it("meta に pushed_at が無ければ null、形が違えば失敗にする", async () => {
		const hs = fakeHs();
		const reply = (body: unknown, status = 200) =>
			vi.fn(
				async () => new Response(JSON.stringify(body), { status }),
			) as unknown as typeof fetch;
		const free = await make(
			hs,
			{},
			reply({ holder: null, generation: 2, lease_expires_at: null }),
		).meta(1234);
		expect(free).toEqual({
			ok: true,
			value: {
				holder: null,
				generation: 2,
				leaseExpiresAt: null,
				pushedAt: null,
			},
		});
		const odd = await make(hs, {}, reply({ holder: 1 })).meta(1234);
		expect(!odd.ok && odd.error.reason).toBe("unexpected meta");
		const gone = await make(hs, {}, reply({}, 404)).meta(1234);
		expect(!gone.ok && gone.error.reason).toBe("GET /v1/sessions/1234 404");
	});
});
