import { vi } from "vitest";
import type { Bindings } from "../src/env.ts";
import worker from "../src/index.ts";

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const APPROVER_ID = "100000000000000001";
export const OTHER_USER_ID = "100000000000000002";
export const CHANNEL_ID = "200000000000000001";
export const APPLICATION_ID = "300000000000000001";

export async function makeEnv(): Promise<{
	env: Bindings;
	discordKey: CryptoKeyPair;
}> {
	const discordKey = (await crypto.subtle.generateKey(
		{ name: "Ed25519" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const publicKey = await crypto.subtle.exportKey("raw", discordKey.publicKey);
	return {
		discordKey,
		env: {
			GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
			GITHUB_APPROVER_TOKEN: "test-github-token",
			DISCORD_PUBLIC_KEY: toHex(publicKey as ArrayBuffer),
			DISCORD_BOT_TOKEN: "test-bot-token",
			DISCORD_APPROVER_USER_ID: APPROVER_ID,
			DISCORD_APPROVAL_CHANNEL_ID: CHANNEL_ID,
		},
	};
}

export async function githubSignature(secret: string, body: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	return `sha256=${toHex(mac)}`;
}

export async function discordSignature(
	key: CryptoKey,
	timestamp: string,
	body: string,
) {
	const sig = await crypto.subtle.sign(
		"Ed25519",
		key,
		encoder.encode(timestamp + body),
	);
	return toHex(sig);
}

export type Call = {
	method: string;
	url: string;
	headers: Headers;
	body: unknown;
};

/** fetch をモックし、呼ばれた順に記録する。handler が undefined を返したら 404 */
export function mockFetch(
	handler: (call: Call) => Response | undefined,
): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const raw = init?.body;
			const call: Call = {
				method: init?.method ?? "GET",
				url: String(input),
				headers: new Headers(init?.headers),
				body: typeof raw === "string" ? JSON.parse(raw) : undefined,
			};
			calls.push(call);
			return handler(call) ?? new Response("not mocked", { status: 404 });
		}),
	);
	return calls;
}

export async function callWorker(
	request: Request,
	env: Bindings,
): Promise<{ response: Response; settled: () => Promise<void> }> {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
	const response = await worker.fetch(
		request as Request<unknown, IncomingRequestCfProperties>,
		env,
		ctx,
	);
	return {
		response,
		settled: async () => {
			await Promise.all(pending);
		},
	};
}
