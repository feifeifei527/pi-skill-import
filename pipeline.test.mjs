import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { buildCard, extractTasks, extractLimits, extractDeps, extractIo, cardLine } = require("./core/card.cjs");
const { buildTask, mergeExpansion } = require("./core/task.cjs");
const { buildBm25Index, bm25Search } = require("./core/bm25.cjs");
const { rrf, dedupe, normalizeName } = require("./core/rrf.cjs");
const { parsePicks } = require("./core/recommend.cjs");

describe("能力卡片", () => {
	it("从描述和正文抽任务 / 场景 / IO / 限制 / 依赖", () => {
		const card = buildCard({
			name: "train-debug",
			description:
				"诊断强化学习训练不稳定。Use this skill when reward suddenly drops. 输入：训练日志目录。输出：诊断报告。",
			body: [
				"## 使用",
				"- 不支持多机训练",
				"运行前执行 `pip install tensorboard`",
				"",
				"## Note",
				"limitations: 只支持 PyTorch",
			].join("\n"),
			frontmatter: { license: "MIT", compatibility: "Python >= 3.10" },
			repo: "o/r",
			path: "skills/train-debug",
			ref: "main",
		});

		assert.equal(card.name, "train-debug");
		assert.ok(card.tasks.length > 0, "应该抽出任务句");
		assert.ok(card.tasks.some((t) => /诊断|分析|读取/.test(t)));
		assert.ok(card.scenarios.some((s) => /reward/i.test(s)));
		assert.deepEqual(card.io.input, ["训练日志目录"]);
		assert.deepEqual(card.io.output, ["诊断报告"]);
		assert.ok(card.limits.some((l) => /多机/.test(l)));
		assert.ok(card.deps.some((d) => /tensorboard/.test(d)));
		assert.ok(card.deps.some((d) => /compat:/.test(d)));
		assert.equal(card.license, "MIT");
		assert.deepEqual(card.source, { repo: "o/r", path: "skills/train-debug", ref: "main" });
	});

	it("没提到的东西标 unknown，不编造", () => {
		const card = buildCard({ name: "x", description: "A tool. Use when needed.", body: "", frontmatter: {} });
		assert.ok(card.unknown.includes("io"));
		assert.ok(card.unknown.includes("limits"));
		assert.ok(card.unknown.includes("deps"));
		assert.ok(!card.io.input.length);
	});

	it("cardLine 压缩成一行给模型看", () => {
		const card = buildCard({
			name: "pdf",
			description: "Extract tables from PDF",
			body: "pip install pypdf",
			frontmatter: {},
		});
		const line = cardLine(card);
		assert.match(line, /^pdf: /);
		assert.ok(line.length <= 220);
	});
});

describe("任务理解", () => {
	it("从最近用户消息抽任务与想要的能力，助手消息不主导", () => {
		const task = buildTask({
			messages: [
				{ role: "user", text: "我想看看 PPO 为什么训练到后面突然崩了" },
				{ role: "assistant", text: "先检查 reward 曲线" },
				{ role: "user", text: "帮我把训练日志分析一下，顺便比较两组实验" },
			],
			project: { files: { "requirements.txt": "torch 2.4 gymnasium 1.0" } },
		});
		assert.match(task.task, /训练日志|比较/);
		assert.ok(task.capabilities.some((c) => /分析|比较/.test(c)));
		assert.ok(task.keywords.includes("ppo"));
		assert.ok(task.hasSignal);
	});

	it("扩展词去重并限量", () => {
		const out = mergeExpansion(["ppo", "reward"], ["PPO", "kl", "训练日志"], 4);
		assert.deepEqual(out, ["ppo", "reward", "kl", "训练日志"]);
	});
});

describe("BM25", () => {
	const cards = [
		{ name: "pdf-tables", description: "extract tables from pdf", tasks: ["extract tables from pdf"] },
		{ name: "matplotlib-plots", description: "scientific plots with matplotlib", tasks: ["plot scientific figures"] },
		{ name: "git-commit", description: "write conventional commits", tasks: ["write commit messages"] },
	];
	const index = buildBm25Index(cards);

	it("相关文档排前，字段权重让名字命中更靠前", () => {
		const hits = bm25Search(index, ["pdf", "tables"], { limit: 3 });
		assert.equal(hits[0].card.name, "pdf-tables");
		assert.ok(hits[0].score > 0);
	});

	it("没命中返回空", () => {
		assert.deepEqual(bm25Search(index, ["quantum", "robot"], { limit: 3 }), []);
	});

	it("名字权重可调", () => {
		const nameHeavy = buildBm25Index(cards, { name: 10 });
		const a = bm25Search(nameHeavy, ["git"], { limit: 1 });
		assert.equal(a[0].card.name, "git-commit");
	});
});

describe("RRF 与去重", () => {
	it("RRF 用名次合并两路，缺一路也能工作", () => {
		const listA = [{ name: "a" }, { name: "b" }, { name: "c" }];
		const listB = [{ name: "b" }, { name: "d" }];
		const merged = rrf([listA, listB], { limit: 3 });
		assert.equal(merged[0].name, "b", "两路都出现的排最前");
		assert.equal(merged[0].ranks.length, 2);
		assert.ok(merged.some((m) => m.name === "a"));
		assert.equal(rrf([listA], { limit: 2 }).length, 2);
	});

	it("同名（含前缀/后缀变体）与高相似描述被合并", () => {
		const items = [
			{ name: "superpowers-writing-skills", repo: "o/r", description: "create and edit agent skills" },
			{ name: "writing-skills", repo: "o/r", description: "create and edit agent skills" },
			{ name: "pdf-tools", repo: "o/r", description: "extract tables from pdf files" },
		];
		const out = dedupe(items);
		assert.deepEqual(out.map((x) => x.name), ["superpowers-writing-skills", "pdf-tools"]);
		assert.equal(normalizeName("k-dense-pdf-tools"), "pdf", "前缀与工具后缀都会被剥掉");
	});
});

describe("精排结果解析", () => {
	const cands = [{ name: "a" }, { name: "b" }];
	it("接受 picks 对象 / 裸数组 / 空 picks", () => {
		assert.deepEqual(parsePicks('{"picks":[{"name":"a","reason":"r","added_capability":"c"}]}', cands).map((x) => x.name), ["a"]);
		assert.deepEqual(parsePicks('[{"name":"b"}]', cands).map((x) => x.name), ["b"]);
		assert.deepEqual(parsePicks('{"picks":[]}', cands), []);
	});
	it("非法 JSON / 候选外名字 → null", () => {
		assert.equal(parsePicks("nope", cands), null);
		assert.equal(parsePicks('{"picks":[{"name":"zzz"}]}', cands), null);
	});
});
