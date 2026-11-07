// 使い方: DISCORD_BOT_TOKEN=... node apps/worker/scripts/register-commands.ts
// deploy.sh が Worker を出したあとに呼ぶ。token は deploy workflow の op run が環境変数で渡す。
import { registerCommands } from "../src/register-commands.ts";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
	console.error("error: DISCORD_BOT_TOKEN が未設定");
	process.exit(1);
}
const result = await registerCommands(token);
if (!result.ok) {
	console.error(
		`error: コマンドを登録できない（${result.error.step} ${result.error.status}: ${result.error.message}）`,
	);
	process.exit(1);
}
console.log(`mizuya: コマンドを ${result.count} 件登録した`);
