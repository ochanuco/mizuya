import { describe, expect, it } from "vitest";
import {
	verifyDiscordSignature,
	verifyGithubSignature,
} from "../src/signature.ts";
import { discordSignature, githubSignature, makeEnv } from "./helpers.ts";

describe("verifyGithubSignature", () => {
	const secret = "s3cret";
	const body = '{"hello":"world"}';

	it("正しい署名を受け入れる", async () => {
		const header = await githubSignature(secret, body);
		expect(await verifyGithubSignature(secret, body, header)).toBe(true);
	});

	it("本文が変わっていれば拒む", async () => {
		const header = await githubSignature(secret, body);
		expect(await verifyGithubSignature(secret, `${body} `, header)).toBe(false);
	});

	it("別の secret の署名を拒む", async () => {
		const header = await githubSignature("other", body);
		expect(await verifyGithubSignature(secret, body, header)).toBe(false);
	});

	it("ヘッダがない・形式が違うものを拒む", async () => {
		expect(await verifyGithubSignature(secret, body, null)).toBe(false);
		expect(await verifyGithubSignature(secret, body, "sha1=abcd")).toBe(false);
		expect(await verifyGithubSignature(secret, body, "sha256=zz")).toBe(false);
	});
});

describe("verifyDiscordSignature", () => {
	const body = '{"type":1}';
	const timestamp = "1700000000";
	const now = 1700000010;

	it("正しい署名を受け入れる", async () => {
		const { env, discordKey } = await makeEnv();
		const sig = await discordSignature(discordKey.privateKey, timestamp, body);
		expect(
			await verifyDiscordSignature(
				env.DISCORD_PUBLIC_KEY,
				body,
				sig,
				timestamp,
				now,
			),
		).toBe(true);
	});

	it("timestamp が違えば拒む", async () => {
		const { env, discordKey } = await makeEnv();
		const sig = await discordSignature(discordKey.privateKey, timestamp, body);
		expect(
			await verifyDiscordSignature(
				env.DISCORD_PUBLIC_KEY,
				body,
				sig,
				"1700000001",
				now,
			),
		).toBe(false);
	});

	it("別の鍵の署名を拒む", async () => {
		const { env } = await makeEnv();
		const other = await makeEnv();
		const sig = await discordSignature(
			other.discordKey.privateKey,
			timestamp,
			body,
		);
		expect(
			await verifyDiscordSignature(
				env.DISCORD_PUBLIC_KEY,
				body,
				sig,
				timestamp,
				now,
			),
		).toBe(false);
	});

	it("5 分より古い timestamp は、署名が正しくても拒む", async () => {
		const { env, discordKey } = await makeEnv();
		const sig = await discordSignature(discordKey.privateKey, timestamp, body);
		expect(
			await verifyDiscordSignature(
				env.DISCORD_PUBLIC_KEY,
				body,
				sig,
				timestamp,
				Number(timestamp) + 301,
			),
		).toBe(false);
	});

	it("ヘッダがない・壊れたものを拒む", async () => {
		const { env } = await makeEnv();
		expect(
			await verifyDiscordSignature(
				env.DISCORD_PUBLIC_KEY,
				body,
				null,
				timestamp,
				now,
			),
		).toBe(false);
		expect(
			await verifyDiscordSignature(
				env.DISCORD_PUBLIC_KEY,
				body,
				"abcd",
				timestamp,
				now,
			),
		).toBe(false);
	});
});
