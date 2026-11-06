// hook として node で直接動かすため、node の組み込み以外を import しない（node_modules の .ts は型を剥がせない）。
import { isAbsolute, resolve } from "node:path";

/** 許可の単位。同じ道具に同じ対象を渡すときだけ同じ操作とみなす。 */
export type Operation = { tool: string; target: string };

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

export const absPath = (p: string, cwd: string, home: string): string => {
	const expanded = p === "~" ? home : p.replace(/^~\//, `${home}/`);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
};

/**
 * キーの順によらない JSON。Bash 以外の道具は引数の JSON を操作として許可と突き合わせるので、
 * 同じ引数ならキーの並びが変わっても同じ操作とみなす。
 */
export const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

export const operationOf = (
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	home: string,
): Operation => {
	// Codex の apply_patch はパッチの本文を command に入れてくる
	if (tool === "Bash" || tool === "apply_patch") {
		return { tool, target: (str(input.command) ?? "").trim() };
	}
	const path = str(input.file_path) ?? str(input.notebook_path);
	if (path !== null) return { tool, target: absPath(path, cwd, home) };
	if (tool === "Glob" || tool === "Grep") {
		const dir = absPath(str(input.path) ?? cwd, cwd, home);
		return { tool, target: `${dir} ${str(input.pattern) ?? ""}`.trim() };
	}
	return { tool, target: canonicalJson(input) };
};

export const sameOperation = (a: Operation, b: Operation) =>
	a.tool === b.tool && a.target === b.target;

export const isUnder = (path: string, dir: string) =>
	path === dir || path.startsWith(`${dir.replace(/\/$/, "")}/`);
