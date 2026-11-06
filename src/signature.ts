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

/** Discord の interaction の Ed25519 署名（timestamp + body）を検証する */
export async function verifyDiscordSignature(
	publicKeyHex: string,
	body: string,
	signatureHex: string | null,
	timestamp: string | null,
): Promise<boolean> {
	if (!signatureHex || !timestamp) return false;
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
