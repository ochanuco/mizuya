// コンテナの yunomi-memory の本体。/opt/yunomi-memory/ に置き、node で直接動かす。
import { runMemoryCli } from "./cli.ts";

const out = await runMemoryCli(process.argv.slice(2), process.env);
process.stdout.write(out.stdout);
process.stderr.write(out.stderr);
process.exit(out.code);
