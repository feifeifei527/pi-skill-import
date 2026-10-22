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

	it("从文件树里提取 name/description，跳过重复与无描述", () => {
		const files = packFrom({
			"skills/a/SKILL.md": "---\nname: a\ndescription: A 技能，当需要 a 时使用。\n---\n",
			"skills/b/SKILL.md": "---\nname: a\ndescription: 重名，应该被跳过。\n---\n",
			"skills/c/SKILL.md": "---\nname: c\n---\n",
			"README.md": "# x",
		});
		const entries = entriesFromTree(files, "o/r", "main");
		assert.deepEqual(entries.map((e) => e.name), ["a"]);
		assert.equal(entries[0].path, "skills/a");
		assert.equal(entries[0].ref, "main");
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

async function setup({ settings = {}, messages = [], llm = null } = {}) {
	const root = await mkdtemp(join(tmpdir(), "si-rec-"));
	const skillsDir = join(root, ".pi", "skills");
	const globalDir = join(root, "global-skills");
	const base = createFakeHost(root);
	const host = {
		...base,
		dataDir: root,
		getSettings: () => ({ repos: "o/r", topN: 3, rerank: false, ...settings }),
		getActiveConversation: () => ({ title: "测试会话", messages }),
		...(llm ? { llm: { complete: llm } } : {}),
	};
	const http = fakeHttp(REPO_ZIP);
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

	it("钉住的排最前，且与忽略互斥", async () => {
		const { root, service, host } = await setup({
			messages: [{ role: "user", content: "帮我把 PDF 里的表格抽出来" }],
		});
		try {
			await service.recommend({ force: true });
			const pin = service.setFeedback({ action: "pin", name: "other" });
			assert.equal(pin.ok, true);

			const res = await service.recommend();
			assert.equal(res.items[0].name, "other");
			assert.equal(res.items[0].pinned, true);
			assert.deepEqual(res.feedback.pinned, ["other"]);

			// 钉住应清掉同名的忽略标记，反之亦然
			service.setFeedback({ action: "ignore", name: "other" });
			assert.deepEqual(JSON.parse(JSON.stringify(host.storage.get("feedback"))).pinned, {});
			const after = await service.recommend();
			assert.ok(!after.items.some((i) => i.name === "other"));

			const bad = service.setFeedback({ action: "explode", name: "x" });
			assert.equal(bad.ok, false);
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
