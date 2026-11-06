import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { PARTNER_IDS, type PartnerId } from "./lib/core.ts";
import { WORK_STATUSES, type WorkStatus } from "./work-status.ts";

/**
 * 席の状態。
 * - queued: 席の数が上限で、空くのを待っている
 * - working: 席の Claude が作業している
 * - asking: 席の Claude が ask で聞いて、答えを待っている
 * - waiting: 席の Claude がターンを終え、持ち主の返事を待っている
 * - sleeping: 決めてほしいまま時間がたったので Claude を止めた。worktree と会話は残っている
 */
export type SeatStatus =
	| "queued"
	| "working"
	| "asking"
	| "waiting"
	| "sleeping";

export type Seat = {
	threadId: string;
	status: SeatStatus;
	/** 席の worktree。作る前（queued）は null。 */
	path: string | null;
	terminal: string | null;
	/** いまの Dispatch。席に続きを渡すと Orca は新しい Dispatch を作る。 */
	dispatchId: string | null;
	/** この席の Dispatch すべて。席から届いたメッセージを投稿に引き当てる。 */
	dispatchIds: string[];
	/** 答えを待っている ask のメッセージ。 */
	questionId: string | null;
	/** 最後に聞かれたこと。止めた席を起こすときに、何への答えかを伝える。 */
	question: string | null;
	/** ask のあとターンを終えると Orca は「報告せずに止まった」と知らせてくるので、1 回だけ読み流す。 */
	expectStop: boolean;
	/** 決めてほしいになった時刻。止めるまでの時間を数える。 */
	waitingSince: Date | null;
	/** 席ができる前・起こす前に届いた、席に渡す言葉。 */
	pending: string[];
	queuedAt: Date | null;
	/** 朝会の席。終わったら決めてほしいことを投稿にする。 */
	standup: boolean;
	/** 席の Claude が裏の shell やタイマーを待つためにターンを終えている。 */
	background: boolean;
	/** 席の Claude が最後に送った途中経過。持ち主に「いまやっていること」として返す。 */
	lastStatus: string | null;
	/** 受付の絵文字を付けた、持ち主の最新の依頼メッセージ。 */
	request: MessageRef | null;
	/** request に bot が付けているリアクション。 */
	reaction: string | null;
	/** 投稿の先頭近くに置いた状態の欄。 */
	panelId: string | null;
	/** 状態の欄に最後に書いた本文。同じ内容なら書き換えない。 */
	panelText: string | null;
	panelAt: Date | null;
	/** 投稿に出している状態と、その状態になった時刻。経過時間を数える。 */
	label: SeatLabel | null;
	labelSince: Date | null;
};

export type MessageRef = { channelId: string; messageId: string };

/** 投稿に出す状態。受付は席ができて Claude が動き出すまで。 */
export type SeatLabel = "受付" | WorkStatus;

const dateSchema = v.pipe(
	v.nullable(v.number()),
	v.transform((ms) => (ms === null ? null : new Date(ms))),
);

const seatSchema = v.object({
	status: v.picklist(["queued", "working", "asking", "waiting", "sleeping"]),
	path: v.nullable(v.string()),
	terminal: v.nullable(v.string()),
	dispatch_id: v.nullable(v.string()),
	dispatch_ids: v.array(v.string()),
	question_id: v.nullable(v.string()),
	question: v.nullable(v.string()),
	expect_stop: v.boolean(),
	waiting_since: dateSchema,
	pending: v.array(v.string()),
	queued_at: dateSchema,
	standup: v.boolean(),
	background: v.optional(v.boolean(), false),
	last_status: v.optional(v.nullable(v.string()), null),
	request: v.optional(
		v.nullable(v.object({ channel_id: v.string(), message_id: v.string() })),
		null,
	),
	reaction: v.optional(v.nullable(v.string()), null),
	panel_id: v.optional(v.nullable(v.string()), null),
	panel_text: v.optional(v.nullable(v.string()), null),
	panel_at: v.optional(dateSchema, null),
	label: v.optional(v.nullable(v.picklist(["受付", ...WORK_STATUSES])), null),
	label_since: v.optional(dateSchema, null),
});

const fileSchema = v.object({
	run_id: v.nullable(v.string()),
	reception: v.nullable(v.string()),
	seats: v.record(v.string(), seatSchema),
	partners: v.optional(v.record(v.string(), v.picklist(PARTNER_IDS)), {}),
});

export type SeatStore = {
	get: (threadId: string) => Seat | null;
	all: () => Seat[];
	byDispatch: (dispatchId: string) => Seat | null;
	set: (seat: Seat) => Promise<void>;
	delete: (threadId: string) => Promise<void>;
	orca: () => { runId: string | null; reception: string | null };
	setOrca: (o: { runId: string; reception: string }) => Promise<void>;
	/** 投稿の担当。席を閉じたあとも残し、同じ投稿にまた書かれたら同じ担当が受ける。 */
	partnerOf: (threadId: string) => PartnerId | null;
	assign: (threadId: string, partner: PartnerId) => Promise<void>;
};

export const newSeat = (threadId: string, standup = false): Seat => ({
	threadId,
	status: "queued",
	path: null,
	terminal: null,
	dispatchId: null,
	dispatchIds: [],
	questionId: null,
	question: null,
	expectStop: false,
	waitingSince: null,
	pending: [],
	queuedAt: null,
	standup,
	background: false,
	lastStatus: null,
	request: null,
	reaction: null,
	panelId: null,
	panelText: null,
	panelAt: null,
	label: null,
	labelSince: null,
});

/**
 * 投稿と席の対応。受付を作り直しても同じ席で続けられるよう volume 上の JSON に置く。
 * 受付が起動したときだけ読み、以降は手元の内容を正とする。
 */
export const openSeatStore = async (dir: string): Promise<SeatStore> => {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "seats.json");
	const seats = new Map<string, Seat>();
	const partners = new Map<string, PartnerId>();
	let orca: { runId: string | null; reception: string | null } = {
		runId: null,
		reception: null,
	};
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw !== null) {
		const parsed = v.safeParse(
			fileSchema,
			(() => {
				try {
					return JSON.parse(raw);
				} catch {
					return null;
				}
			})(),
		);
		if (!parsed.success) throw new Error(`${path} を読めない`);
		orca = { runId: parsed.output.run_id, reception: parsed.output.reception };
		for (const [id, p] of Object.entries(parsed.output.partners)) {
			partners.set(id, p);
		}
		for (const [id, s] of Object.entries(parsed.output.seats)) {
			seats.set(id, {
				threadId: id,
				status: s.status,
				path: s.path,
				terminal: s.terminal,
				dispatchId: s.dispatch_id,
				dispatchIds: s.dispatch_ids,
				questionId: s.question_id,
				question: s.question,
				expectStop: s.expect_stop,
				waitingSince: s.waiting_since,
				pending: s.pending,
				queuedAt: s.queued_at,
				standup: s.standup,
				background: s.background,
				lastStatus: s.last_status,
				request: s.request
					? {
							channelId: s.request.channel_id,
							messageId: s.request.message_id,
						}
					: null,
				reaction: s.reaction,
				panelId: s.panel_id,
				panelText: s.panel_text,
				panelAt: s.panel_at,
				label: s.label,
				labelSince: s.label_since,
			});
		}
	}

	let writing: Promise<void> = Promise.resolve();
	const flush = () => {
		const body = {
			run_id: orca.runId,
			reception: orca.reception,
			seats: Object.fromEntries(
				[...seats].map(([id, s]) => [
					id,
					{
						status: s.status,
						path: s.path,
						terminal: s.terminal,
						dispatch_id: s.dispatchId,
						dispatch_ids: s.dispatchIds,
						question_id: s.questionId,
						question: s.question,
						expect_stop: s.expectStop,
						waiting_since: s.waitingSince?.getTime() ?? null,
						pending: s.pending,
						queued_at: s.queuedAt?.getTime() ?? null,
						standup: s.standup,
						background: s.background,
						last_status: s.lastStatus,
						request: s.request
							? {
									channel_id: s.request.channelId,
									message_id: s.request.messageId,
								}
							: null,
						reaction: s.reaction,
						panel_id: s.panelId,
						panel_text: s.panelText,
						panel_at: s.panelAt?.getTime() ?? null,
						label: s.label,
						label_since: s.labelSince?.getTime() ?? null,
					},
				]),
			),
			partners: Object.fromEntries(partners),
		};
		// 書きかけで落ちても前の内容が残るよう、別名に書いてから置き換える
		writing = writing.then(async () => {
			const tmp = `${path}.tmp`;
			await writeFile(tmp, JSON.stringify(body, null, "\t"));
			await rename(tmp, path);
		});
		return writing;
	};

	return {
		get: (id) => seats.get(id) ?? null,
		all: () => [...seats.values()],
		byDispatch: (d) =>
			[...seats.values()].find((s) => s.dispatchIds.includes(d)) ?? null,
		set: (seat) => {
			seats.set(seat.threadId, seat);
			return flush();
		},
		delete: (id) => {
			if (!seats.delete(id)) return Promise.resolve();
			return flush();
		},
		orca: () => orca,
		setOrca: (o) => {
			orca = o;
			return flush();
		},
		partnerOf: (id) => partners.get(id) ?? null,
		assign: (id, partner) => {
			if (partners.get(id) === partner) return Promise.resolve();
			partners.set(id, partner);
			return flush();
		},
	};
};
