import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, normalize, sep } from "node:path";
import {
	ATTACHMENT_COUNT_LIMIT,
	ATTACHMENT_SIZE_LIMIT,
	ATTACHMENT_TOTAL_LIMIT,
	type Attachment,
} from "./discord-rest.ts";
import { err, ok, type Result } from "./lib/core.ts";
import type { Logger } from "./logger.ts";

/** 席の Claude が返事に書く添付の指示。 */
export type AttachRef =
	| { kind: "file"; path: string }
	| { kind: "chimera"; shortId: string };

const FILE_LINE = /^\s*添付\s*[:：]\s*`?([^`]*?)`?\s*$/;
// 値は ASCII の 1 語だけ。「chimera: の行で書く」のような文は本文に残す
const CHIMERA_LINE = /^\s*chimera\s*[:：]\s*`?([!-_a-~]+)`?\s*$/i;
const FENCE = /^\s*(```|~~~)/;
/** chimera の short_id。 */
const SHORT_ID = /^[a-z0-9]{6}$/;

/** 席のファイルを置く場所。worktree の直下の out/。 */
export const OUT_DIR = "out";

/** 返事から添付の行を抜き出し、残りを本文として返す。コードブロックの中の行は本文のまま残す。 */
export const takeAttachRefs = (
	text: string,
): { body: string; refs: AttachRef[] } => {
	const refs: AttachRef[] = [];
	const kept: string[] = [];
	let fenced = false;
	for (const line of text.split("\n")) {
		if (FENCE.test(line)) fenced = !fenced;
		const file = fenced ? null : FILE_LINE.exec(line);
		const chimera = fenced ? null : CHIMERA_LINE.exec(line);
		if (file?.[1]) refs.push({ kind: "file", path: file[1] });
		else if (chimera?.[1]) refs.push({ kind: "chimera", shortId: chimera[1] });
		else kept.push(line);
	}
	return {
		body: kept
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		refs,
	};
};

const CONTENT_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
	".log": "text/plain",
	".mp4": "video/mp4",
	".zip": "application/zip",
};

const contentTypeOf = (name: string) =>
	CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

type Rejected = { reason: string };

/**
 * worktree の out/ にあるファイルを読む。
 * 実体のパス（シンボリックリンクをたどった先）が worktree の out/ の下にあるものだけを通す。
 */
export const readSeatFile = async (
	worktree: string,
	path: string,
): Promise<Result<Attachment, Rejected>> => {
	if (isAbsolute(path)) return err({ reason: "out/ の外のパス" });
	const rel = normalize(path);
	if (rel !== OUT_DIR && !rel.startsWith(`${OUT_DIR}${sep}`)) {
		return err({ reason: "out/ の外のパス" });
	}
	let real: string;
	let root: string;
	try {
		root = await realpath(worktree);
		real = await realpath(join(worktree, rel));
	} catch {
		return err({ reason: "ファイルが無い" });
	}
	if (!real.startsWith(`${join(root, OUT_DIR)}${sep}`)) {
		return err({ reason: "out/ の外を指している" });
	}
	const st = await stat(real);
	if (!st.isFile()) return err({ reason: "ファイルではない" });
	if (st.size > ATTACHMENT_SIZE_LIMIT) {
		return err({ reason: `${mb(ATTACHMENT_SIZE_LIMIT)} を超える` });
	}
	const name = basename(real);
	return ok({
		name,
		contentType: contentTypeOf(name),
		data: new Uint8Array(await readFile(real)),
	});
};

/** chimera から元の画像を取る。 */
export type ChimeraImages = (
	shortId: string,
) => Promise<Result<Attachment, Rejected>>;

export type ChimeraOptions = {
	baseUrl: string;
	clientId: string;
	clientSecret: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

/** chimera の手前の Cloudflare は User-Agent の無い要求を弾く。 */
export const CHIMERA_USER_AGENT = "mizuya-working/1.0";

export const createChimeraImages = (opts: ChimeraOptions): ChimeraImages => {
	const doFetch = opts.fetch ?? fetch;
	const base = opts.baseUrl.replace(/\/+$/, "");
	return async (shortId) => {
		let res: Response;
		try {
			res = await doFetch(`${base}/g/${shortId}/image`, {
				headers: {
					"CF-Access-Client-Id": opts.clientId,
					"CF-Access-Client-Secret": opts.clientSecret,
					"User-Agent": CHIMERA_USER_AGENT,
				},
				// Access の token が通らないとログイン画面へ転送される。その HTML を画像として付けない
				redirect: "manual",
				signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
			});
		} catch {
			return err({ reason: "chimera に届かない" });
		}
		if (res.status === 404 || res.status === 410) {
			return err({ reason: "chimera に元の画像が無い" });
		}
		if (!res.ok) return err({ reason: `chimera が ${res.status} を返した` });
		const type = res.headers.get("content-type") ?? "";
		if (!type.startsWith("image/")) {
			return err({ reason: "chimera が画像を返さなかった" });
		}
		const length = Number(res.headers.get("content-length") ?? "0");
		if (length > ATTACHMENT_SIZE_LIMIT) {
			return err({ reason: `${mb(ATTACHMENT_SIZE_LIMIT)} を超える` });
		}
		const data = new Uint8Array(await res.arrayBuffer());
		if (data.byteLength > ATTACHMENT_SIZE_LIMIT) {
			return err({ reason: `${mb(ATTACHMENT_SIZE_LIMIT)} を超える` });
		}
		const ext = type.split(";")[0] === "image/png" ? ".png" : "";
		return ok({ name: `${shortId}${ext}`, contentType: type, data });
	};
};

/** 投稿に付けるファイルと、付けられなかったものを知らせる文（無ければ空）。 */
export type Collected = { files: Attachment[]; note: string };

export type AttachmentCollector = (
	worktree: string | null,
	refs: readonly AttachRef[],
) => Promise<Collected>;

/** 本文の後ろに、付けられなかったものの知らせを足す。 */
export const withNote = (body: string, note: string) =>
	[body, note].filter((s) => s !== "").join("\n\n");

const labelOf = (ref: AttachRef) =>
	ref.kind === "file" ? ref.path : `chimera ${ref.shortId}`;

export const createAttachmentCollector = (deps: {
	chimera: ChimeraImages | null;
	logger: Logger;
}): AttachmentCollector => {
	const fetchOne = async (
		worktree: string | null,
		ref: AttachRef,
	): Promise<Result<Attachment, Rejected>> => {
		if (ref.kind === "file") {
			if (worktree === null) return err({ reason: "席の作業場所が無い" });
			return readSeatFile(worktree, ref.path);
		}
		if (!SHORT_ID.test(ref.shortId)) {
			return err({ reason: "short_id の形ではない" });
		}
		if (deps.chimera === null) {
			return err({ reason: "受付に chimera の設定が無い" });
		}
		return deps.chimera(ref.shortId);
	};

	return async (worktree, refs) => {
		const files: Attachment[] = [];
		const notes: string[] = [];
		const names = new Set<string>();
		let total = 0;
		for (const ref of refs) {
			if (files.length >= ATTACHMENT_COUNT_LIMIT) {
				notes.push(
					`${labelOf(ref)}（1 件に付けられるのは ${ATTACHMENT_COUNT_LIMIT} 個まで）`,
				);
				continue;
			}
			const r = await fetchOne(worktree, ref);
			if (!r.ok) {
				deps.logger.warn("seat attachment rejected", {
					kind: ref.kind,
					reason: r.error.reason,
				});
				notes.push(`${labelOf(ref)}（${r.error.reason}）`);
				continue;
			}
			if (total + r.value.data.byteLength > ATTACHMENT_TOTAL_LIMIT) {
				notes.push(
					`${labelOf(ref)}（1 件の合計が ${mb(ATTACHMENT_TOTAL_LIMIT)} を超える）`,
				);
				continue;
			}
			total += r.value.data.byteLength;
			// Discord は同じ名前のファイルを区別しないので、重なったら番号を付ける
			let name = r.value.name;
			for (let n = 2; names.has(name); n++) name = `${n}-${r.value.name}`;
			names.add(name);
			files.push({ ...r.value, name });
		}
		const note =
			notes.length === 0
				? ""
				: `添付できなかったもの:\n${notes.map((n) => `- ${n}`).join("\n")}`;
		return { files, note };
	};
};
