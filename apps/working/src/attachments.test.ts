import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createAttachmentCollector,
	createChimeraImages,
	readSeatFile,
	takeAttachRefs,
} from "./attachments.ts";
import { ATTACHMENT_SIZE_LIMIT } from "./discord-rest.ts";
import { err, ok } from "./lib/core.ts";
import { silentLogger } from "./logger.ts";
import { tempDir } from "./test-support.ts";

/** out/ に a.png を置いた worktree と、その外の秘密のファイル。 */
const seatDir = () => {
	const root = tempDir();
	const worktree = join(root, "seat");
	mkdirSync(join(worktree, "out"), { recursive: true });
	writeFileSync(join(worktree, "out", "a.png"), "png");
	writeFileSync(join(worktree, "notes.txt"), "notes");
	writeFileSync(join(root, "secret.txt"), "secret");
	return { root, worktree };
};

describe("takeAttachRefs", () => {
	it("添付と chimera の行を抜き出し、本文から外す", () => {
		const r = takeAttachRefs(
			[
				"描けました。",
				"",
				"添付: out/a.png",
				"添付：`out/b c.png`",
				"chimera: abc123",
				"Chimera： `def456`",
				"",
				"どうでしょう。",
			].join("\n"),
		);
		expect(r.refs).toEqual([
			{ kind: "file", path: "out/a.png" },
			{ kind: "file", path: "out/b c.png" },
			{ kind: "chimera", shortId: "abc123" },
			{ kind: "chimera", shortId: "def456" },
		]);
		expect(r.body).toBe("描けました。\n\nどうでしょう。");
	});

	it("コードブロックの中の行と、文の途中の言及は本文のまま残す", () => {
		const text = [
			"書き方の例:",
			"```",
			"添付: out/a.png",
			"```",
			"chimera: の行で書く",
		].join("\n");
		expect(takeAttachRefs(text)).toEqual({ body: text, refs: [] });
	});
});

describe("readSeatFile", () => {
	it("out/ のファイルを読む", async () => {
		const { worktree } = seatDir();
		const r = await readSeatFile(worktree, "./out/a.png");
		expect(r.ok && r.value.name).toBe("a.png");
		expect(r.ok && r.value.contentType).toBe("image/png");
		expect(r.ok && new TextDecoder().decode(r.value.data)).toBe("png");
	});

	it("out/ の外のパスを拒む", async () => {
		const { root, worktree } = seatDir();
		for (const path of [
			"notes.txt",
			"out/../notes.txt",
			"out/../../secret.txt",
			join(root, "secret.txt"),
			"outside/a.png",
		]) {
			const r = await readSeatFile(worktree, path);
			expect(r.ok, path).toBe(false);
		}
	});

	it("out/ の外を指すシンボリックリンクを拒む", async () => {
		const { root, worktree } = seatDir();
		symlinkSync(join(root, "secret.txt"), join(worktree, "out", "link.txt"));
		const r = await readSeatFile(worktree, "out/link.txt");
		expect(r).toEqual(err({ reason: "out/ の外を指している" }));
		// out/ 自体が外へのリンクでも通さない
		const other = join(root, "other");
		mkdirSync(join(other, "dir"), { recursive: true });
		writeFileSync(join(other, "dir", "x.png"), "x");
		const w2 = join(root, "seat2");
		mkdirSync(w2);
		symlinkSync(join(other, "dir"), join(w2, "out"));
		expect((await readSeatFile(w2, "out/x.png")).ok).toBe(false);
	});

	it("無いファイルと大きすぎるファイルを拒む", async () => {
		const { worktree } = seatDir();
		writeFileSync(
			join(worktree, "out", "big.bin"),
			Buffer.alloc(ATTACHMENT_SIZE_LIMIT + 1),
		);
		expect(await readSeatFile(worktree, "out/none.png")).toEqual(
			err({ reason: "ファイルが無い" }),
		);
		expect(await readSeatFile(worktree, "out/big.bin")).toEqual(
			err({ reason: "10 MB を超える" }),
		);
	});
});

describe("createChimeraImages", () => {
	it("service token と User-Agent を付けて元の画像を取る", async () => {
		const fetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(new Uint8Array([137, 80]), {
					headers: { "content-type": "image/png" },
				}),
		);
		const images = createChimeraImages({
			baseUrl: "https://chimera.example/",
			clientId: "cid",
			clientSecret: "csecret",
			fetch,
		});
		const r = await images("abc123");
		expect(r.ok && r.value.name).toBe("abc123.png");
		expect(r.ok && [...r.value.data]).toEqual([137, 80]);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://chimera.example/g/abc123/image");
		expect(init?.headers).toEqual({
			"CF-Access-Client-Id": "cid",
			"CF-Access-Client-Secret": "csecret",
			"User-Agent": "mizuya-working/1.0",
		});
		expect(init?.redirect).toBe("manual");
	});

	it("Access のログインへの転送、画像でない応答、無い画像は失敗にする", async () => {
		const respond = (res: Response) =>
			createChimeraImages({
				baseUrl: "https://chimera.example",
				clientId: "cid",
				clientSecret: "csecret",
				fetch: async () => res,
			})("abc123");
		expect(
			(
				await respond(
					new Response(null, {
						status: 302,
						headers: { location: "https://login.example" },
					}),
				)
			).ok,
		).toBe(false);
		expect(
			(
				await respond(
					new Response("<html>", { headers: { "content-type": "text/html" } }),
				)
			).ok,
		).toBe(false);
		expect(await respond(new Response("", { status: 404 }))).toEqual(
			err({ reason: "chimera に元の画像が無い" }),
		);
	});
});

describe("createAttachmentCollector", () => {
	const png = (name: string) => ({
		name,
		contentType: "image/png",
		data: new Uint8Array([1]),
	});

	it("ファイルと chimera の画像を集め、付けられなかったものを知らせる", async () => {
		const { worktree } = seatDir();
		const chimera = vi.fn(async (id: string) =>
			id === "abc123" ? ok(png(`${id}.png`)) : err({ reason: "無い" }),
		);
		const collect = createAttachmentCollector({
			chimera,
			logger: silentLogger,
		});
		const r = await collect(worktree, [
			{ kind: "file", path: "out/a.png" },
			{ kind: "file", path: "../secret.txt" },
			{ kind: "chimera", shortId: "abc123" },
			{ kind: "chimera", shortId: "zzz999" },
			{ kind: "chimera", shortId: "../etc" },
		]);
		expect(r.files.map((f) => f.name)).toEqual(["a.png", "abc123.png"]);
		expect(r.note).toBe(
			[
				"添付できなかったもの:",
				"- ../secret.txt（out/ の外のパス）",
				"- chimera zzz999（無い）",
				"- chimera ../etc（short_id の形ではない）",
			].join("\n"),
		);
		// short_id の形でないものは chimera に問い合わせない
		expect(chimera.mock.calls.map(([id]) => id)).toEqual(["abc123", "zzz999"]);
	});

	it("11 個目からは付けず、同じ名前には番号を付ける。chimera の設定が無ければそう書く", async () => {
		const chimera = vi.fn(async () => ok(png("same.png")));
		const collect = createAttachmentCollector({
			chimera,
			logger: silentLogger,
		});
		const refs = Array.from({ length: 11 }, (_, i) => ({
			kind: "chimera" as const,
			shortId: `abc${String(i).padStart(3, "0")}`,
		}));
		const r = await collect(null, refs);
		expect(r.files).toHaveLength(10);
		expect(r.files.slice(0, 3).map((f) => f.name)).toEqual([
			"same.png",
			"2-same.png",
			"3-same.png",
		]);
		expect(r.note).toContain(
			"chimera abc010（1 件に付けられるのは 10 個まで）",
		);

		const none = createAttachmentCollector({
			chimera: null,
			logger: silentLogger,
		});
		expect(
			(await none(null, [{ kind: "chimera", shortId: "abc123" }])).note,
		).toContain("受付に chimera の設定が無い");
		expect(
			(await none(null, [{ kind: "file", path: "out/a.png" }])).note,
		).toContain("席の作業場所が無い");
	});
});
