export type DegradedEffect = "none" | "degrade";
export type AuditSeverity = "info" | "warn" | "error";

type ErrorMeta = {
	message: string;
	retryable: boolean;
	userVisible: boolean;
	degradedEffect: DegradedEffect;
	auditSeverity: AuditSeverity;
};

type Kind<TType extends string, TFields> = { type: TType } & ErrorMeta &
	TFields;

export type PermissionDenied = Kind<
	"PermissionDenied",
	{ actor: string; action: string }
>;

export type ExternalServiceUnavailable = Kind<
	"ExternalServiceUnavailable",
	{ service: string }
>;

export type RateLimited = Kind<"RateLimited", { retryAfterMs: number | null }>;

export type ValidationFailed = Kind<
	"ValidationFailed",
	{ issues: readonly string[] }
>;

export type DomainError =
	| PermissionDenied
	| ExternalServiceUnavailable
	| RateLimited
	| ValidationFailed;

export const permissionDenied = (
	f: Pick<PermissionDenied, "actor" | "action">,
): PermissionDenied => ({
	type: "PermissionDenied",
	message: `${f.actor} に ${f.action} の権限がない`,
	retryable: false,
	userVisible: true,
	degradedEffect: "none",
	auditSeverity: "warn",
	...f,
});

export const externalServiceUnavailable = (
	f: Pick<ExternalServiceUnavailable, "service">,
): ExternalServiceUnavailable => ({
	type: "ExternalServiceUnavailable",
	message: `外部サービス ${f.service} が利用できない`,
	retryable: true,
	userVisible: false,
	degradedEffect: "degrade",
	auditSeverity: "error",
	...f,
});

export const rateLimited = (
	f: Pick<RateLimited, "retryAfterMs"> = { retryAfterMs: null },
): RateLimited => ({
	type: "RateLimited",
	message: "レート制限に達した",
	retryable: true,
	userVisible: true,
	degradedEffect: "degrade",
	auditSeverity: "info",
	...f,
});

export const validationFailed = (
	f: Pick<ValidationFailed, "issues">,
): ValidationFailed => ({
	type: "ValidationFailed",
	message: `入力が不正: ${f.issues.join(", ")}`,
	retryable: false,
	userVisible: true,
	degradedEffect: "none",
	auditSeverity: "info",
	...f,
});
