import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import * as v from "valibot";
import type { Logger } from "./logger.ts";
import { authorized, readBody, reply } from "./server.ts";

export const MAC_STATE_PATH = "/mac-state";

const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Mac の mac-state/send.sh が送る、Orca の席の要約。 */
const macStateSchema = v.object({
	sent_at: epochMs,
	worktrees: v.pipe(
		v.array(
			v.object({
				repo: v.nullish(v.string()),
				branch: v.nullish(v.string()),
				name: v.nullish(v.string()),
				status: v.nullish(v.string()),
				active: v.nullish(v.boolean()),
				unread: v.nullish(v.boolean()),
				last_activity_at: v.nullish(epochMs),
				pr: v.nullish(
					v.object({
						number: v.number(),
						state: v.nullish(v.string()),
						checks: v.nullish(v.string()),
					}),
				),
				agents: v.array(
					v.object({
						type: v.nullish(v.string()),
						state: v.nullish(v.string()),
						title: v.nullish(v.string()),
						updated_at: v.nullish(epochMs),
					}),
				),
			}),
		),
		v.maxLength(500),
	),
});

export type MacState = v.InferOutput<typeof macStateSchema>;

export type ReceivedMacState = { receivedAt: Date; state: MacState };

const fileSchema = v.object({ received_at_ms: epochMs, state: macStateSchema });

export type MacStateStore = {
	save: (state: MacState, receivedAt: Date) => Promise<void>;
	/** 最後に届いた 1 件。届いたことがなければ null。 */
	latest: () => Promise<ReceivedMacState | null>;
};

/** 最新の 1 件だけを volume に置く。Mac が寝ていても、朝会は最後に届いたものを読む。 */
export const openMacStateStore = (dir: string): MacStateStore => {
	const path = join(dir, "mac-state.json");
	return {
		save: async (state, receivedAt) => {
			await mkdir(dir, { recursive: true });
			const tmp = `${path}.tmp`;
			await writeFile(
				tmp,
				JSON.stringify({ received_at_ms: receivedAt.getTime(), state }),
			);
			await rename(tmp, path);
		},
		latest: async () => {
			const raw = await readFile(path, "utf8").catch(() => null);
			if (raw === null) return null;
			let json: unknown;
			try {
				json = JSON.parse(raw);
			} catch {
				return null;
			}
			const parsed = v.safeParse(fileSchema, json);
			if (!parsed.success) return null;
			return {
				receivedAt: new Date(parsed.output.received_at_ms),
				state: parsed.output.state,
			};
		},
	};
};

export type MacStateServerDeps = {
	/** gateway 用とは別の、Mac と共有するトークン。 */
	token: string;
	store: MacStateStore;
	now?: () => Date;
	logger: Logger;
};

/** Mac から席の状態を受ける。LAN から届くよう、gateway 向けの受付とは別のポートで待ち受ける。 */
export const createMacStateServer = (deps: MacStateServerDeps): Server =>
	createServer(async (req, res) => {
		if (req.url !== MAC_STATE_PATH) return reply(res, 404);
		if (req.method !== "POST") return reply(res, 405);
		if (!authorized(req.headers.authorization, deps.token)) {
			return reply(res, 401);
		}
		const raw = await readBody(req);
		if (raw === null) return reply(res, 413);
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return reply(res, 400);
		}
		const parsed = v.safeParse(macStateSchema, json);
		if (!parsed.success) {
			deps.logger.warn("invalid mac state", {
				issues: parsed.issues.slice(0, 5).map((i) => i.message),
			});
			return reply(res, 400);
		}
		await deps.store.save(parsed.output, (deps.now ?? (() => new Date()))());
		deps.logger.info("mac state received", {
			worktrees: parsed.output.worktrees.length,
		});
		return reply(res, 204);
	});
