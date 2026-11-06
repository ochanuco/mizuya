import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 席の元のリポジトリを Codex CLI の信頼済みにする。書き足したら true。
 * Codex は worktree の信頼を元のリポジトリで引くので、席ごとではなく元のリポジトリを 1 度だけ登録すればよい。
 * 信頼していない場所の Codex は確認の画面で止まり、Orca は席を始めない。
 * 持ち主が書いた設定を壊さないよう、表が無いときだけ末尾に足す。
 */
export const trustCodexProject = async (
	configPath: string,
	dir: string,
): Promise<boolean> => {
	const header = `[projects.${JSON.stringify(dir)}]`;
	const current = await readFile(configPath, "utf8").catch(() => "");
	if (current.split("\n").some((line) => line.trim() === header)) return false;
	await mkdir(dirname(configPath), { recursive: true });
	const sep = current === "" || current.endsWith("\n") ? "" : "\n";
	await writeFile(
		configPath,
		`${current}${sep}${current === "" ? "" : "\n"}${header}\ntrust_level = "trusted"\n`,
	);
	return true;
};
