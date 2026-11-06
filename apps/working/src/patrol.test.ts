import { describe, expect, it } from "vitest";
import { diffPatrol, openPatrolStore, patrolSources } from "./patrol.ts";
import type { RenovatePr, StandupMaterials } from "./standup-materials.ts";
import { tempDir } from "./test-support.ts";

const renovate = (number: number, ci: RenovatePr["ci"]): RenovatePr => ({
	repo: "ochanuco/yunomi",
	number,
	title: `deps ${number}`,
	url: `https://github.com/ochanuco/yunomi/pull/${number}`,
	branch: `renovate/${number}`,
	draft: false,
	onboarding: false,
	ci,
	mergeable: "MERGEABLE",
	merge_state: "CLEAN",
});

const materials = (
	github: Partial<StandupMaterials["github"]>,
	goals: StandupMaterials["goals"] = [],
): StandupMaterials => ({
	memory: null,
	goals,
	watches: [],
	mac_state: { unavailable: "x" },
	github: {
		open_prs: [],
		failing_prs: [],
		handoffs: [],
		working_prs: [],
		renovate_prs: [],
		...github,
	},
	claude_login: { expires_at: null, expires_soon: false },
});

describe("diffPatrol", () => {
	it("CI の状態が変わった Renovate の PR だけを拾う", () => {
		const first = diffPatrol(
			{},
			patrolSources(
				materials({
					renovate_prs: [renovate(1, "pending"), renovate(2, "success")],
				}),
			),
		);
		const second = diffPatrol(
			first.next,
			patrolSources(
				materials({
					renovate_prs: [renovate(1, "failure"), renovate(2, "success")],
				}),
			),
		);
		expect(second.changes).toEqual({ renovate_prs: [renovate(1, "failure")] });
	});

	it("取れなかった source は前の回の分を残し、次に取れても新着と見ない", () => {
		const first = diffPatrol(
			{},
			patrolSources(materials({ renovate_prs: [renovate(1, "success")] })),
		);
		const down = diffPatrol(
			first.next,
			patrolSources(materials({ renovate_prs: { unavailable: "x" } })),
		);
		expect(down.changes).toEqual({});
		const back = diffPatrol(
			down.next,
			patrolSources(materials({ renovate_prs: [renovate(1, "success")] })),
		);
		expect(back.changes).toEqual({});
	});

	it("repo ごとに取れなかった分も前の回の分を残す", () => {
		const first = diffPatrol(
			{},
			patrolSources(materials({ renovate_prs: [renovate(1, "success")] })),
		);
		const down = diffPatrol(
			first.next,
			patrolSources(
				materials({
					renovate_prs: [{ repo: "ochanuco/yunomi", unavailable: "x" }],
				}),
			),
		);
		expect(down.next.renovate_prs).toEqual({
			"ochanuco/yunomi#1": "success/MERGEABLE/CLEAN",
		});
	});

	it("消えた件は忘れるので、また出れば新着になる", () => {
		const pr = {
			repo: "ochanuco/yunomi",
			number: 5,
			title: "t",
			url: "u",
			draft: false,
			author: null,
			updated_at: null,
		};
		const a = diffPatrol({}, patrolSources(materials({ failing_prs: [pr] })));
		const b = diffPatrol(a.next, patrolSources(materials({})));
		const c = diffPatrol(
			b.next,
			patrolSources(materials({ failing_prs: [pr] })),
		);
		expect(c.changes).toEqual({ failing_prs: [pr] });
	});
});

describe("目標の見張り", () => {
	const goal = (id: string) => ({
		id,
		summary: `目標 ${id}`,
		created_at: "2026-11-06 12:00 JST",
	});

	it("足された目標だけを拾い、閉じて消えた目標は拾わない", () => {
		const first = diffPatrol({}, patrolSources(materials({}, [goal("g1")])));
		const added = diffPatrol(
			first.next,
			patrolSources(materials({}, [goal("g1"), goal("g2")])),
		);
		expect(added.changes).toEqual({ goals: [goal("g2")] });
		const closed = diffPatrol(
			added.next,
			patrolSources(materials({}, [goal("g2")])),
		);
		expect(closed.changes).toEqual({});
	});

	it("記憶を読めなかった回は前の回の目標を残す", () => {
		const first = diffPatrol({}, patrolSources(materials({}, [goal("g1")])));
		const down = diffPatrol(
			first.next,
			patrolSources(materials({}, { unavailable: "x" })),
		);
		const back = diffPatrol(
			down.next,
			patrolSources(materials({}, [goal("g1")])),
		);
		expect(back.changes).toEqual({});
	});
});

describe("openPatrolStore", () => {
	it("保存したものを読み直せる。無ければ null", async () => {
		const store = openPatrolStore(tempDir());
		expect(await store.load()).toBeNull();
		await store.save({ open_prs: { "a#1": "ready" } });
		expect(await store.load()).toEqual({ open_prs: { "a#1": "ready" } });
	});
});
