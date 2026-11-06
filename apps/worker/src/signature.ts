const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
	if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/** GitHub の X-Hub-Signature-256（`sha256=<hex>`）を検証する。比較は subtle.verify に任せて定数時間にする */
export async function verifyGithubSignature(
	secret: string,
	body: string,
	header: string | null,
): Promise<boolean> {
	if (!header?.startsWith("sha256=")) return false;
	const signature = hexToBytes(header.slice("sha256=".length));
	if (signature?.length !== 32) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
}

// 署名は timestamp を含むので、古い timestamp を拒めば盗んだリクエストの再送を防げる
const MAX_SKEW_SECONDS = 300;

/** Discord の interaction の Ed25519 署名（timestamp + body）を検証する */
export async function verifyDiscordSignature(
	publicKeyHex: string,
	body: string,
	signatureHex: string | null,
	timestamp: string | null,
	nowSeconds: number = Date.now() / 1000,
): Promise<boolean> {
	if (!signatureHex || !timestamp || !/^\d+$/.test(timestamp)) return false;
	if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
	const publicKey = hexToBytes(publicKeyHex);
	const signature = hexToBytes(signatureHex);
	if (publicKey?.length !== 32) return false;
	if (signature?.length !== 64) return false;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			publicKey,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify(
			"Ed25519",
			key,
			signature,
			encoder.encode(timestamp + body),
		);
	} catch {
		return false;
	}
}

/** 共有の token を比べる。長さも中身も比べる時間に出ないよう、両方の SHA-256 を最後まで比べる */
export async function sameSecret(
	given: string,
	expected: string,
): Promise<boolean> {
	const [a, b] = await Promise.all(
		[given, expected].map(
			async (s) =>
				new Uint8Array(
					await crypto.subtle.digest("SHA-256", encoder.encode(s)),
				),
		),
	);
	let diff = 0;
	for (let i = 0; i < 32; i++) diff |= (a?.[i] ?? 0) ^ (b?.[i] ?? 0);
	return diff === 0;
}
