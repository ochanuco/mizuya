// hook として node で直接動かすため、node の組み込み以外を import しない。

/** 単純コマンド 1 つ分。args は引用符を外した語、redirects はリダイレクトの行き先。 */
export type SimpleCommand = {
	args: string[];
	redirects: { mode: "read" | "write"; target: string }[];
	/** `$(...)` や `` `...` `` の中身。中身も別のコマンドとして調べる。 */
	substitutions: string[];
};

/**
 * Bash のコマンド文字列を単純コマンドの並びに分ける。
 * 実行を真似るのではなく、止めるべき操作を見落とさない程度に読む。引用符の中は 1 語にまとめ、
 * ヒアドキュメントの本文はコマンドとして読まない。
 */
export const splitCommands = (raw: string): SimpleCommand[] => {
	const out: SimpleCommand[] = [];
	let cur: SimpleCommand = { args: [], redirects: [], substitutions: [] };
	let tok = "";
	let has = false;
	let redirect: "read" | "write" | null = null;
	let heredocs: { delim: string; strip: boolean }[] = [];
	let readingHeredocDelim: { strip: boolean } | null = null;

	const endTok = () => {
		if (has) {
			if (readingHeredocDelim) {
				heredocs.push({ delim: tok, strip: readingHeredocDelim.strip });
				readingHeredocDelim = null;
			} else if (redirect) {
				cur.redirects.push({ mode: redirect, target: tok });
				redirect = null;
			} else {
				cur.args.push(tok);
			}
		}
		tok = "";
		has = false;
	};
	const endCmd = () => {
		endTok();
		if (
			cur.args.length > 0 ||
			cur.redirects.length > 0 ||
			cur.substitutions.length > 0
		) {
			out.push(cur);
		}
		cur = { args: [], redirects: [], substitutions: [] };
	};
	// `$(` から対応する `)` までを取り出す。入れ子の括弧も数える。
	const readSubstitution = (start: number): [string, number] => {
		let depth = 1;
		let i = start;
		while (i < raw.length && depth > 0) {
			const c = raw[i];
			if (c === "(") depth++;
			else if (c === ")") depth--;
			i++;
		}
		return [raw.slice(start, depth === 0 ? i - 1 : i), i];
	};
	const readBacktick = (start: number): [string, number] => {
		const end = raw.indexOf("`", start);
		return end === -1
			? [raw.slice(start), raw.length]
			: [raw.slice(start, end), end + 1];
	};

	let i = 0;
	while (i < raw.length) {
		const c = raw[i] as string;
		const next = raw[i + 1];
		if (c === "\\" && i + 1 < raw.length) {
			if (next !== "\n") {
				tok += next;
				has = true;
			}
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = raw.indexOf("'", i + 1);
			const stop = end === -1 ? raw.length : end;
			tok += raw.slice(i + 1, stop);
			has = true;
			i = stop + 1;
			continue;
		}
		if (c === '"') {
			i++;
			while (i < raw.length && raw[i] !== '"') {
				const d = raw[i] as string;
				if (d === "\\" && i + 1 < raw.length) {
					tok += raw[i + 1];
					i += 2;
				} else if (d === "$" && raw[i + 1] === "(") {
					const [body, end] = readSubstitution(i + 2);
					cur.substitutions.push(body);
					tok += raw.slice(i, end);
					i = end;
				} else if (d === "`") {
					const [body, end] = readBacktick(i + 1);
					cur.substitutions.push(body);
					tok += raw.slice(i, end);
					i = end;
				} else {
					tok += d;
					i++;
				}
			}
			has = true;
			i++;
			continue;
		}
		if (c === "$" && next === "(") {
			const [body, end] = readSubstitution(i + 2);
			cur.substitutions.push(body);
			tok += raw.slice(i, end);
			has = true;
			i = end;
			continue;
		}
		if (c === "`") {
			const [body, end] = readBacktick(i + 1);
			cur.substitutions.push(body);
			tok += raw.slice(i, end);
			has = true;
			i = end;
			continue;
		}
		if (c === "\n") {
			endCmd();
			i++;
			if (heredocs.length > 0) {
				// ヒアドキュメントの本文を区切りの行まで読み飛ばす
				for (const h of heredocs) {
					while (i < raw.length) {
						const eol = raw.indexOf("\n", i);
						const lineEnd = eol === -1 ? raw.length : eol;
						const line = raw.slice(i, lineEnd);
						i = lineEnd + 1;
						if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
					}
				}
				heredocs = [];
			}
			continue;
		}
		if (c === " " || c === "\t") {
			endTok();
			i++;
			continue;
		}
		if (c === "<" && next === "<" && raw[i + 2] !== "<") {
			endTok();
			const strip = raw[i + 2] === "-";
			readingHeredocDelim = { strip };
			i += strip ? 3 : 2;
			continue;
		}
		if (c === ">" || c === "<") {
			// 2>&1 のような fd の付け替えは行き先がない
			if (/^\d+$/.test(tok)) {
				tok = "";
				has = false;
			}
			endTok();
			if (c === ">" && (next === "&" || next === ">")) {
				i += 2;
				if (raw[i - 1] === "&") {
					while (i < raw.length && /[\d-]/.test(raw[i] as string)) i++;
					continue;
				}
			} else {
				i++;
			}
			redirect = c === ">" ? "write" : "read";
			continue;
		}
		if (c === "&" && next === ">") {
			endTok();
			redirect = "write";
			i += raw[i + 2] === ">" ? 3 : 2;
			continue;
		}
		if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
			endCmd();
			i++;
			continue;
		}
		tok += c;
		has = true;
		i++;
	}
	endCmd();
	return out;
};
