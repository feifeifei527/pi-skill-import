#!/usr/bin/env node
/**
 * 推荐效果评测（离线、确定性、不调模型）。
 *
 *   node eval-recommend.mjs                     # 用本地索引（~/.pi-web/plugins/skill-import/storage.json）
 *   node eval-recommend.mjs --fixture           # 用固定技能库（CI 用，不依赖本机数据）
 *   node eval-recommend.mjs --fixture --check   # 低于阈值时退出码 1（CI 回归门）
 *   node eval-recommend.mjs --list              # 只打印每个需求的 top3，供人工审阅/标注
 *
 * 这版评测检查检索层是否命中样例中显式列出的技能名标签，
 * 不再用 /training|pdf/i 这类类别正则；不是独立人工盲测或端到端质量认证。
 *
 * 覆盖：
 * - 中文口语 / 中英混合 / 只有两字母缩写（RL / KL）
 * - 多轮短回复（「这个呢 / 好的 / 继续」沿用上一次任务）
 * - 「库里没有合适技能」不硬凑
 * - 已装技能不重复推荐（单独进 installedHits）
 * - mustNot：明显不该出现的技能
 *
 * 不覆盖（别当成已证明）：
 * - 模型精排「值不值得装」的判断质量 → recommend.test.mjs 锁住了精排输入与 picks 解析
 * - 查询扩展质量（要真调模型）
 * - 真实技能库的覆盖率：fixture 只有 15 条；真实索引请用 --list 人工看
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTask } = require("./core/task.cjs");
const { buildBm25Index, bm25Search } = require("./core/bm25.cjs");
const { rrf, dedupe } = require("./core/rrf.cjs");
const { coverageOk, directionCompatible, isStrongToken } = require("./core/coverage.cjs");

const HERE = dirname(fileURLToPath(import.meta.url));
const THRESHOLDS = { top1: 0.6, top3: 0.85, noFit: 1 };

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const useFixture = flags.has("--fixture");
const listOnly = flags.has("--list");
const check = flags.has("--check");

const storagePath = positional[0] ?? join(homedir(), ".pi-web", "plugins", "skill-import", "storage.json");

function loadJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function loadCatalog() {
	if (useFixture) {
		const fixture = loadJson(join(HERE, "eval", "fixture-catalog.json"));
		return { label: `fixture（${fixture.entries.length} 条）`, entries: fixture.entries };
	}
	let raw;
	try {
		raw = loadJson(storagePath);
	} catch (err) {
		console.error(`读不到索引：${storagePath}\n${err.message}`);
		console.error("提示：先跑一次 `node eval-recommend.mjs --fixture`，或在面板里点一次「更新技能库」。");
		process.exit(2);
	}
	const catalog = raw.catalog ?? raw;
	const entries = catalog.entries ?? [];
	if (!entries.length) {
		console.error(`索引为空：${storagePath}（先在面板里点一次「更新技能库」）`);
		process.exit(2);
	}
	if (catalog.schema !== 3) console.warn("注意：索引不是 schema 3（条目缺少 repo+path+ref 身份），建议重建索引后重跑\n");
	return { label: `${storagePath}（${entries.length} 条 · ${new Date(catalog.at ?? 0).toLocaleString()}）`, entries };
}

function loadCases() {
	const raw = loadJson(join(HERE, "eval", "cases.json"));
	return raw.cases ?? [];
}

/**
 * 与 server/recommend.cjs 的离线路径保持一致：任务理解 → BM25 → RRF → 覆盖率 → 去重。
 * 不做查询扩展与模型精排（那两步要调模型）。
 */
function runCase(testCase, bm25, catalogNames) {
	const messages = (testCase.messages ?? [testCase.q]).map((text) => ({ role: "user", text }));
	const task = buildTask({ messages, project: {} });
	const installed = new Set(testCase.installed ?? []);
	const t0 = process.hrtime.bigint();
	const list = bm25Search(bm25, task.keywords, { limit: 30 });
	const merged = rrf([list], { limit: 20 });
	const baseCount = Math.max(1, task.keywords.length);

	const matchTokens = (entry) => {
		const hay = `${entry.name} ${entry.description ?? ""} ${(entry.tasks ?? []).join(" ")}`.toLowerCase();
		return task.keywords.filter((t) => hay.includes(t));
	};
	const matchCount = (entry) => matchTokens(entry).length;
	const installedHits = [];
	for (const m of merged) {
		const entry = m.item?.card ?? m.item;
		if (!entry?.name || !installed.has(entry.name)) continue;
		if (matchCount(entry) === 0) continue;
		installedHits.push(entry.name);
	}
	const candidates = dedupe(
		merged
			.map((m) => {
				const entry = m.item?.card ?? m.item;
				if (!entry?.name || installed.has(entry.name) || !directionCompatible(entry, task.task)) return null;
				const tokens = matchTokens(entry);
				if (!coverageOk(tokens.length, baseCount, { strongSingle: tokens.some(isStrongToken) })) return null;
				return entry;
			})
			.filter(Boolean),
	);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	const top3 = candidates.slice(0, 3).map((c) => c.name);
	return {
		top3,
		all: candidates.map((c) => c.name),
		installedHits,
		ms,
		namesKnown: (testCase.expect ?? []).some((n) => catalogNames.has(n)),
	};
}

function main() {
	const catalog = loadCatalog();
	const cases = loadCases();
	const bm25 = buildBm25Index(catalog.entries);
	const catalogNames = new Set(catalog.entries.map((e) => e.name));

	console.log(`索引：${catalog.label}`);
	console.log(`评测集：${cases.length} 条（eval/cases.json）${listOnly ? " · 仅列出" : ""}\n`);

	let top1 = 0;
	let top3 = 0;
	let scored = 0;
	let skipped = 0;
	let noFitTotal = 0;
	let noFitCorrect = 0;
	let violations = 0;
	let installedChecked = 0;
	let installedOk = 0;
	let totalMs = 0;
	let worstMs = 0;
	const failures = [];

	for (const c of cases) {
		const res = runCase(c, bm25, catalogNames);
		totalMs += res.ms;
		worstMs = Math.max(worstMs, res.ms);

		if (listOnly) {
			console.log(`· ${c.q ?? c.messages?.join(" → ")}`);
			console.log(`    top3: ${res.top3.join(", ") || "(空)"}${res.installedHits.length ? ` · 已装命中: ${res.installedHits.join(", ")}` : ""}`);
			continue;
		}

		if (c.expectNone) {
			noFitTotal++;
			const ok = res.all.length === 0;
			if (ok) noFitCorrect++;
			else failures.push(`${c.id}: 应该返回「没有合适技能」，实际有 ${res.all.length} 条（${res.all.slice(0, 3).join(", ")}）`);
			console.log(`${ok ? "✅" : "❌"} [无合适] ${c.q}  → 候选 ${res.all.length}`);
			continue;
		}

		const hasExpect = Array.isArray(c.expect) && c.expect.length > 0;
		if (!hasExpect) {
			// 只验「已装 / 不该出现」的用例：不算 Top1/Top3，但 mustNot 与已装照样判定
			const bad = (c.mustNot ?? []).filter((n) => res.top3.includes(n));
			if (bad.length) violations++;
			const installedList = c.installed ?? [];
			if (installedList.length) {
				installedChecked++;
				const okHit = (c.expectInstalledHits ?? []).every((n) => res.installedHits.includes(n));
				const repeat = res.all.some((n) => installedList.includes(n));
				if (okHit && !repeat) installedOk++;
				else failures.push(`${c.id}: 已装技能应只进 installedHits（top3: ${res.top3.join(", ") || "空"}）`);
			}
			if (bad.length) failures.push(`${c.id}: 出现不该推荐的 ${bad.join(", ")}`);
			const mark = bad.length ? "❌" : "✅";
			console.log(`${mark} ${c.id}（已装/黑名单用例）\n     top3: ${res.top3.join(" | ") || "(空)"}${res.installedHits.length ? ` · 已装: ${res.installedHits.join(",")}` : ""}  (${res.ms.toFixed(2)}ms)`);
			continue;
		}
		if (!res.namesKnown) {
			skipped++;
			console.log(`⏭  ${c.id}：标注里的技能不在这个索引里（真实索引请用 --list 人工看）`);
			continue;
		}
		scored++;
		const expect = new Set(c.expect);
		const hitTop1 = expect.has(res.top3[0]);
		const hitTop3 = res.top3.some((n) => expect.has(n));
		const bad = (c.mustNot ?? []).filter((n) => res.top3.includes(n));
		if (hitTop1) top1++;
		if (hitTop3) top3++;
		if (bad.length) violations++;
		if (!hitTop3) failures.push(`${c.id}: top3 没有适用的（${res.top3.join(", ") || "空"}）`);
		if (bad.length) failures.push(`${c.id}: 出现不该推荐的 ${bad.join(", ")}`);

		if ((c.installed ?? []).length) {
			installedChecked++;
			const okHit = (c.expectInstalledHits ?? []).every((n) => res.installedHits.includes(n));
			const repeat = res.all.some((n) => c.installed.includes(n));
			if (okHit && !repeat) installedOk++;
			else failures.push(`${c.id}: 已装技能应只进 installedHits`);
		}

		const mark = hitTop3 && !bad.length ? (hitTop1 ? "✅" : "🟡") : "❌";
		const extra = res.installedHits.length ? ` · 已装: ${res.installedHits.join(",")}` : "";
		console.log(`${mark} ${c.id}\n     top3: ${res.top3.join(" | ") || "(空)"}${extra}  (${res.ms.toFixed(2)}ms)`);
	}

	const avg = cases.length ? totalMs / cases.length : 0;
	console.log("\n—— 汇总 ——");
	if (listOnly) {
		console.log(`平均耗时：${avg.toFixed(2)}ms/次（不含模型调用）`);
		return 0;
	}
	const pct = (v, n) => (n ? `${((v / n) * 100).toFixed(0)}%` : "—");
	console.log(`Top1 标签命中：${top1}/${scored} (${pct(top1, scored)})`);
	console.log(`Top3 标签命中：${top3}/${scored} (${pct(top3, scored)})`);
	console.log(`无合适技能判定：${noFitCorrect}/${noFitTotal}`);
	console.log(`出现不该推荐的技能：${violations} 次`);
	console.log(`已装不重复推荐：${installedOk}/${installedChecked}`);
	console.log(`平均耗时：${avg.toFixed(2)}ms/次（最慢 ${worstMs.toFixed(2)}ms，不含模型调用）`);
	console.log(`模型调用：0 次（仅离线回归；单元测试不证明精排质量）`);
	if (skipped) console.log(`跳过（标注技能不在索引里）：${skipped} 条`);
	if (failures.length) {
		console.log("\n未通过：");
		for (const f of failures) console.log(`  · ${f}`);
	}

	if (check) {
		const problems = [];
		if (!scored || skipped) problems.push(`样例未完整评分（有效 ${scored}，跳过 ${skipped}）`);
		if (scored && top1 / scored < THRESHOLDS.top1) problems.push(`Top1 ${pct(top1, scored)} < ${THRESHOLDS.top1 * 100}%`);
		if (scored && top3 / scored < THRESHOLDS.top3) problems.push(`Top3 ${pct(top3, scored)} < ${THRESHOLDS.top3 * 100}%`);
		if (noFitTotal && noFitCorrect / noFitTotal < THRESHOLDS.noFit) problems.push(`无合适技能判定 ${noFitCorrect}/${noFitTotal}`);
		if (violations) problems.push(`出现不该推荐的技能 ${violations} 次`);
		if (installedChecked && installedOk < installedChecked) problems.push(`已装重复推荐 ${installedChecked - installedOk} 次`);
		if (problems.length) {
			console.error(`\n[--check] 未达标：${problems.join("；")}`);
			return 1;
		}
		console.log("\n[--check] 全部达标");
	}
	// 不带 --check 时只报告，不影响退出码（真实索引的人工审阅不该被当成失败）
	return 0;
}

process.exit(main());
