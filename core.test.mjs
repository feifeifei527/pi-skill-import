import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
	checkConflicts,
	describeConflict,
	extractReferences,
	inspectPack,
	installSkill,
	parseSource,
	parseYamlLite,
	rawCandidates,
	readZip,
	rollbackInstall,
	splitFrontmatter,
	stripCommonRoot,
	validateFrontmatter,
} = require("./core/index.cjs");
import { SKILL_MD, buildZip, packFrom } from "./test-helpers.mjs";

// ---------- frontmatter ----------

describe("frontmatter", () => {
	it("解析常见字段，保留未知键", () => {
		const fm = splitFrontmatter(SKILL_MD);
		assert.equal(fm.present, true);
		assert.equal(fm.error, null);
		assert.equal(fm.data.name, "pdf-tools");
		assert.match(fm.data.description, /PDF/);
		assert.match(fm.body, /# PDF tools/);
	});

	it("支持引号、布尔、数组、块标量、一层嵌套", () => {
		const data = parseYamlLite(
			[
				'name: "demo"',
				"disable-model-invocation: true",
				"allowed-tools: [bash, read]",
				"description: >",
				"  多行描述",
				"  折成一行",
				"metadata:",
				"  source: github",
				"  stars: 3",
				"tags:",
				"  - a",
				"  - b",
			].join("\n"),
		);
		assert.equal(data.name, "demo");
		assert.equal(data["disable-model-invocation"], true);
		assert.deepEqual(data["allowed-tools"], ["bash", "read"]);
		assert.equal(data.description, "多行描述 折成一行");
		assert.equal(data.metadata.source, "github");
		assert.deepEqual(data.tags, ["a", "b"]);
	});

	it("未闭合的 frontmatter 给明确错误", () => {
		const fm = splitFrontmatter("---\nname: x\ndescription: y\n");
		assert.equal(fm.present, true);
		assert.match(fm.error, /未闭合/);
	});

	it("校验：非法 name / 缺 description / 目录名不一致", () => {
		const issues = validateFrontmatter({ name: "Bad_Name", description: "短" }, { dirName: "other" });
		const codes = issues.map((i) => i.code);
		assert.ok(codes.includes("name-invalid"));
		assert.ok(codes.includes("description-too-short"));
		assert.ok(codes.includes("name-dir-mismatch"));

		const missing = validateFrontmatter({}, {});
		assert.ok(missing.some((i) => i.code === "name-missing" && i.level === "error"));
		assert.ok(missing.some((i) => i.code === "description-missing" && i.level === "error"));
	});

	it("校验：描述没有触发场景会被提示", () => {
		const issues = validateFrontmatter({
			name: "abc",
			description: "This is a very long description that has no trigger phrase at all ok",
		});
		assert.ok(issues.some((i) => i.code === "description-no-trigger"));
	});
});

// ---------- source ----------

describe("source 解析", () => {
	it("owner/repo 与 #ref", () => {
		const s = parseSource("anthropics/skills#main");
		assert.equal(s.ok, true);
		assert.equal(s.kind, "github");
		assert.equal(s.owner, "anthropics");
		assert.equal(s.repo, "skills");
		assert.equal(s.ref, "main");
	});

	it("GitHub tree / blob / raw / zip 形态", () => {
		const tree = parseSource("https://github.com/anthropics/skills/tree/main/skills/pdf-tools");
		assert.deepEqual([tree.kind, tree.owner, tree.repo, tree.ref, tree.path], [
			"github",
			"anthropics",
			"skills",
			"main",
			"skills/pdf-tools",
		]);

		const blob = parseSource("https://github.com/o/r/blob/dev/x/SKILL.md");
		assert.equal(blob.form, "blob");
		assert.equal(blob.ref, "dev");
		assert.equal(blob.path, "x/SKILL.md");

		const raw = parseSource("https://raw.githubusercontent.com/o/r/main/a/b/SKILL.md");
		assert.equal(raw.form, "raw");
		assert.equal(raw.ref, "main");
		assert.equal(raw.path, "a/b/SKILL.md");

		const codeload = parseSource("https://codeload.github.com/o/r/zip/refs/heads/main");
		assert.equal(codeload.kind, "url-zip");

		const archive = parseSource("https://github.com/o/r/archive/refs/heads/main.zip");
		assert.equal(archive.kind, "url-zip");
	});

	it("本地路径、ssh、显式前缀", () => {
		assert.equal(parseSource("~/skills/x").kind, "local");
		assert.equal(parseSource("../x").kind, "local");
		assert.equal(parseSource("file:/tmp/x").kind, "local");
		const ssh = parseSource("git@github.com:o/r.git");
		assert.equal(ssh.repo, "r");
		assert.equal(parseSource("text:---\nname: a\n").kind, "text");
		const npm = parseSource("npm:some-skill");
		assert.equal(npm.ok, false);
		assert.match(npm.error, /npm/);
	});

	it("ref 带斜杠时不猜切分，直接拼出唯一 raw 地址", () => {
		const s = parseSource("https://github.com/o/r/tree/feat/x/skills/demo");
		const cands = rawCandidates(s);
		assert.deepEqual(cands, ["https://raw.githubusercontent.com/o/r/feat/x/skills/demo/SKILL.md"]);

		const file = parseSource("https://raw.githubusercontent.com/o/r/main/a/b/SKILL.md");
		assert.deepEqual(rawCandidates(file), ["https://raw.githubusercontent.com/o/r/main/a/b/SKILL.md"]);

		assert.deepEqual(rawCandidates(parseSource("o/r")), [], "仓库形态要靠 API 探测");
	});
});

// ---------- zip ----------

describe("zip 读取", () => {
	it("store 与 deflate 都能读，目录项被忽略", () => {
		const zip = buildZip([
			{ name: "pkg/", data: "", method: 0 },
			{ name: "pkg/SKILL.md", data: SKILL_MD },
			{ name: "pkg/scripts/extract.sh", data: "#!/bin/sh\necho hi\n", method: 0 },
		]);
		const res = readZip(zip);
		assert.equal(res.ok, true, res.error);
		assert.deepEqual([...res.files.keys()], ["pkg/SKILL.md", "pkg/scripts/extract.sh"]);
		assert.match(res.files.get("pkg/SKILL.md").toString("utf8"), /pdf-tools/);
	});

	it("剥掉唯一的顶层目录", () => {
		const files = new Map([
			["repo-main/SKILL.md", Buffer.from("x")],
			["repo-main/a/b.txt", Buffer.from("y")],
		]);
		const stripped = stripCommonRoot(files);
		assert.deepEqual([...stripped.keys()], ["SKILL.md", "a/b.txt"]);
	});

	it("zip-slip 与 __MACOSX 被跳过", () => {
		const zip = buildZip([
			{ name: "../evil.sh", data: "x" },
			{ name: "__MACOSX/._x", data: "x" },
			{ name: "ok/SKILL.md", data: SKILL_MD },
		]);
		const res = readZip(zip);
		assert.equal(res.ok, true, res.error);
		assert.deepEqual([...res.files.keys()], ["ok/SKILL.md"]);
		assert.equal(res.skipped.length, 2);
	});

	it("坏 zip 给明确错误", () => {
		assert.equal(readZip(Buffer.from("not a zip at all")).ok, false);
	});
});

// ---------- inspect ----------

describe("inspect 鉴定技能包", () => {
	it("完整包通过：根目录、引用、可执行文件都认出来", () => {
		const files = packFrom({
			"SKILL.md": SKILL_MD,
			"references/formats.md": "# formats",
			"scripts/extract.sh": "#!/bin/sh\n",
		});
		const res = inspectPack({ files, label: "demo" });
		assert.equal(res.ok, true, JSON.stringify(res.issues));
		assert.equal(res.skill.name, "pdf-tools");
		assert.match(res.skill.description, /提取文本/);
		assert.equal(res.skill.totals.files, 3);
		assert.deepEqual(res.skill.references.sort(), ["references/formats.md", "scripts/extract.sh"]);
		assert.ok(res.issues.some((i) => i.code === "has-executables"));
		assert.ok(!res.issues.some((i) => i.code === "reference-missing"));
	});

	it("引用缺失 → warn，不拦安装", () => {
		const files = packFrom({ "SKILL.md": SKILL_MD });
		const res = inspectPack({ files });
		assert.equal(res.ok, true);
		const missing = res.issues.filter((i) => i.code === "reference-missing").map((i) => i.message);
		assert.equal(missing.length, 2);
	});

	it("引用缺失 → warn/ info 分开：链接是硬需求，码 span 里的只提示", () => {
		const files = packFrom({
			"SKILL.md": [
				"---",
				"name: demo",
				"description: 示例技能，当需要测试引用检查时使用。",
				"---",
				"读 `references/missing.md`，见 [模板](scripts/tpl.py)。",
				"输出到 `decision-doc.md`。",
			].join("\n"),
		});
		const res = inspectPack({ files });
		const warnings = res.issues.filter((i) => i.code === "reference-missing").map((i) => i.message);
		assert.equal(warnings.length, 2, JSON.stringify(res.issues));
		assert.ok(warnings.some((m) => m.includes("references/missing.md")));
		assert.ok(warnings.some((m) => m.includes("scripts/tpl.py")));
		const hints = res.issues.filter((i) => i.code === "reference-hint").map((i) => i.message);
		assert.equal(hints.length, 1);
		assert.match(hints[0], /decision-doc\.md/);
	});

	it("没有 SKILL.md / 多个 SKILL.md → 报错", () => {
		const none = inspectPack({ files: packFrom({ "README.md": "# hi" }) });
		assert.equal(none.ok, false);
		assert.equal(none.issues[0].code, "skill-md-missing");

		const multi = inspectPack({ files: packFrom({ "a/SKILL.md": SKILL_MD, "b/SKILL.md": SKILL_MD }) });
		assert.equal(multi.ok, false);
		assert.equal(multi.issues[0].code, "skill-md-ambiguous");
	});

	it("自动定位唯一的嵌套 SKILL.md", () => {
		const res = inspectPack({ files: packFrom({ "skills/pdf-tools/SKILL.md": SKILL_MD }) });
		assert.equal(res.ok, true);
		assert.equal(res.skill.root, "skills/pdf-tools");
		assert.equal(res.skill.dirName, "pdf-tools");
	});

	it("体积超限 → error（limits 可调）", () => {
		const files = packFrom({ "SKILL.md": SKILL_MD, "big.bin": "x".repeat(2048) });
		const res = inspectPack({ files, limits: { maxBytes: 1024 } });
		assert.equal(res.ok, false);
		assert.ok(res.issues.some((i) => i.code === "pack-too-large"));
	});
});

// ---------- 引用抽取的误报防护（真实技能里踩过的） ----------

describe("引用抽取不误报", () => {
	it("不把 subscript/superscript 这类合成词当路径", () => {
		const refs = extractReferences("Never use Unicode subscript/superscript characters.");
		assert.deepEqual(refs, []);
	});

	it("URL 里的路径不算技能文件", () => {
		const refs = extractReferences("see https://ui.shadcn.com/docs/components for more");
		assert.deepEqual(refs, []);
	});

	it("域名开头的链接文字不算（academy.x/assets/...）", () => {
		const refs = extractReferences("[academy.claude.com/assets/data/catalog.json](https://academy.claude.com/assets/data/catalog.json)");
		assert.deepEqual(refs, []);
	});

	it("真实的反向引用仍然能抽出来", () => {
		const refs = extractReferences("先读 `references/formats.md`，输出到 `decision-doc.md`。");
		assert.deepEqual(refs.map((r) => r.ref).sort(), ["decision-doc.md", "references/formats.md"]);
	});
});

// ---------- conflicts ----------

describe("冲突检测", () => {
	it("同名分布在两个作用域时指出谁生效", () => {
		const c = checkConflicts({
			name: "pdf-tools",
			scopes: [
				{ id: "global", label: "全局", path: "/g/skills", skills: ["pdf-tools"] },
				{ id: "project", label: "项目", path: "/p/.pi/skills", skills: ["pdf-tools"], writable: true },
			],
		});
		assert.equal(c.found.length, 2);
		assert.equal(c.winner.scopeId, "global");
		assert.deepEqual(c.shadowed.map((s) => s.scopeId), ["project"]);
		assert.match(describeConflict(c, "project"), /覆盖/);
	});

	it("单文件技能也算存在", () => {
		const c = checkConflicts({
			name: "quick",
			scopes: [{ id: "global", label: "全局", path: "/g", skillFiles: ["quick.md"] }],
		});
		assert.equal(c.found.length, 1);
		assert.equal(c.found[0].kind, "file");
	});
});

// ---------- install ----------

async function nodeOps() {
	const root = await mkdtemp(join(tmpdir(), "si-install-"));
	return {
		root,
		ops: {
			mkdirp: async (p) => {
				const { mkdir } = await import("node:fs/promises");
				await mkdir(p, { recursive: true });
			},
			writeFile: async (p, data) => {
				const { writeFile } = await import("node:fs/promises");
				await writeFile(p, data);
			},
			removeTree: async (p) => {
				await rm(p, { recursive: true, force: true });
			},
			exists: async (p) =>
				stat(p).then(
					() => true,
					() => false,
				),
			rename: async (a, b) => {
				const { rename } = await import("node:fs/promises");
				await rename(a, b);
			},
			listDir: async (p) => readdir(p),
		},
	};
}

describe("原子安装与回滚", () => {
	it("首次安装写入全部文件 + 元数据", async () => {
		const { root, ops } = await nodeOps();
		try {
			const files = packFrom({ "pkg/SKILL.md": SKILL_MD, "pkg/scripts/extract.sh": "#!/bin/sh\n" });
			const target = join(root, "skills", "pdf-tools");
			const res = await installSkill({
				files,
				skillRoot: "pkg",
				target,
				ops,
				meta: { source: "https://example.com/x.zip", at: 1 },
			});
			assert.equal(res.ok, true, res.error);
			assert.equal(res.files, 2);
			assert.equal(res.backup, null);
			assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /pdf-tools/);
			const meta = JSON.parse(await readFile(join(target, ".skill-import.json"), "utf8"));
			assert.equal(meta.source, "https://example.com/x.zip");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("重复安装留备份，回滚能还原旧版", async () => {
		const { root, ops } = await nodeOps();
		try {
			const target = join(root, "skills", "demo");
			const v1 = packFrom({ "SKILL.md": "---\nname: demo\ndescription: old version here ok\n---\nv1" });
			const first = await installSkill({ files: v1, skillRoot: "", target, ops });
			assert.equal(first.ok, true);

			const v2 = packFrom({ "SKILL.md": "---\nname: demo\ndescription: new version here ok\n---\nv2" });
			const second = await installSkill({ files: v2, skillRoot: "", target, ops });
			assert.equal(second.ok, true);
			assert.ok(second.backup && second.backup.includes(".__backup-"));
			assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /v2/);

			const rb = await rollbackInstall({ target, backup: second.backup, ops });
			assert.equal(rb.ok, true);
			assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /v1/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("写入失败时清掉 staging，且不动旧版本", async () => {
		const { root, ops } = await nodeOps();
		const target = join(root, "skills", "demo");
		try {
			const v1 = packFrom({ "SKILL.md": "---\nname: demo\ndescription: old version here ok\n---\nv1" });
			assert.equal((await installSkill({ files: v1, skillRoot: "", target, ops })).ok, true);

			const broken = {
				...ops,
				writeFile: async (p, data) => {
					if (String(p).endsWith("boom.txt")) throw new Error("disk full");
					return ops.writeFile(p, data);
				},
			};
			const v2 = packFrom({ "SKILL.md": "---\nname: demo\ndescription: v2\n---\nv2", "boom.txt": "x" });
			const res = await installSkill({ files: v2, skillRoot: "", target, ops: broken });
			assert.equal(res.ok, false);
			assert.match(res.error, /disk full/);
			assert.match(await readFile(join(target, "SKILL.md"), "utf8"), /v1/, "旧版本应还在");
			const leftovers = (await readdir(join(root, "skills"))).filter((n) => n.includes("__staging-"));
			assert.equal(leftovers.length, 0, "staging 应被清掉");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
