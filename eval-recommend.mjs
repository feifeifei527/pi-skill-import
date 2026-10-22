#!/usr/bin/env node
/**
 * 推荐效果基线（离线、确定性、不调模型）。
 *
 *   node eval-recommend.mjs [catalog.json]
 *
 * catalog 默认读 ~/.pi-web/plugins/skill-import/storage.json 里的 catalog 节点。
 * 指标：Recall@20、Top3 命中率、无合适技能时的正确率（返回 0 候选）、单次耗时。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { buildTask } = require("./core/task.cjs");
const { buildBm25Index, bm25Search } = require("./core/bm25.cjs");
const { rrf, dedupe } = require("./core/rrf.cjs");

const CASES = [
	{ q: "把这个 PDF 里的表格抽出来", expect: /pdf|table/i },
	{ q: "帮我写一份周报 PPT", expect: /ppt|slide|presentation|slides/i },
	{ q: "训练 PPO 的时候 reward 突然掉了，帮我排查", expect: /reinforcement|stable-?baselines|rl\b|training/i },
	{ q: "给仓库写一条 conventional commit", expect: /commit|git/i },
	{ q: "抓一下这个网页的内容并总结", expect: /crawl|scrap|firecrawl|browser|fetch|web/i },
	{ q: "把 Word 文档转成 markdown", expect: /docx|word|document/i },
	{ q: "画一张出版级的折线图", expect: /matplotlib|plot|chart|visuali[sz]/i },
	{ q: "查一下这篇论文的 DOI 和引用格式", expect: /citation|doi|crossref|bibtex|paper|literature/i },
	{ q: "给 React 项目做可访问性检查", expect: /accessib|a11y|web-design|frontend|ui/i },
	{ q: "把这个仓库的代码审查一遍", expect: /review|audit|code/i },
	{ q: "帮我控制机械臂抓取桌上的物体", expectNone: true },
	{ q: "根据我的星座运势安排今天的日程", expectNone: true },
];

const file = process.argv[2] ?? join(homedir(), ".pi-web", "plugins", "skill-import", "storage.json");
const raw = JSON.parse(readFileSync(file, "utf8"));
const catalog = raw.catalog ?? raw;
const entries = catalog.entries ?? [];
if (entries.length === 0) {
	console.error(`索引为空：${file}（先在面板里点一次「重建索引」）`);
	process.exit(1);
}
if (catalog.schema !== 2) {
	console.warn("注意：索引不是 schema 2（缺少能力卡片），建议重建索引后重跑\n");
}

const bm25 = buildBm25Index(entries);
let recallHits = 0;
let top3Hits = 0;
let noFitCorrect = 0;
let noFitTotal = 0;
let totalMs = 0;

console.log(`索引：${entries.length} 个技能 · schema=${catalog.schema ?? "?"}\n`);
for (const c of CASES) {
	const t0 = Date.now();
	const task = buildTask({ messages: [{ role: "user", text: c.q }], project: {} });
	const list = bm25Search(bm25, task.keywords, { limit: 30 });
	const merged = rrf([list], { limit: 20 });
	const baseCount = Math.max(1, task.keywords.length);
	const candidates = dedupe(
		merged
			.map((m) => {
				const e = m.item?.card ?? m.item;
				if (!e?.name) return null;
				const hay = `${e.name} ${e.description ?? ""} ${(e.tasks ?? []).join(" ")}`.toLowerCase();
				const matched = task.keywords.filter((t) => hay.includes(t)).length;
				return matched > 0 && matched / baseCount >= 0.1 ? e : null;
			})
			.filter(Boolean),
	);
	const ms = Date.now() - t0;
	totalMs += ms;

	if (c.expectNone) {
		noFitTotal++;
		const ok = candidates.length === 0;
		if (ok) noFitCorrect++;
		console.log(`${ok ? "✅" : "❌"} [无合适] ${c.q}  → 候选 ${candidates.length}`);
		continue;
	}

	const hitIndex = candidates.findIndex((e) => c.expect.test(`${e.name} ${e.description ?? ""}`));
	const recall = hitIndex >= 0;
	const top3 = hitIndex >= 0 && hitIndex < 3;
	if (recall) recallHits++;
	if (top3) top3Hits++;
	console.log(
		`${top3 ? "✅" : recall ? "🟡" : "❌"} ${c.q}\n     命中位置 ${recall ? hitIndex + 1 : "无"} · top3=${candidates
			.slice(0, 3)
			.map((e) => e.name)
			.join(", ")}  (${ms}ms)`,
	);
}

const scored = CASES.filter((c) => !c.expectNone).length;
console.log("\n—— 汇总 ——");
console.log(`Recall@20: ${recallHits}/${scored} (${((recallHits / scored) * 100).toFixed(0)}%)`);
console.log(`Top3 命中:  ${top3Hits}/${scored} (${((top3Hits / scored) * 100).toFixed(0)}%)`);
console.log(`无合适技能判定: ${noFitCorrect}/${noFitTotal}`);
console.log(`平均耗时: ${(totalMs / CASES.length).toFixed(1)}ms/次（不含模型调用）`);
