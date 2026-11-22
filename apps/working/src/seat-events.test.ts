import { describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger.ts";
import {
	createSeatEventSender,
	oneLine,
	type SeatEvent,
	seatEventBody,
} from "./seat-events.ts";

const AT = new Date("2026-11-05T08:00:00Z");
const MEMORY = {
	url: "https://yunomi.example.com/",
	clientId: "client-id",
	clientSecret: "client-secret",
};

const started: SeatEvent = {
	event: "started",
	threadId: "1234567890",
	title: "README の誤字",
	summary: null,
	at: AT,
};

const recordingLogger = () => {
	const lines: { level: string; msg: string; fields?: unknown }[] = [];
	const make =
		(level: string) => (msg: string, fields?: Record<string, unknown>) => {
			lines.push({ level, msg, fields });
		};
	const logger: Logger = {
		debug: make("debug"),
		info: make("info"),
		warn: make("warn"),
		error: make("error"),
	};
	return { lines, logger };
};

describe("seatEventBody", () => {
	it("Worker の形にし、完了でなければ status を null にする", () => {
		expect(seatEventBody(started)).toEqual({
			thread_id: "1234567890",
			title: "README の誤字",
			event: "started",
			status: null,
			summary: null,
			at: "2026-11-05T08:00:00.000Z",
		});
		expect(
			seatEventBody({
				...started,
				event: "done",
				status: "見張り中",
				summary: "見張ります",
			}),
		).toMatchObject({
			event: "done",
			status: "見張り中",
			summary: "見張ります",
		});
	});

	it("改行と空白を 1 つにまとめ、件名は 100 字、要約は 200 字で切る", () => {
		const body = seatEventBody({
			...started,
			event: "asking",
			title: `件名\n${"あ".repeat(150)}`,
			summary: `一行目\n\n  二行目\t${"い".repeat(300)}`,
		});
		expect(body.title).toBe(`件名 ${"あ".repeat(97)}`);
		expect(body.title).toHaveLength(100);
		expect(body.summary?.startsWith("一行目 二行目 いい")).toBe(true);
		expect(body.summary).toHaveLength(200);
		expect(body.summary).not.toMatch(/[\r\n]/);
	});

	it("空の要約は null、件名が無ければ代わりの件名にする", () => {
		const body = seatEventBody({
			...started,
			event: "failed",
			title: null,
			summary: " \n ",
		});
		expect(body.summary).toBeNull();
		expect(body.title).toBe("仕事フォーラムの投稿");
	});

	it("サロゲートペアの途中では切らない", () => {
		expect(oneLine("😀😀😀", 5)).toBe("😀😀");
	});
});

describe("createSeatEventSender", () => {
	it("記憶の口と同じ service token で、担当のパートナーの events に POST する", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 204 }));
		const { lines, logger } = recordingLogger();
		const tell = createSeatEventSender({ memory: MEMORY, logger, fetch });
		tell("akarin", started);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(
			"https://yunomi.example.com/v1/partners/akarin/working/events",
		);
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"CF-Access-Client-Id": "client-id",
			"CF-Access-Client-Secret": "client-secret",
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init.body))).toEqual(seatEventBody(started));
		expect(lines.filter((l) => l.level === "warn")).toEqual([]);
	});

	it("接続情報が無ければ送らない", () => {
		const fetch = vi.fn();
		const { lines, logger } = recordingLogger();
		createSeatEventSender({ memory: null, logger, fetch })("yukarin", started);
		expect(fetch).not.toHaveBeenCalled();
		expect(lines.map((l) => l.level)).toEqual(["debug"]);
	});

	it("届かないときと 5xx は 1 回だけ送り直し、だめなら secret を出さずに記録する", async () => {
		const fetch = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(new Response("{}", { status: 503 }));
		const { lines, logger } = recordingLogger();
		createSeatEventSender({ memory: MEMORY, logger, fetch, retryDelayMs: 0 })(
			"yukarin",
			started,
		);
		await vi.waitFor(() => expect(lines).toHaveLength(1));
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(lines[0]).toMatchObject({
			level: "warn",
			msg: "seat event not delivered",
			fields: { status: 503, event: "started", thread_id: "1234567890" },
		});
		expect(JSON.stringify(lines)).not.toContain("client-secret");
	});

	it("4xx は送り直さない", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "unknown_partner" }), {
					status: 404,
				}),
		);
		const { lines, logger } = recordingLogger();
		createSeatEventSender({ memory: MEMORY, logger, fetch, retryDelayMs: 0 })(
			"yukarin",
			started,
		);
		await vi.waitFor(() => expect(lines).toHaveLength(1));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(lines[0]?.fields).toMatchObject({
			status: 404,
			error: "unknown_partner",
		});
	});
});
