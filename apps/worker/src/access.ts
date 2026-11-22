import {
	createRemoteJWKSet,
	errors,
	type JWTPayload,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";

/** 呼び出し元を 1 つの service token に絞る口の設定。 */
export type ServiceTokenGate = {
	teamDomain: string;
	aud: string;
	clientId: string;
};

export type GateFailure = { status: 401 | 403; error: string };

// isolate 内で JWKS を使い回す（jose が取得結果と cooldown を管理する）
const remoteKeys = new Map<string, JWTVerifyGetKey>();

const accessKeySource = (teamDomain: string): JWTVerifyGetKey => {
	let keys = remoteKeys.get(teamDomain);
	if (!keys) {
		keys = createRemoteJWKSet(
			new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
		);
		remoteKeys.set(teamDomain, keys);
	}
	return keys;
};

/**
 * Access が付けた JWT を確かめ、決めた service token から来たかを見る。
 * 口の path に Access の application が無いと、ほかの application のログインで来た JWT も届くので、
 * AUD と service token の client id（JWT の common_name）の両方で絞る。どちらかが未設定なら誰も通さない。
 */
export const checkServiceToken = async (
	request: Request,
	gate: ServiceTokenGate,
	keys: JWTVerifyGetKey = accessKeySource(gate.teamDomain),
): Promise<GateFailure | null> => {
	if (!gate.teamDomain || !gate.aud || !gate.clientId) {
		return { status: 403, error: "not_configured" };
	}
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return { status: 401, error: "missing_token" };
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, keys, {
			algorithms: ["RS256"],
			issuer: `https://${gate.teamDomain}`,
			audience: gate.aud,
		}));
	} catch (e) {
		// JWKS を取れないときも検証できないので、認証の失敗として扱う
		return {
			status: 401,
			error: e instanceof errors.JOSEError ? e.code : "invalid_token",
		};
	}
	return payload.common_name === gate.clientId
		? null
		: { status: 403, error: "unknown_caller" };
};
