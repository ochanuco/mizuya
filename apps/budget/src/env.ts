// secret は wrangler.jsonc に書かないので、`wrangler types` の Env には出てこない。ここで型を持つ
export type Bindings = {
	DB: D1Database;
	CLOUDFLARE_ACCOUNT_ID: string;
	BUDGET_MONTHLY_USD: string;
	BUDGET_THRESHOLDS_PERCENT: string;
	CLOUDFLARE_BILLING_TOKEN: string;
	DISCORD_BOT_TOKEN: string;
	DISCORD_APPROVER_USER_ID: string;
	DISCORD_BUDGET_CHANNEL_ID: string;
};

export type Result<T, E = string> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export const DASHBOARD_URL = "https://budget.chanu.co/";
