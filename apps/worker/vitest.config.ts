import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Durable Object の基底クラスは workerd にしかないので、node で動くテストでは形だけの代わりを使う
		alias: { "cloudflare:workers": "/test/cloudflare-workers.ts" },
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
