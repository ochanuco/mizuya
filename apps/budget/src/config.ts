import * as v from "valibot";
import type { Bindings, Result } from "./env.ts";

export type BudgetConfig = {
	monthlyUsd: number;
	/** 昇順 */
	thresholdsPercent: number[];
};

const PositiveNumber = v.pipe(
	v.string(),
	v.trim(),
	v.nonEmpty(),
	v.transform(Number),
	v.number(),
	v.finite(),
	v.minValue(Number.MIN_VALUE),
);

const ConfigSchema = v.object({
	BUDGET_MONTHLY_USD: PositiveNumber,
	BUDGET_THRESHOLDS_PERCENT: v.pipe(
		v.string(),
		v.transform((s) => s.split(",")),
		v.array(PositiveNumber),
		v.minLength(1),
	),
});

export function parseBudgetConfig(
	env: Pick<Bindings, "BUDGET_MONTHLY_USD" | "BUDGET_THRESHOLDS_PERCENT">,
): Result<BudgetConfig> {
	const parsed = v.safeParse(ConfigSchema, {
		BUDGET_MONTHLY_USD: env.BUDGET_MONTHLY_USD,
		BUDGET_THRESHOLDS_PERCENT: env.BUDGET_THRESHOLDS_PERCENT,
	});
	if (!parsed.success) {
		const issue = parsed.issues[0];
		const key = issue ? v.getDotPath(issue) : null;
		return {
			ok: false,
			error: `予算の設定が読めない（${key ?? "?"}: ${issue?.message ?? ""}）`,
		};
	}
	return {
		ok: true,
		value: {
			monthlyUsd: parsed.output.BUDGET_MONTHLY_USD,
			thresholdsPercent: [
				...new Set(parsed.output.BUDGET_THRESHOLDS_PERCENT),
			].sort((a, b) => a - b),
		},
	};
}
