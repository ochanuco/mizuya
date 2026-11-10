import type { Result } from "./lib/core.ts";

export type SeatEngineError =
	| { type: "EngineFailed"; command: string; reason: string }
	/** 席の作業場所を Claude CLI の信頼済みにできなかった。 */
	| { type: "SeatTrustFailed"; command: string; reason: string }
	/** 止めた席の worktree が無くなっていて、前の会話のまま起こせない。 */
	| { type: "SeatWorktreeMissing"; command: string; reason: string }
	/** 席のセッションを他の機械が借りていて起こせない。reason は持ち主。 */
	| { type: "SeatLeaseHeld"; command: string; reason: string };

/** 席から受付に届くメッセージ。 */
export type SeatMessage = {
	id: string;
	/** question（hs ask）、status（hs status）、worker_done（返事のあるターンの終わり）、escalation（返事の無いターンの終わり）。 */
	type: string;
	/** 送り手の席の handle。 */
	from: string;
	subject: string;
	body: string;
	dispatchId: string | null;
	outcome: "succeeded" | "failed" | null;
	/** 返事の無いターンの終わりに付く理由。 */
	stopReason: string | null;
};

/** 席で動かす CLI agent。Yukarin は Claude CLI、Akarin は Codex CLI。 */
export type SeatAgent = "claude" | "codex";

/**
 * 席の agent の起こし方。
 * - start: 新規（Codex は ID を外から渡せないので、セッションを預けるときもこれ）
 * - resume: 作業ディレクトリの最新の会話を続ける
 * - session: session_id を決めて起こす。resume なら前の会話を続け、そうでなければその ID で新規に始める
 */
export type SeatHow =
	| "start"
	| "resume"
	| { sessionId: string; resume: boolean };

/**
 * worktree ができてから agent を起こす前に呼ぶ。cwd は agent が動く作業場所（realpath）。
 * 起こし方と、変えるなら spec を返す。席を起こしてはいけないとき（他の機械が借りている）は持ち主を返す。
 * lease は借りた hishaku の番号と世代。席は、これで番号の会話を続けて預ける。
 */
export type SeatPrepare = (cwd: string) => Promise<
	Result<
		{
			how: SeatHow;
			spec?: string;
			lease?: { number: number; generation: number };
		},
		{ holder: string }
	>
>;

/**
 * 席の居場所。dispatchId は席に渡した仕事の ID で、席から届くメッセージを投稿に引き当てる。
 * terminal は席の handle。
 */
export type SeatHandle = { dispatchId: string; terminal: string; path: string };

export type SeatResidue = {
	worktrees: string[];
	terminals: { handle: string; path: string }[];
};

/** 受付と席のやりとりの口。受付はこの口だけで席を動かす。 */
export type SeatEngine = {
	/** 席の agent の報告を受ける口を開く。席を作る前に呼ぶ。 */
	start: () => Promise<Result<void, SeatEngineError>>;
	/** 新しい worktree に席を作り、agent に spec を渡す。 */
	startSeat: (input: {
		name: string;
		title: string;
		spec: string;
		agent: SeatAgent;
		/** 席で動かすモデル。null なら CLI の既定のモデル。 */
		model?: string | null;
		prepare?: SeatPrepare;
	}) => Promise<Result<SeatHandle, SeatEngineError>>;
	/** 止めた席の agent を前の会話のまま起こし、spec を渡す。 */
	resumeSeat: (input: {
		path: string;
		title: string;
		spec: string;
		agent: SeatAgent;
		model?: string | null;
		prepare?: SeatPrepare;
	}) => Promise<Result<SeatHandle, SeatEngineError>>;
	/** 席のモデルを、会話を保ったまま切り替える。次のターンから効く。 */
	switchModel: (input: {
		terminal: string;
		model: string;
	}) => Promise<Result<void, SeatEngineError>>;
	/** 席に続きを渡す。作業中ならターンの終わりに、手を止めた席ならすぐ次のターンとして渡す。 */
	send: (input: {
		dispatchId: string;
		subject: string;
		body: string;
	}) => Promise<
		Result<{ dispatchId: string; terminal: string | null }, SeatEngineError>
	>;
	/** 質問への答えを次のターンとして渡す。 */
	reply: (input: {
		messageId: string;
		body: string;
	}) => Promise<Result<void, SeatEngineError>>;
	/** 席の agent を止める。worktree は残す。 */
	stopSeat: (seat: {
		dispatchId: string | null;
		terminal: string | null;
	}) => Promise<Result<void, SeatEngineError>>;
	removeWorktree: (path: string) => Promise<Result<void, SeatEngineError>>;
	closeTerminal: (handle: string) => Promise<Result<void, SeatEngineError>>;
	liveTerminals: () => Promise<Result<Set<string>, SeatEngineError>>;
	/** 席の置き場所にある worktree と、その中の端末。 */
	residue: () => Promise<Result<SeatResidue, SeatEngineError>>;
	/** 届いたメッセージを待って受け取る。届かないまま timeoutMs たてば空で返す。 */
	waitMessages: (
		timeoutMs: number,
	) => Promise<Result<SeatMessage[], SeatEngineError>>;
};
