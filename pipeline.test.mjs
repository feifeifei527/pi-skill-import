import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { buildCard, extractTasks, extractLimits, extractDeps, extractIo, cardLine, installedLine, dependencyStatus, ecosystemsFromSignals } = require("./core/card.cjs");
const { buildTask, mergeExpansion, isLowInformation } = require("./core/task.cjs");
const { buildBm25Index, bm25Search } = require("./core/bm25.cjs");
const { rrf, dedupe, normalizeName } = require("./core/rrf.cjs");
const { parsePicks, tokenize } = require("./core/recommend.cjs");
const { coverageOk, directionCompatible } = require("./core/coverage.cjs");

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
		assert.ok(line.length <= 380);
	});

	it("cardLine 不能把限制与依赖截掉（即使描述很长）", () => {
		const card = buildCard({
			name: "train-debug",
			description: `诊断训练不稳定。${'很长的描述。'.repeat(40)}`,
			body: ["- 不支持多机训练", "- 仅支持 PyTorch", "pip install tensorboard"].join("\n"),
			frontmatter: {},
		});
		const line = cardLine(card, 380);
		assert.match(line, /限制: 不支持多机训练/);
		assert.match(line, /依赖: tensorboard/);
		assert.ok(line.length <= 380);
	});

	it("已装摘要带启用状态、输入输出与依赖可用性", () => {
		const card = buildCard({
			name: "pdf-tools",
			description: "从 PDF 提取文本与表格",
			body: ["- 输入：PDF 文件。", "- 输出：Markdown。", "- 不支持扫描件", "pip install pypdf"].join("\n"),
			frontmatter: {},
		});
		const ecosystems = ecosystemsFromSignals({ "requirements.txt": "pypdf\n" });
		assert.deepEqual(ecosystems, ["python"]);
		assert.equal(card.depEcosystems.pypdf, "python", "pip install 出来的依赖应记成 python");
		const depStatus = dependencyStatus(card.deps, { ecosystems, hints: card.depEcosystems });
		assert.equal(depStatus[0].status, "unknown", "项目清单不是运行环境验证，不能推断包可用");
		assert.equal(depStatus[0].ecosystemDetected, true);
		const line = installedLine({ ...card, enabled: false, depStatus });
		assert.match(line, /pdf-tools（已停用）/);
		assert.match(line, /输入输出: /);
		assert.match(line, /依赖: pypdf\(未验证\)/);
		// 看不出生态的依赖不能断言不可用，只能「未验证」
		assert.equal(dependencyStatus(["ffmpeg"], { ecosystems })[0].status, "unknown");
		assert.equal(dependencyStatus(["ffmpeg"], { ecosystems })[0].dep, "ffmpeg");
	});
});

describe("同名来源身份", () => {
	it("相同 repo/path 不同 ref 也保留为独立变体", () => {
		const entries = ["main", "v2"].map((ref) => ({ id: `o/r@${ref}:skills/pdf`, name: "pdf", repo: "o/r", path: "skills/pdf", ref, description: "PDF 表格提取" }));
		const grouped = dedupe(entries);
		assert.equal(grouped.length, 1);
		assert.equal(grouped[0].variants.length, 1);
		assert.equal(grouped[0].variants[0].ref, "v2");
	});
});

describe("能力摘要边界", () => {
	it("所有字段都很长时，限制、依赖、IO 和状态仍有预算", () => {
		const card = {
			name: "long-card", description: "描述".repeat(200), tasks: ["任务".repeat(200)],
			io: { input: ["PDF 文件".repeat(50)], output: ["Markdown 表格".repeat(50)] },
			limits: ["不支持 OCR " + "限制".repeat(100)], deps: ["pypdf", "tensorboard"],
		};
		for (const line of [cardLine(card, 380), installedLine({ ...card, enabled: true, status: "reloading" }, 380)]) {
			assert.ok(line.length <= 380);
			for (const text of ["限制: 不支持 OCR", "依赖: pypdf", "输入输出: 输入 PDF", "任务: ", "描述: "]) assert.ok(line.includes(text), line);
		}
		assert.match(installedLine({ ...card, enabled: true, status: "reloading" }), /等待重载/);
		assert.equal(dependencyStatus(["not-installed"], { ecosystems: ["python"], hints: { "not-installed": "python" } })[0].status, "unknown");
	});

	it("原文依据确实来自描述或正文，不把规则推断当已验证能力", () => {
		const description = "从 PDF 提取表格";
		const body = "输入：PDF\n输出：CSV\n- 不支持 OCR\n运行 pip install pypdf";
		const card = buildCard({ name: "pdf", description, body });
		assert.ok(card.evidence.length >= 4);
		for (const evidence of card.evidence) assert.ok((evidence.section === "body" ? body : description).includes(evidence.quote));
	});

	it("能导出 PDF 不等于能读取 PDF；生成输出和未知 IO 不误杀", () => {
		const plot = { io: { input: ["数据"], output: ["PDF", "PNG"] } };
		assert.equal(directionCompatible(plot, "把 PDF 里的表格抽出来"), false);
		assert.equal(directionCompatible(plot, "Extract tables from PDF"), false);
		assert.equal(directionCompatible(plot, "读取数据，导出 PDF"), true);
		assert.equal(directionCompatible(plot, "画图并导出 PDF"), true);
		assert.equal(directionCompatible({ io: { input: ["PDF"], output: ["CSV"] } }, "读取 PDF 表格"), true);
		assert.equal(directionCompatible({}, "读取 PDF 表格"), true);
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

	it("短回复沿用最近一次明确任务（PPO 不丢）", () => {
		const task = buildTask({
			messages: [
				{ role: "user", text: "帮我排查 PPO 训练 reward 突然下降的原因" },
				{ role: "assistant", text: "先看 reward 曲线" },
				{ role: "user", text: "这个呢" },
				{ role: "user", text: "好的" },
				{ role: "user", text: "继续" },
			],
		});
		assert.match(task.task, /PPO/);
		assert.equal(task.mode, "inherited");
		assert.equal(task.inherited, true);
		assert.ok(task.keywords.includes("ppo"));
		assert.ok(!task.keywords.includes("继续"), "承接语不该进关键词");
	});

	it("连续很多承接语后仍保留任务，切换任务不夹带旧主题", () => {
		const task = buildTask({ messages: [{ role: "user", text: "PPO reward 突然下降，排查训练日志" }, ...Array.from({ length: 20 }, () => ({ role: "user", text: "继续" }))] });
		assert.ok(task.keywords.includes("ppo"));
		const switched = buildTask({ messages: [{ role: "user", text: "PPO reward 突然下降，排查训练日志" }, { role: "user", text: "生成一份周报 PPT" }] });
		assert.ok(switched.keywords.includes("ppt"));
		assert.ok(!switched.keywords.includes("ppo"));
	});

	it("全是承接语时不报错，退回最后一条", () => {
		const task = buildTask({ messages: [{ role: "user", text: "继续" }] });
		assert.equal(task.mode, "none");
		assert.equal(task.task, "继续");
		assert.equal(buildTask({ messages: [] }).hasSignal, false);
	});

	it("isLowInformation 分辨承接语与真需求", () => {
		for (const t of ["继续", "好的", "这个呢", "OK", "thanks", "嗯嗯"]) assert.equal(isLowInformation(t), true, t);
		for (const t of ["帮我排查 PPO 的训练问题", "pdf 表格", "下一步做什么", "RL 调参"]) assert.equal(isLowInformation(t), false, t);
	});

	it("两字母技术缩写不被丢掉（RL / KL / IK）", () => {
		const tokens = tokenize("PPO 训练时 KL 散度爆炸，RL 那边 IK 也不收敛");
		for (const t of ["ppo", "kl", "rl", "ik"]) assert.ok(tokens.includes(t), `${t} 应保留：${tokens.join(",")}`);
		// 白名单外的小词不加
		assert.ok(!tokenize("用 xx 试试").includes("xx"));
	});
});

describe("候选覆盖率门槛", () => {
	it("短查询撞上一个词就算相关", () => {
		assert.equal(coverageOk(1, 4), true);
		assert.equal(coverageOk(1, 2), true);
	});

	it("长查询只撞上一个通用词不算（中文二元组的最大坑）", () => {
		// 「把这个 PDF 里的表格抽出来」→ 10 来个词，xlsx 只命中「表格」
		assert.equal(coverageOk(1, 10), false);
		assert.equal(coverageOk(2, 10), true);
		assert.equal(coverageOk(1, 5), true, "5 个词时 1 个命中还有 20%");
	});

	it("一个都没命中 / 覆盖率为 0 → 不算候选", () => {
		assert.equal(coverageOk(0, 3), false);
		assert.equal(coverageOk(1, 40), false);
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

	it("RRF 按 id 区分同名技能（不同仓库不互相覆盖）", () => {
		const list = [
			{ name: "dup", id: "o/a@HEAD:skills/dup" },
			{ name: "dup", id: "o/b@HEAD:skills/dup" },
		];
		const merged = rrf([list], { limit: 5 });
		assert.equal(merged.length, 2, "同名但 id 不同应各占一条");
		assert.deepEqual(merged.map((m) => m.name), ["dup", "dup"]);
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

	it("被折叠的同名版本记进 variants，展示时可以列出来源", () => {
		const items = [
			{ id: "o/a@HEAD:skills/dup", name: "dup", repo: "o/a", path: "skills/dup", ref: "", description: "从 PDF 抽表格 A" },
			{ id: "o/b@HEAD:skills/dup", name: "dup", repo: "o/b", path: "skills/dup", ref: "", description: "从 PDF 抽表格 B" },
		];
		const out = dedupe(items);
		assert.equal(out.length, 1);
		assert.equal(out[0].repo, "o/a");
		assert.deepEqual(out[0].variants.map((v) => v.repo), ["o/b"]);
		assert.equal(out[0].variants[0].id, "o/b@HEAD:skills/dup");
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
