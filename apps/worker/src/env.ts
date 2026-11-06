// secret は wrangler.jsonc に書かないので、`wrangler types` の Env には出てこない。ここで型を持つ
export type Bindings = {
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_APPROVER_TOKEN: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_BOT_TOKEN: string;
	DISCORD_APPROVER_USER_ID: string;
	DISCORD_APPROVAL_CHANNEL_ID: string;
};

export type WaitUntil = (promise: Promise<unknown>) => void;
