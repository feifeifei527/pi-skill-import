import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { tokenize, buildProfile, scoreCatalog, parseRerank } = require("./core/recommend.cjs");
const {
	createRecommendService,
	buildIndex,
	entriesFromTree,
	parseRepoSpec,
	sourceList,
	discoverSources,
	readMarketCacheRepos,
} = require("./server/recommend.cjs");
const { createImportService } = require("./server/import-service.cjs");
const { createOps } = require("./server/ops.cjs");
const { buildZip, fakeHttp, createFakeHost, makeScopes, packFrom, SKILL_MD } = require("./test-helpers.mjs");

// ---------- 纯逻辑 ----------

describe("分词与画像", () => {
	it("英文词 + 中文二元组，过滤虚词", () => {
		const t = tokenize("帮我从 PDF 里抽表格，用 python 处理");
		assert.ok(t.includes("pdf"));
		assert.ok(t.includes("python"));
		assert.ok(t.includes("抽表") || t.includes("表格"));
		assert.ok(!t.includes("the"));
	});

	it("画像给项目特征更高权重", () => {
		const p = buildProfile({
			messages: [{ role: "user", text: "改一下 pdf 导出" }],
			files: { "package.json": "react vite pdf-lib" },
			hints: ["数据可视化"],
		});
		assert.ok((p.weights.get("pdf") ?? 0) >= 4, "对话 + 依赖都应命中 pdf");
		assert.ok(p.weights.has("react"));
		assert.ok(p.keywords.length > 0);
	});
});

describe("打分", () => {
	const entries = [
		{ name: "pdf-tools", description: "Extract text and tables from PDF files", repo: "o/r" },
		{ name: "matplotlib-plots", description: "Publication quality scientific plots with python matplotlib", repo: "o/r" },
		{ name: "git-commit", description: "Write conventional commit messages", repo: "o/r" },
	];

	it("相关技能排前面，并给出命中词", () => {
		const profile = buildProfile({ messages: [{ role: "user", text: "帮我把这个 PDF 里的表格抽出来" }] });
		const ranked = scoreCatalog({ entries, profile, limit: 3 });
		assert.equal(ranked[0].name, "pdf-tools");
		assert.ok(ranked[0].why.includes("pdf"));
	});

	it("已装/已停用的会被排除", () => {
		const profile = buildProfile({ files: { "package.json": "matplotlib python" } });
		const ranked = scoreCatalog({ entries, profile, installed: new Set(["matplotlib-plots"]), limit: 3 });
		assert.ok(!ranked.some((r) => r.name === "matplotlib-plots"));
	});

	it("通用词降权：只命中 skills 的技能不再碾压", () => {
		const entries = [
			{ name: "skills-helper", description: "skills skills skills helper for agents", repo: "o/r" },
			{ name: "pdf-tools", description: "extract tables from pdf", repo: "o/r" },
		];
		// 画像里 skills 权重极高、pdf 只有一点点
		const profile = { weights: new Map([["skills", 20], ["pdf", 1]]), keywords: [] };
		const ranked = scoreCatalog({ entries, profile, limit: 2 });
		assert.equal(ranked[0].name, "pdf-tools", `实际: ${ranked.map((r) => `${r.name}=${r.score}`).join(", ")}`);
		assert.ok(ranked[0].score > ranked[1].score);
	});

	it("ignored 里的技能被排除", () => {
		const profile = buildProfile({ messages: [{ role: "user", text: "pdf 表格" }] });
		const ranked = scoreCatalog({ entries, profile, ignored: new Set(["pdf-tools"]), limit: 3 });
		assert.ok(!ranked.some((r) => r.name === "pdf-tools"));
	});

	it("没有相关词时返回空", () => {
		const profile = buildProfile({ messages: [{ role: "user", text: "今天天气不错" }] });
		assert.deepEqual(scoreCatalog({ entries, profile }), []);
	});
});

describe("LLM 重排结果解析", () => {
	const cands = [{ name: "a" }, { name: "b" }];
	it("接受干净 JSON / 带说明文字 / 字符串数组", () => {
		assert.deepEqual(parseRerank('[{"name":"a","reason":"因为"}]', cands).map((x) => x.name), ["a"]);
		assert.deepEqual(parseRerank('好的：\n```json\n[{"name":"b"}]\n```', cands).map((x) => x.name), ["b"]);
		assert.deepEqual(parseRerank('["a"]', cands).map((x) => x.name), ["a"]);
	});
	it("坏 JSON / 未知名字 → null（调用方回落）", () => {
		assert.equal(parseRerank("not json", cands), null);
		assert.equal(parseRerank('[{"name":"zzz"}]', cands), null);
	});
});

// ---------- 索引 ----------

const REPO_ZIP = buildZip([
	{ name: "repo-main/skills/demo/SKILL.md", data: SKILL_MD },
	{ name: "repo-main/skills/demo/scripts/extract.sh", data: "#!/bin/sh\n" },
	{ name: "repo-main/skills/other/SKILL.md", data: "---\nname: other\ndescription: 另一个技能，当需要别的能力时使用。\n---\n" },
	{ name: "repo-main/README.md", data: "# repo" },
]);

/** 带限制/依赖/IO 的技能：验证精排能看到这些字段（不被截掉）。 */
const RICH_ZIP = buildZip([
	{
		name: "repo-main/skills/train-debug/SKILL.md",
		data: [
			"---",
			"name: train-debug",
			"description: 诊断强化学习训练不稳定：reward 突然下降、KL 爆炸时使用。",
			"---",
			"## 输入",
			"- 输入：训练日志目录。",
			"- 输出：诊断报告。",
			"## 限制",
			"- 不支持多机训练",
			"- 仅支持 PyTorch 训练日志",
			"安装依赖：pip install tensorboard",
		].join("\n"),
	},
	{
		name: "repo-main/skills/paper/SKILL.md",
		data: [
			"---",
			"name: pdf-tools",
			"description: 从 PDF 提取文本与表格，当用户需要读取、转换或检查 PDF 时使用。",
			"---",
			"## 使用",
			"- 输入：PDF 文件。",
			"- 输出：Markdown 表格。",
			"- 不支持扫描件 OCR",
		].join("\n"),
	},
]);

describe("仓库索引", () => {
	it("解析仓库写法", () => {
		assert.deepEqual(parseRepoSpec("anthropics/skills"), { owner: "anthropics", repo: "skills", ref: "" });
		assert.deepEqual(parseRepoSpec("https://github.com/o/r#dev"), { owner: "o", repo: "r", ref: "dev" });
		assert.deepEqual(parseRepoSpec("git@github.com:o/r.git"), { owner: "o", repo: "r", ref: "" });
		assert.equal(parseRepoSpec("nope"), null);
	});

	it("设置里的仓库列表支持逗号/换行", () => {
		assert.deepEqual(sourceList("a/b, c/d\ne/f"), ["a/b", "c/d", "e/f"]);
		const defaults = sourceList("");
		assert.ok(defaults.length >= 5, "默认应该是一批源");
		assert.equal(defaults[0], "anthropics/skills");
	});

	it("从文件树里提取 name/description：同名不同目录各自一条（用 id 区分），无描述跳过", () => {
		const files = packFrom({
			"skills/a/SKILL.md": "---\nname: a\ndescription: A 技能，当需要 a 时使用。\n---\n",
			"skills/b/SKILL.md": "---\nname: a\ndescription: 另一个仓库版本的 a。\n---\n",
			"skills/c/SKILL.md": "---\nname: c\n---\n",
			"README.md": "# x",
		});
		const entries = entriesFromTree(files, "o/r", "main");
		// 不再按 name 合并：同名但不同目录是不同条目（能力可能不一样）
		assert.deepEqual(entries.map((e) => e.name), ["a", "a"]);
		assert.deepEqual(entries.map((e) => e.id).sort(), ["o/r@main:skills/a", "o/r@main:skills/b"]);
		assert.equal(entries[0].path, "skills/a");
		assert.equal(entries[0].ref, "main");
		assert.ok(!entries.some((e) => e.name === "c"), "没 description 的要跳过");
	});

	it("仓库没新提交时复用上次条目，不再下载", async () => {
		const calls = [];
		const zip = buildZip([{ name: "r-main/skills/demo/SKILL.md", data: SKILL_MD }]);
		const http = {
			get: async (url) => {
				calls.push(url);
				if (url === "https://api.github.com/repos/o/r") {
					return { ok: true, buffer: Buffer.from(JSON.stringify({ pushed_at: "2026-01-01T00:00:00Z" })) };
				}
				if (url.includes("codeload")) return { ok: true, buffer: zip };
				return { ok: false, error: "unexpected" };
			},
		};
		const first = await buildIndex({ sources: ["o/r"], http });
		assert.equal(first.entries.length, 1);
		assert.equal(first.sourceStats[0].via, "zip");

		calls.length = 0;
		const second = await buildIndex({ sources: ["o/r"], http, previous: first });
		assert.equal(second.sourceStats[0].via, "cache");
		assert.equal(second.entries.length, 1);
		assert.ok(!calls.some((u) => u.includes("codeload")), "命中缓存不该再下 zip");

		// meta 缓存期内不重复问 GitHub
		calls.length = 0;
		await buildIndex({ sources: ["o/r"], http, previous: second });
		assert.ok(!calls.some((u) => u.includes("api.github.com")), "6h 内不该再调元信息接口");

		// meta 缓存过期 + 有新提交 → 重新拉
		const http2 = {
			get: async (url) => {
				calls.push(url);
				if (url === "https://api.github.com/repos/o/r") {
					return { ok: true, buffer: Buffer.from(JSON.stringify({ pushed_at: "2026-02-02T00:00:00Z" })) };
				}
				if (url.includes("codeload")) return { ok: true, buffer: zip };
				return { ok: false, error: "unexpected" };
			},
		};
		const stale = {
			...second,
			perSource: { "o/r": { ...second.perSource["o/r"], metaAt: 0 } },
		};
		const third = await buildIndex({ sources: ["o/r"], http: http2, previous: stale });
		assert.equal(third.sourceStats[0].via, "zip");
	});

	it("元信息失败但有旧条目 → 沿用而不是清空", async () => {
		const zip = buildZip([{ name: "r-main/skills/demo/SKILL.md", data: SKILL_MD }]);
		const okHttp = { get: async (url) => (url.includes("codeload") ? { ok: true, buffer: zip } : { ok: true, buffer: Buffer.from(JSON.stringify({ pushed_at: "t1" })) }) };
		const first = await buildIndex({ sources: ["o/r"], http: okHttp });
		assert.equal(first.entries.length, 1);

		const deadHttp = { get: async () => ({ ok: false, error: "HTTP 403 rate limit exceeded" }) };
		const stalePrev = { ...first, perSource: { "o/r": { ...first.perSource["o/r"], metaAt: 0 } } };
		const second = await buildIndex({ sources: ["o/r"], http: deadHttp, previous: stalePrev });
		assert.equal(second.entries.length, 1, "旧条目要保留");
		assert.equal(second.sourceStats[0].via, "stale");
		assert.match(second.sourceStats[0].error, /rate limit/);
	});

	it("仓库体积超上限时直接走 tree，不下载 zip", async () => {
		const calls = [];
		const tree = [{ type: "blob", path: "skills/demo/SKILL.md", size: 10 }];
		const http = {
			get: async (url) => {
				calls.push(url);
				if (url.includes("git/trees")) return { ok: true, buffer: Buffer.from(JSON.stringify({ tree })) };
				if (url.includes("/repos/o/r")) return { ok: true, buffer: Buffer.from(JSON.stringify({ pushed_at: "t1", size: 300000 })) };
				if (url.includes("raw.githubusercontent")) return { ok: true, buffer: Buffer.from(SKILL_MD) };
				if (url.includes("codeload")) return { ok: true, buffer: buildZip([{ name: "x/SKILL.md", data: SKILL_MD }]) };
				return { ok: false, error: "unexpected" };
			},
		};
		const res = await buildIndex({ sources: ["o/r"], http });
		assert.equal(res.entries.length, 1);
		assert.equal(res.sourceStats[0].via, "tree");
		assert.ok(!calls.some((u) => u.includes("codeload")), "不该下载 zip");
	});

	it("同仓库不同 ref 的缓存互不覆盖，刷新后也不会串分支", async () => {
		const makeZip = (ref) => buildZip([{ name: `r-${ref}/skills/dup/SKILL.md`, data: `---\nname: dup\ndescription: ${ref} 分支的 PDF 提取技能\n---\n` }]);
		let calls = 0;
		const http = { get: async (url) => {
			calls++;
			return url.includes("api.github.com") ? { ok: true, buffer: Buffer.from('{"pushed_at":"t1"}') } : { ok: true, buffer: makeZip(url.includes("v2") ? "v2" : "main") };
		} };
		const first = await buildIndex({ sources: ["o/r#main", "o/r#v2"], http });
		assert.deepEqual(new Set(first.entries.map((e) => e.ref)), new Set(["main", "v2"]));
		assert.equal(first.perSource["o/r#main"].entries[0].ref, "main");
		assert.equal(first.perSource["o/r#v2"].entries[0].ref, "v2");
		calls = 0;
		const second = await buildIndex({ sources: ["o/r#main", "o/r#v2"], http, previous: first });
		assert.equal(calls, 0);
		assert.deepEqual(new Set(second.entries.map((e) => e.ref)), new Set(["main", "v2"]));
	});

	it("buildIndex 汇总多个仓库并记录错误", async () => {
		const http = fakeHttp(REPO_ZIP);
		const index = await buildIndex({ sources: ["o/r", "bad"], http });
		assert.deepEqual(index.entries.map((e) => e.name).sort(), ["other", "pdf-tools"]);
		assert.deepEqual(index.sources, ["o/r"]);
		assert.ok(index.errors.some((e) => e.includes("bad")));
		assert.deepEqual(index.sourceStats.find((s) => s.repo === "o/r"), { repo: "o/r", count: 2, added: 2, via: "zip" });
		assert.equal(index.sourceStats.length, 1, "非法写法只进 errors，不进产量统计");
	});
});

// ---------- 推荐服务 ----------

async function setup({ settings = {}, messages = [], llm = null, zip = null, sources = "o/r", http: httpOverride = null } = {}) {
	const root = await mkdtemp(join(tmpdir(), "si-rec-"));
	const skillsDir = join(root, ".pi", "skills");
	const globalDir = join(root, "global-skills");
	const base = createFakeHost(root);
	const host = {
		...base,
		dataDir: root,
		cwd: root,
		getSettings: () => ({ repos: sources, topN: 3, rerank: false, ...settings }),
		getActiveConversation: () => ({ title: "测试会话", messages }),
		...(llm ? { llm: { complete: llm } } : {}),
	};
	const http = httpOverride ?? fakeHttp(zip ?? REPO_ZIP);
	const ops = createOps(host);
	const getScopes = () => makeScopes(host, skillsDir, globalDir);
	const importService = createImportService({ host, http, ops, getScopes });
	const service = createRecommendService({ host, http, getScopes, importService });
	return { root, skillsDir, host, http, service, importService };
}

describe("推荐服务", () => {
	it("没有索引时先不拉仓库，返回 needsIndex", async () => {
		const { root, service } = await setup();
		try {
			const res = await service.recommend();
			assert.equal(res.needsIndex, true);
			assert.equal(res.indexCount, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("force 建索引后按对话推荐，并排除已装", async () => {
		const { root, skillsDir, service, importService } = await setup({
			messages: [{ role: "user", content: [{ type: "text", text: "帮我把 PDF 里的表格抽出来" }] }],
		});
		try {
			const first = await service.recommend({ force: true });
			assert.equal(first.indexCount, 2);
			assert.ok(first.items.length >= 1);
			assert.equal(first.items[0].name, "pdf-tools");

			// 装上之后不该再推荐
			const p = await importService.preview({ source: "o/r", path: "skills/demo" });
			assert.equal((await importService.install({ token: p.token, scopeId: "project" })).ok, true);
			service._reset();
			const second = await service.recommend({ force: true });
			assert.ok(!second.items.some((i) => i.name === "pdf-tools"));
			assert.ok(second.installedCount >= 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("LLM 重排：成功用模型结果，失败回落规则", async () => {
		const good = await setup({
			settings: { rerank: true },
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
			llm: async ({ prompt }) => {
				// 精排 prompt 的候选行是 "1. <name>: <desc> | ..."
				const m = /1\. ([^:\n]+):/.exec(prompt);
				return { ok: true, text: JSON.stringify({ picks: [{ name: m?.[1]?.trim() ?? "pdf-tools", reason: "模型觉得合适" }] }) };
			},
		});
		try {
			const res = await good.service.recommend({ force: true });
			assert.equal(res.usedLLM, true);
			assert.equal(res.items.length, 1);
			assert.equal(res.items[0].reason, "模型觉得合适");
		} finally {
			await rm(good.root, { recursive: true, force: true });
		}

		const bad = await setup({
			settings: { rerank: true },
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
			llm: async () => ({ ok: false, error: "model down" }),
		});
		try {
			const res = await bad.service.recommend({ force: true });
			assert.equal(res.usedLLM, false);
			assert.match(res.llmError, /model down/);
			assert.ok(res.items.length >= 1, "应该回落到规则结果");
		} finally {
			await rm(bad.root, { recursive: true, force: true });
		}
	});

	it("模型明确说没有合适的 → 不回落规则结果", async () => {
		const { root, service } = await setup({
			settings: { rerank: true },
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
			llm: async () => ({ ok: true, text: '{"picks":[]}' }),
		});
		try {
			const res = await service.recommend({ force: true });
			assert.equal(res.usedLLM, true);
			assert.equal(res.llmSaysNone, true);
			assert.deepEqual(res.items, [], "明确没有就不该硬凑");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("已装命中会单独返回（提示直接用）", async () => {
		const { root, service, importService } = await setup({
			settings: { rerank: true },
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
			llm: async () => ({ ok: true, text: '{"picks":[]}' }),
		});
		try {
			const p = await importService.preview({ source: "o/r", path: "skills/demo" });
			await importService.install({ token: p.token, scopeId: "project" });
			const res = await service.recommend({ force: true });
			assert.ok(res.installedHits.some((h) => h.name === "pdf-tools"));
			assert.deepEqual(res.items, []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("一键安装走同一套 preview/install（含冲突检查）", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			await service.recommend({ force: true });
			const res = await service.installRecommended({ name: "pdf-tools", scopeId: "project" });
			assert.equal(res.ok, true, res.error);
			assert.match(await readFile(join(skillsDir, "pdf-tools", "SKILL.md"), "utf8"), /pdf-tools/);
			// 装完要能被页面标成「等待重新加载」
			assert.deepEqual(res.reload.names, ["pdf-tools"]);

			const again = await service.installRecommended({ name: "pdf-tools", scopeId: "project" });
			assert.equal(again.ok, false);
			assert.equal(again.code, "conflict");

			const missing = await service.installRecommended({ name: "nope", scopeId: "project" });
			assert.equal(missing.ok, false);
			assert.match(missing.error, /索引里没有/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("短回复沿用最近一次明确任务，PPO 不会丢", async () => {
		const { root, service } = await setup({
			messages: [
				{ role: "user", text: "帮我排查 PPO 训练 reward 突然下降的原因" },
				{ role: "assistant", text: "先看 reward 曲线" },
				{ role: "user", text: "这个呢" },
				{ role: "user", text: "好的" },
				{ role: "user", text: "继续" },
			],
		});
		try {
			const res = await service.recommend({ force: true });
			assert.match(res.task.text, /PPO/);
			assert.equal(res.task.mode, "inherited");
			assert.ok(res.task.keywords.includes("ppo"), `关键词：${res.task.keywords.join(",")}`);
			assert.ok(!res.task.keywords.includes("继续"), "承接语不该污染查询");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("页面改过的需求优先于当前对话，并标记 edited", async () => {
		const { root, service } = await setup({
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
		});
		try {
			const res = await service.recommend({ force: true, q: "写一条 conventional commit" });
			assert.equal(res.task.edited, true);
			assert.match(res.task.text, /conventional commit/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("已装命中区分 已启用 / 已停用 / 等待重新加载", async () => {
		const { root, service, importService } = await setup({
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
		});
		try {
			const p = await importService.preview({ source: "o/r", path: "skills/demo" });
			await importService.install({ token: p.token, scopeId: "project" });
			service.noteChange({ name: "pdf-tools", kind: "install" });

			const reloading = await service.recommend({ force: true });
			assert.equal(reloading.installedHits[0].status, "reloading");
			assert.match(reloading.installedHits[0].note, /等待重新加载/);
			assert.deepEqual(reloading.reload.names, ["pdf-tools"]);

			// 点「已重新加载」后变成已启用
			service.ackReload();
			const enabled = await service.recommend();
			assert.equal(enabled.installedHits[0].status, "enabled");
			assert.equal(enabled.installedHits[0].scopeId, "project");
			assert.match(enabled.installedHits[0].note, /已启用/);

			// 停用后不能再告诉用户「已装可直接用」
			await importService.setEnabled({ name: "pdf-tools", scopeId: "project", enabled: false });
			const disabled = await service.recommend();
			assert.equal(disabled.installedHits[0].status, "disabled");
			assert.match(disabled.installedHits[0].note, /停用/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("精排输入带上已装能力摘要与候选的限制/依赖", async () => {
		const prompts = [];
		const { root, service, importService } = await setup({
			settings: { rerank: true },
			zip: RICH_ZIP,
			messages: [{ role: "user", text: "PPO 训练 reward 突然下降，帮我看训练日志" }],
			llm: async ({ prompt }) => {
				prompts.push(prompt);
				return { ok: true, text: '{"picks":[]}' };
			},
		});
		try {
			const p = await importService.preview({ source: "o/r", path: "skills/paper" });
			assert.equal(p.ok, true, p.error);
			await importService.install({ token: p.token, scopeId: "project" });

			await service.recommend({ force: true });
			const rerankPrompt = prompts.find((x) => x.includes("候选技能"));
			assert.ok(rerankPrompt, "应该调过精排");
			// 已装技能：不只名字，要有能力、启用状态、限制、依赖（且依赖不可验证时如实标注）
			assert.match(rerankPrompt, /pdf-tools（磁盘已启用，加载未验证）/);
			assert.match(rerankPrompt, /任务: /);
			// 候选：限制与依赖不能被截掉
			assert.match(rerankPrompt, /不支持多机训练/);
			assert.match(rerankPrompt, /tensorboard/);
			assert.match(rerankPrompt, /输入输出: /);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("过期或旧 schema 索引也不会让重新推荐隐式联网", async () => {
		const { root, service, host, http } = await setup({ messages: [{ role: "user", text: "读取 PDF 表格" }] });
		try {
			await service.recommend({ force: true });
			const old = host.storage.get("catalog");
			host.storage.set("catalog", { ...old, at: 1, schema: 2 });
			service._reset();
			http.get = async () => { throw new Error("不应请求网络"); };
			const result = await service.recommend();
			assert.equal(result.items[0].name, "pdf-tools");
			assert.equal(result.indexNeedsUpdate, true);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("旧 schema 遇到 GitHub 限流时无损迁移，不丢原来的源条目", async () => {
		const { root, service, host, http } = await setup();
		try {
			const entry = { name: "pdf-tools", repo: "o/r", path: "skills/pdf", ref: "", description: "提取 PDF 表格" };
			host.storage.set("catalog", { schema: 2, at: 1, sources: ["o/r"], entries: [entry], perSource: { "o/r": { entries: [entry], metaAt: 0 } } });
			http.get = async () => ({ ok: false, error: "HTTP 403 rate limit exceeded" });
			const index = await service.ensureIndex({ force: true });
			assert.equal(index.schema, 3);
			assert.equal(index.entries.length, 1);
			assert.equal(index.entries[0].id, "o/r@HEAD:skills/pdf");
			assert.match(index.errors.join(" "), /rate limit/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("待重载清单按项目和对话隔离，确认 B 不会清掉 A", async () => {
		const { root, service, host } = await setup();
		try {
			let id = "a";
			host.getActiveConversation = () => ({ conversationId: id, messages: [] });
			host.cwd = `${root}/a`;
			service.noteChange({ name: "pdf", scopeId: "project" });
			id = "b"; host.cwd = `${root}/b`;
			assert.deepEqual(service.pending().names, []);
			service.noteChange({ name: "plot", scopeId: "project" });
			assert.deepEqual(service.ackReload().cleared, ["plot"]);
			id = "a"; host.cwd = `${root}/a`;
			assert.deepEqual(service.pending().names, ["pdf"]);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("已装能力读本机文档；不可读时不会借网上同名技能补全", async () => {
		const prompts = [];
		const { root, service, importService, host } = await setup({
			settings: { rerank: true }, zip: RICH_ZIP,
			messages: [{ role: "user", text: "PPO 训练 reward 下降，分析训练日志" }],
			llm: async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: '{"picks":[]}' }; },
		});
		try {
			const preview = await importService.preview({ source: "o/r", path: "skills/paper" });
			await importService.install({ token: preview.token, scopeId: "project" });
			const path = join(root, ".pi/skills/pdf-tools/SKILL.md");
			await writeFile(path, "---\nname: pdf-tools\ndescription: 分析 PPO 训练日志的本机版本\n---\n- 不支持远程日志\npip install local-only-package\n");
			service.noteChange({ name: "pdf-tools", scopeId: "project" });
			await service.recommend({ force: true });
			const line = prompts.findLast((p) => p.includes("候选技能")).split("\n").find((l) => l.startsWith("- pdf-tools"));
			assert.match(line, /等待重载/);
			assert.match(line, /本机版本/);
			assert.match(line, /不支持远程日志/);
			assert.match(line, /local-only-package\(未验证\)/);
			const read = host.fs.readTextPath;
			host.fs.readTextPath = async (file) => { if (file === path) throw new Error("denied"); return read(file); };
			await service.recommend();
			const unknown = prompts.findLast((p) => p.includes("候选技能")).split("\n").find((l) => l.startsWith("- pdf-tools"));
			assert.match(unknown, /任务: 未声明/);
			assert.ok(!unknown.includes("从 PDF 提取"));
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("同名技能来自两个仓库：都进索引，展示时归组变体，可按 id 装指定版本", async () => {
		const zipA = buildZip([
			{ name: "a-main/skills/dup/SKILL.md", data: "---\nname: dup\ndescription: 从 PDF 抽表格的 A 版本\n---\n" },
		]);
		const zipB = buildZip([
			{ name: "b-main/skills/dup/SKILL.md", data: "---\nname: dup\ndescription: 从 PDF 抽表格的 B 版本\n---\n" },
		]);
		const http = {
			get: async (url) => {
				if (url.includes("api.github.com")) {
					return { ok: true, buffer: Buffer.from(JSON.stringify({ pushed_at: "t1" })) };
				}
				return { ok: true, buffer: url.includes("o/b") ? zipB : zipA };
			},
		};
		const { root, service, host } = await setup({
			settings: { rerank: false },
			sources: "o/a, o/b",
			http,
			messages: [{ role: "user", text: "把 PDF 表格抽出来" }],
		});
		try {
			const index = await service.ensureIndex({ force: true });
			assert.equal(index.entries.filter((e) => e.name === "dup").length, 2, "同名不同仓库都要留在索引里");

			const res = await service.recommend();
			const dup = res.items.find((i) => i.name === "dup");
			assert.ok(dup, "应该有 dup 候选");
			assert.equal(dup.variants.length, 1, "另一仓库的版本应作为变体出现");
			assert.equal(dup.variants[0].repo, "o/b");

			// 用 id 指定就装 B 仓库那份
			const variant = dup.variants[0];
			const installed = await service.installRecommended({ id: variant.id, name: "dup", scopeId: "project" });
			assert.equal(installed.ok, true, installed.error);
			assert.match(await readFile(join(host.root, ".pi", "skills", "dup", "SKILL.md"), "utf8"), /B 版本/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------- 多源：发现 / 增删 / 市场缓存 ----------

describe("多源管理", () => {
	it("GitHub 搜索结果去重并按 star 排序", async () => {
		const http = {
			get: async (url) => {
				const page = url.includes("claude-skills")
					? { items: [{ full_name: "b/two", stargazers_count: 5, description: "two skills" }] }
					: { items: [
							{ full_name: "a/one", stargazers_count: 100, description: "big skill collection" },
							{ full_name: "b/two", stargazers_count: 5, description: "two skills" },
							{ full_name: "spam/repo", stargazers_count: 999999, description: "unrelated" },
						] };
				return { ok: true, status: 200, buffer: Buffer.from(JSON.stringify(page)), url };
			},
		};
		const list = await discoverSources({ http });
		assert.deepEqual(list.map((c) => c.repo), ["a/one", "b/two"]);
		assert.equal(list[0].stars, 100);
	});

	it("市场缓存里的仓库能被收集（无权限时静默跳过）", async () => {
		const root = await mkdtemp(join(tmpdir(), "si-cache-"));
		try {
			await mkdir(join(root, "market-cache"), { recursive: true });
			await writeFile(
				join(root, "market-cache", "skill-market-a_b.json"),
				JSON.stringify({ data: [{ repo: "a/b" }, { repo: "c/d" }] }),
			);
			const host = { dataDir: root, fs: { listPath: async () => (await import("node:fs/promises")).readdir(join(root, "market-cache")).then((ns) => ns.map((n) => ({ name: n, type: "file" }))), readTextPath: async (p) => readFile(p, "utf8") } };
			const repos = await readMarketCacheRepos({ host, requestAccess: async () => true, asked: { done: false } });
			assert.deepEqual(repos, ["a/b", "c/d"]);

			const denied = await readMarketCacheRepos({ host, requestAccess: async () => false, asked: { done: false } });
			assert.deepEqual(denied, []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("加入/移除源，并统计每个源的产量", async () => {
		const { root, service, host } = await setup();
		try {
			await service.recommend({ force: true });
			let listed = await service.listSources();
			assert.deepEqual(listed.configured, ["o/r"]);
			assert.equal(listed.effective[0].count, 2);

			const added = await service.addSource({ repo: "x/y", rebuild: false });
			assert.equal(added.ok, true);
			assert.deepEqual(host.storage.get("sources"), ["o/r", "x/y"]);

			listed = await service.listSources();
			assert.ok(listed.effective.some((s) => s.repo === "x/y"));

			await service.removeSource({ repo: "x/y" });
			listed = await service.listSources();
			assert.ok(!listed.effective.some((s) => s.repo === "x/y"));

			const bad = await service.addSource({ repo: "nope", rebuild: false });
			assert.equal(bad.ok, false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("已安装技能的来源仓库会自动进入有效源", async () => {
		const { root, service, importService } = await setup();
		try {
			await service.recommend({ force: true });
			const p = await importService.preview({ source: "o/r", path: "skills/demo" });
			await importService.install({ token: p.token, scopeId: "project" });
			const listed = await service.listSources();
			assert.ok(listed.effective.some((s) => s.repo === "o/r"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------- 反馈：忽略 / 钉住 ----------

describe("忽略与钉住", () => {
	it("忽略后不再推荐，恢复后回来", async () => {
		const { root, service } = await setup({
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
		});
		try {
			const first = await service.recommend({ force: true });
			assert.equal(first.items[0].name, "pdf-tools");

			const ig = service.setFeedback({ action: "ignore", name: "pdf-tools" });
			assert.equal(ig.ok, true);
			assert.deepEqual(ig.feedback.ignored, ["pdf-tools"]);

			const second = await service.recommend();
			assert.ok(!second.items.some((i) => i.name === "pdf-tools"));

			const un = service.setFeedback({ action: "unignore", name: "pdf-tools" });
			assert.equal(un.ok, true);
			const third = await service.recommend();
			assert.ok(third.items.some((i) => i.name === "pdf-tools"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("钉住是独立收藏区，不占任务推荐名额，且与忽略互斥", async () => {
		const { root, service, host } = await setup({
			settings: { topN: 1 },
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
		});
		try {
			await service.recommend({ force: true });
			const pin = service.setFeedback({ op: "pin", name: "other" });
			assert.equal(pin.ok, true, "客户端传 op 也要能认");

			const res = await service.recommend();
			// 钉住的另一条进独立收藏区，任务推荐照旧给 pdf-tools
			assert.deepEqual(res.pinned.map((p) => p.name), ["other"]);
			assert.equal(res.pinned[0].pinned, true);
			assert.equal(res.items[0].name, "pdf-tools", "钉住的不该把推荐挤掉");
			assert.ok(!res.items.some((i) => i.name === "other"));
			assert.deepEqual(res.feedback.pinned, ["other"]);

			// 钉住应清掉同名的忽略标记，反之亦然
			service.setFeedback({ action: "ignore", name: "other" });
			assert.deepEqual(JSON.parse(JSON.stringify(host.storage.get("feedback"))).pinned, {});
			const after = await service.recommend();
			assert.ok(!after.pinned.some((p) => p.name === "other"));
			assert.ok(!after.items.some((i) => i.name === "other"));

			service.setFeedback({ action: "pin", name: "other" });
			service.setFeedback({ action: "unpin", name: "other" });
			assert.deepEqual((await service.recommend()).pinned, []);

			const bad = service.setFeedback({ action: "explode", name: "x" });
			assert.equal(bad.ok, false);
			assert.match(bad.error, /未知操作/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("钉三条也不会把推荐占满（收藏与推荐分开口径）", async () => {
		const { root, service } = await setup({
			settings: { topN: 3 },
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
		});
		try {
			await service.recommend({ force: true });
			for (const name of ["other", "pdf-tools"]) service.setFeedback({ op: "pin", name });
			const res = await service.recommend();
			assert.ok(res.pinned.length >= 1);
			// pdf-tools 已钉住仍在 pinned，items 里只剩真正可装的其它候选（这里没有）
			assert.ok(!res.items.some((i) => i.name === "pdf-tools"), "已钉住的不再重复进 items");
			assert.ok(res.items.length <= 3);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("反馈持久化在 storage 里，最多 200 条", async () => {
		const { root, service, host } = await setup();
		try {
			for (let i = 0; i < 205; i++) service.setFeedback({ action: "ignore", name: `s${i}` });
			const stored = host.storage.get("feedback");
			assert.equal(Object.keys(stored.ignored).length, 200);
			assert.ok(!("s0" in stored.ignored), "最老的应被裁掉");
			assert.ok("s204" in stored.ignored);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
