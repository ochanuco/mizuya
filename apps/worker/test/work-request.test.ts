import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	ACCESS_TEAM,
	callWorker,
	makeEnv,
	mockFetch,
	REQUESTS_AUD,
	YUNOMI_CLIENT_ID,
} from "./helpers.ts";

const URL_REQUESTS = "https://mizuya.example.com/working/requests";

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	jwks = {
		keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
	};
});

beforeEach(() => {
	mockFetch((call) =>
		call.url === `https://${ACCESS_TEAM}/cdn-cgi/access/certs`
			? Response.json(jwks)
			: undefined,
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const token = (claims: Record<string, unknown>, opts: { aud?: string } = {}) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(`https://${ACCESS_TEAM}`)
		.setAudience(opts.aud ?? REQUESTS_AUD)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);

const yunomi = async () => ({
	"Cf-Access-Jwt-Assertion": await token({ common_name: YUNOMI_CLIENT_ID }),
});

const valid = {
	request_id: "019a8f3e-7c00-7abc-8def-0123456789ab",
	partner: "yukarin",
	title: "依頼の件名",
	request: "やってほしいこと",
	requested_by: "100000000000000009",
	context_url:
		"https://discord.com/channels/400000000000000001/400000000000000002/400000000000000003",
};

const post = (headers: Record<string, string>, body: unknown) =>
	new Request(URL_REQUESTS, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

describe("POST /working/requests", () => {
	it("yunomi の service token なら受け箱に work を置いて 202", async () => {
		const { env, inbox } = await makeEnv();
		const { response } = await callWorker(post(await yunomi(), valid), env);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ id: "item-1" });
		expect(inbox.puts).toEqual([{ kind: "work", body: valid, dedupe: null }]);
	});

	it("同じ request_id は同じ id を返し、二度は置かない", async () => {
		const { env, inbox } = await makeEnv();
		const first = await callWorker(post(await yunomi(), valid), env);
		const again = await callWorker(post(await yunomi(), valid), env);
		expect(again.response.status).toBe(202);
		expect(await again.response.json()).toEqual(await first.response.json());
		expect(inbox.puts).toHaveLength(1);
	});

	it("context_url は省いても null で置く", async () => {
		const { env, inbox } = await makeEnv();
		const { context_url: _, ...rest } = valid;
		const { response } = await callWorker(post(await yunomi(), rest), env);
		expect(response.status).toBe(202);
		expect(inbox.puts[0]?.body).toEqual({ ...rest, context_url: null });
	});

	it.each([
		["request_id が UUID でない", { request_id: "abc" }],
		["知らない partner", { partner: "kotonoha" }],
		["件名が空", { title: "  " }],
		["件名に改行", { title: "一行目\n二行目" }],
		["件名が 100 字を超える", { title: "あ".repeat(101) }],
		["依頼が 2000 字を超える", { request: "あ".repeat(2001) }],
		["requested_by が数字でない", { requested_by: "owner" }],
		["context_url が Discord でない", { context_url: "https://example.com/x" }],
	])("%s なら 400 validation_failed", async (_, patch) => {
		const { env, inbox } = await makeEnv();
		const { response } = await callWorker(
			post(await yunomi(), { ...valid, ...patch }),
			env,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "validation_failed" });
		expect(inbox.puts).toHaveLength(0);
	});

	it("JSON でなければ 400 invalid_json", async () => {
		const { env } = await makeEnv();
		const { response } = await callWorker(post(await yunomi(), "{"), env);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_json" });
	});

	it("JWT が無ければ 401", async () => {
		const { env, inbox } = await makeEnv();
		const { response } = await callWorker(post({}, valid), env);
		expect(response.status).toBe(401);
		expect(inbox.puts).toHaveLength(0);
	});

	it("ほかの application の JWT は 401", async () => {
		const { env } = await makeEnv();
		const jwt = await token(
			{ common_name: YUNOMI_CLIENT_ID },
			{ aud: "other-aud" },
		);
		const { response } = await callWorker(
			post({ "Cf-Access-Jwt-Assertion": jwt }, valid),
			env,
		);
		expect(response.status).toBe(401);
	});

	it("ほかの service token とログインした人は 403", async () => {
		const { env, inbox } = await makeEnv();
		for (const claims of [
			{ common_name: "other.access" },
			{ email: "owner@example.com" },
		]) {
			const { response } = await callWorker(
				post({ "Cf-Access-Jwt-Assertion": await token(claims) }, valid),
				env,
			);
			expect(response.status).toBe(403);
		}
		expect(inbox.puts).toHaveLength(0);
	});

	it.each([
		"WORKING_REQUESTS_CLIENT_ID",
		"WORKING_REQUESTS_ACCESS_AUD",
	] as const)("%s が空ならすべて 403", async (key) => {
		const { env, inbox } = await makeEnv();
		env[key] = "";
		for (const request of [post(await yunomi(), valid), post({}, valid)]) {
			const { response } = await callWorker(request, env);
			expect(response.status).toBe(403);
		}
		expect(inbox.puts).toHaveLength(0);
	});

	it("POST でなければ 405", async () => {
		const { env } = await makeEnv();
		const { response } = await callWorker(
			new Request(URL_REQUESTS, { headers: await yunomi() }),
			env,
		);
		expect(response.status).toBe(405);
	});
});
