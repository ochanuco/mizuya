import { parseBudgetConfig } from "./config.ts";
import type { Bindings } from "./env.ts";
import { addDays } from "./period.ts";
import { loadFetched, loadUsage } from "./store.ts";
import { formatPercent, formatUsd, type Summary, summarize } from "./usage.ts";

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export const escapeHtml = (s: string): string =>
	s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e2dc;--bar:#3d6fb6;--ok:#2e7d32;--warn:#c77700;--over:#c62828;--track:#ecece6}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecece8;--muted:#a0a09a;--line:#33332f;--bar:#79a5e6;--ok:#66bb6a;--warn:#ffb74d;--over:#ef5350;--track:#2b2b28}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.35rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:0 0 12px}
.muted{color:var(--muted);font-size:.875rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat .label{color:var(--muted);font-size:.8rem}
.stat .value{font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums}
.meter{position:relative;height:14px;background:var(--track);border-radius:7px;overflow:hidden;margin-top:12px}
.meter .fill{height:100%;border-radius:7px}
.meter .forecast{position:absolute;top:0;bottom:0;width:2px;background:var(--fg);opacity:.6}
.ok{background:var(--ok)}.warn{background:var(--warn)}.over{background:var(--over)}
svg{display:block;width:100%;height:auto}
svg .bar{fill:var(--bar)}
svg .axis{stroke:var(--line)}
svg text{fill:var(--muted);font-size:10px}
.table{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
td.num,th.num{text-align:right}
`;

const JST_MS = 9 * 3_600_000;

const formatJst = (iso: string): string => {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return `${new Date(t + JST_MS).toISOString().slice(0, 16).replace("T", " ")} JST`;
};

function meterClass(summary: Summary): string {
	if (summary.percent >= 100) return "over";
	if (summary.forecastPercent >= 100) return "warn";
	return "ok";
}

function chart(summary: Summary): string {
	const width = 720;
	const height = 200;
	const top = 16;
	const bottom = 24;
	const left = 4;
	const plot = height - top - bottom;
	const max = Math.max(...summary.daily.map((d) => d.cost), 0);
	const step = (width - left * 2) / summary.daily.length;
	const barWidth = Math.max(1, step * 0.7);
	const bars = summary.daily
		.map((d, i) => {
			const h = max > 0 ? (d.cost / max) * plot : 0;
			const x = left + i * step + (step - barWidth) / 2;
			const y = top + plot - h;
			return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}"><title>${escapeHtml(`${d.date} ${formatUsd(d.cost)}`)}</title></rect>`;
		})
		.join("");
	const labels = summary.daily
		.map((d, i) =>
			i % 7 === 0
				? `<text x="${(left + i * step + step / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle">${escapeHtml(d.date.slice(5))}</text>`
				: "",
		)
		.join("");
	return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="日ごとの利用額">
<line class="axis" x1="0" y1="${top + plot}" x2="${width}" y2="${top + plot}"/>
<text x="${left}" y="10">${escapeHtml(`最大 ${formatUsd(max)}`)}</text>
${bars}${labels}</svg>`;
}

function serviceTable(summary: Summary): string {
	if (summary.services.length === 0) return `<p class="muted">利用なし</p>`;
	const rows = summary.services
		.map(
			(s) =>
				`<tr><td>${escapeHtml(s.family)}</td><td>${escapeHtml(s.service)}</td><td class="num">${
					s.quantity === null
						? "—"
						: escapeHtml(
								`${s.quantity.toLocaleString("en-US", { maximumFractionDigits: 2 })}${s.unit ? ` ${s.unit}` : ""}`,
							)
				}</td><td class="num">${escapeHtml(formatUsd(s.cost))}</td></tr>`,
		)
		.join("");
	return `<div class="table"><table><thead><tr><th>製品群</th><th>製品</th><th class="num">量</th><th class="num">額</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export type DashboardView =
	| { kind: "empty" }
	| { kind: "error"; message: string }
	| { kind: "ready"; summary: Summary; fetchedAt: string };

function body(view: DashboardView): string {
	if (view.kind === "empty")
		return `<div class="card"><p>まだ取得していません。毎日 10:00（JST）に取得します。</p></div>`;
	if (view.kind === "error")
		return `<div class="card"><p>${escapeHtml(view.message)}</p></div>`;
	const { summary, fetchedAt } = view;
	const lastDay = addDays(summary.period.end, -1);
	const fill = Math.min(100, summary.percent);
	const forecastAt = Math.min(100, summary.forecastPercent);
	return `<p class="muted">今期 ${escapeHtml(summary.period.start)} 〜 ${escapeHtml(lastDay)}（${summary.elapsedDays}/${summary.daysInPeriod} 日）・取得 ${escapeHtml(formatJst(fetchedAt))}</p>
<section class="card">
<div class="stats">
<div class="stat"><div class="label">今期の累計</div><div class="value">${escapeHtml(formatUsd(summary.periodToDate))}</div><div class="muted">予算 ${escapeHtml(formatUsd(summary.budgetUsd))} の ${escapeHtml(formatPercent(summary.percent))}</div></div>
<div class="stat"><div class="label">月末の予測</div><div class="value">${escapeHtml(formatUsd(summary.forecast))}</div><div class="muted">予算の ${escapeHtml(formatPercent(summary.forecastPercent))}</div></div>
<div class="stat"><div class="label">前日の額</div><div class="value">${escapeHtml(formatUsd(summary.yesterday))}</div><div class="muted">${escapeHtml(addDays(summary.today, -1))}</div></div>
</div>
<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${fill.toFixed(0)}" aria-label="予算に対する累計"><div class="fill ${meterClass(summary)}" style="width:${fill.toFixed(1)}%"></div><div class="forecast" style="left:calc(${forecastAt.toFixed(1)}% - 1px)" title="月末の予測"></div></div>
</section>
<section class="card"><h2>日ごとの額</h2>${chart(summary)}</section>
<section class="card"><h2>製品別</h2>${serviceTable(summary)}</section>`;
}

export function renderDashboard(view: DashboardView): string {
	return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mizuya 予算</title>
<style>${CSS}</style>
</head>
<body><main>
<h1>Cloudflare の利用額</h1>
${body(view)}
</main></body>
</html>`;
}

export async function dashboardView(env: Bindings): Promise<DashboardView> {
	const config = parseBudgetConfig(env);
	if (!config.ok) return { kind: "error", message: config.error };
	const fetched = await loadFetched(env.DB);
	if (!fetched) return { kind: "empty" };
	// 取得した日を「今日」として、cron の報告と同じ数字を出す
	const today = fetched.at.slice(0, 10);
	const rows = await loadUsage(
		env.DB,
		fetched.period.start,
		addDays(today, -1),
	);
	return {
		kind: "ready",
		summary: summarize(rows, fetched.period, today, config.value.monthlyUsd),
		fetchedAt: fetched.at,
	};
}

export async function handleDashboard(env: Bindings): Promise<Response> {
	let view: DashboardView;
	try {
		view = await dashboardView(env);
	} catch (e) {
		console.error("budget: D1 を読めない", e);
		view = {
			kind: "error",
			message:
				"D1 を読めませんでした。migration を適用したか確かめてください。",
		};
	}
	return new Response(renderDashboard(view), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		},
	});
}
