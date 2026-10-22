import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createImportService } = require("./server/import-service.cjs");
const { createOps } = require("./server/ops.cjs");
const { narrowToSkill, resolvePack, zipCandidates } = require("./server/fetch.cjs");
const {
	parseCommandArgs,
	runImportFlow,
	formatResult,
	formatList,
	formatUpdates,
	formatHealth,
} = require("./server/agent-bridge.cjs");
const { diffPacks } = require("./core/diff.cjs");
const { writeZip } = require("./core/zip-write.cjs");
const { readZip } = require("./core/zip.cjs");
import { SKILL_MD, buildZip, packFrom, createFakeHost, listScope, makeScopes, fakeHttp } from "./test-helpers.mjs";

const REPO_ZIP_V2 = buildZip([
	{ name: "repo-main/skills/demo/SKILL.md", data: SKILL_MD },
	{ name: "repo-main/skills/demo/scripts/extract.sh", data: "#!/bin/sh\necho v2\n", method: 0 },
	{ name: "repo-main/skills/demo/references/formats.md", data: "# formats" },
	{ name: "repo-main/skills/demo/references/new.md", data: "# new" },
	{ name: "repo-main/skills/other/SKILL.md", data: "---\nname: other\ndescription: 另一个技能，当需要别的能力时使用。\n---\n" },
]);

const REPO_ZIP = buildZip([
	{ name: "repo-main/skills/demo/SKILL.md", data: SKILL_MD },
	{ name: "repo-main/skills/demo/scripts/extract.sh", data: "#!/bin/sh\n", method: 0 },
	{ name: "repo-main/skills/demo/references/formats.md", data: "# formats" },
	{ name: "repo-main/skills/other/SKILL.md", data: "---\nname: other\ndescription: 另一个技能，当需要别的能力时使用。\n---\n" },
]);

// ---------- fetch ----------

describe("narrowToSkill", () => {
	const files = packFrom({
		"skills/demo/SKILL.md": SKILL_MD,
		"skills/demo/a.md": "a",
		"skills/other/SKILL.md": "x",
	});

	it("根目录有 SKILL.md 时原样返回", () => {
		const rootOnly = packFrom({ "SKILL.md": "x", "a.md": "y" });
		const r = narrowToSkill(rootOnly, "");
		assert.equal(r.ok, true);
		assert.equal(r.files.size, 2);
	});

	it("指定 path 时切出子树", () => {
		const r = narrowToSkill(files, "skills/demo");
		assert.equal(r.ok, true);
		assert.deepEqual([...r.files.keys()].sort(), ["SKILL.md", "a.md"]);
	});

	it("根目录 SKILL.md 优先于子目录技能", () => {
		const mixed = packFrom({ "SKILL.md": "root", "sub/SKILL.md": "x" });
		const r = narrowToSkill(mixed, "");
		assert.equal(r.ok, true);
		assert.equal(r.files.size, 2, "根目录形态应整包返回");
	});

	it("没指定 path 且多个技能时给候选", () => {
		const r = narrowToSkill(files, "");
		assert.equal(r.ok, true);
		assert.equal(r.needsPick, true);
		assert.deepEqual(r.candidates.map((c) => c.path).sort(), ["skills/demo", "skills/other"]);
	});

	it("path 指到文件时取它所在目录", () => {
		const r = narrowToSkill(files, "skills/demo/SKILL.md");
		assert.equal(r.ok, true);
		assert.deepEqual([...r.files.keys()].sort(), ["SKILL.md", "a.md"]);
	});

	it("没有 SKILL.md → 明确报错", () => {
		const r = narrowToSkill(packFrom({ "README.md": "x" }), "");
		assert.equal(r.ok, false);
		assert.equal(r.code, "no-skill");
	});
});

describe("zipCandidates", () => {
	it("无 ref 时 HEAD 优先", () => {
		const c = zipCandidates({ owner: "o", repo: "r", ref: "" });
		assert.equal(c[0], "https://codeload.github.com/o/r/zip/HEAD");
		assert.equal(c.length, 3);
	});

	it("ref 带斜杠时逐段编码", () => {
		const c = zipCandidates({ owner: "o", repo: "r", ref: "feat/x" });
		assert.equal(c[0], "https://codeload.github.com/o/r/zip/feat/x");
		assert.equal(c[1], "https://codeload.github.com/o/r/zip/refs/heads/feat/x");
	});
});

describe("resolvePack", () => {
	it("GitHub：一次 zipball 下载，按 path 取子树，并保留 full 供缓存", async () => {
		const http = fakeHttp(REPO_ZIP);
		const res = await resolvePack({
			src: { ok: true, kind: "github", owner: "o", repo: "r", ref: "", path: "skills/demo" },
			http,
		});
		assert.equal(res.ok, true, res.error);
		assert.deepEqual([...res.files.keys()].sort(), ["SKILL.md", "references/formats.md", "scripts/extract.sh"]);
		assert.equal(res.meta.kind, "github");
		assert.equal(http.calls.length, 1);
		assert.match(http.calls[0].url, /codeload\.github\.com\/o\/r\/zip\/HEAD/);
		assert.ok(res.full.has("skills/other/SKILL.md"), "full 应该是未裁剪的仓库树");
	});

	it("GitHub：多技能仓库返回候选", async () => {
		const res = await resolvePack({ src: { ok: true, kind: "github", owner: "o", repo: "r", path: "" }, http: fakeHttp(REPO_ZIP) });
		assert.equal(res.ok, true);
		assert.equal(res.needsPick, true);
		assert.equal(res.candidates.length, 2);
	});

	it("直链 markdown / text: 走单文件包", async () => {
		const md = await resolvePack({
			src: { ok: true, kind: "url-md", url: "https://x.dev/SKILL.md" },
			http: { get: async () => ({ ok: true, buffer: Buffer.from(SKILL_MD), status: 200, contentType: "text/markdown" }) },
		});
		assert.equal(md.ok, true);
		assert.deepEqual([...md.files.keys()], ["SKILL.md"]);

		const txt = await resolvePack({ src: { ok: true, kind: "text", content: SKILL_MD }, http: {} });
		assert.equal(txt.ok, true);
		assert.equal(txt.files.size, 1);
	});
});

// ---------- import service ----------

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "si-service-"));
	const skillsDir = join(root, ".pi", "skills");
	const globalDir = join(root, "global-skills");
	const host = createFakeHost(root);
	const http = fakeHttp(REPO_ZIP);
	const ops = createOps(host);
	const service = createImportService({
		host,
		http,
		ops,
		getScopes: () => makeScopes(host, skillsDir, globalDir),
	});
	return { root, skillsDir, globalDir, host, http, service };
}

describe("预览 → 安装 → 列表 → 回滚", () => {
	it("完整走一遍", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			const p = await service.preview({ source: "https://github.com/o/r/tree/main/skills/demo" });
			assert.equal(p.ok, true, p.error);
			assert.equal(p.needsPick, false);
			assert.equal(p.inspection.ok, true);
			assert.equal(p.inspection.skill.dirName, "demo");
			assert.equal(p.inspection.skill.name, "pdf-tools");
			assert.ok(
				p.inspection.issues.some((i) => i.code === "name-dir-mismatch"),
				"目录名与声明名不一致应该提示",
			);
			assert.equal(p.scopeId, "project");
			assert.ok(p.token);

			const first = await service.install({ token: p.token, scopeId: "project" });
			assert.equal(first.ok, true, first.error);
			assert.equal(first.name, "pdf-tools", "安装目录取声明名");
			assert.equal(first.files, 3);
			assert.equal(first.backup, null);
			assert.match(await readFile(join(skillsDir, "pdf-tools", "SKILL.md"), "utf8"), /pdf-tools/);
			assert.ok((await stat(join(skillsDir, "pdf-tools", "scripts", "extract.sh"))).isFile());
			const meta = JSON.parse(await readFile(join(skillsDir, "pdf-tools", ".skill-import.json"), "utf8"));
			assert.equal(meta.scope, "project");
			assert.match(meta.source, /o\/r/);

			const listed = await service.listInstalled();
			const demo = listed.scopes[0].skills.find((s) => s.name === "pdf-tools");
			assert.equal(demo.managed, true);
			assert.equal(demo.installId, first.installId);

			// 再预览一次并装同名 → 冲突
			const p2 = await service.preview({ source: "https://github.com/o/r/tree/main/skills/demo" });
			const conflict = await service.install({ token: p2.token, scopeId: "project" });
			assert.equal(conflict.ok, false);
			assert.equal(conflict.code, "conflict");

			const forced = await service.install({ token: p2.token, scopeId: "project", overwrite: true });
			assert.equal(forced.ok, true, forced.error);
			assert.ok(forced.backup, "覆盖安装应该留备份");

			const rb = await service.rollback({ id: forced.installId });
			assert.equal(rb.ok, true, rb.error);
			const after = await service.listInstalled();
			const stillThere = after.scopes[0].skills.find((s) => s.name === "pdf-tools");
			assert.ok(stillThere, "回滚后旧版本还在");
			assert.equal(stillThere.backup, null, "回滚后不该再挂着备份");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("token 过期 → 明确错误", async () => {
		const { root, service } = await setup();
		try {
			const res = await service.install({ token: "nope", scopeId: "project" });
			assert.equal(res.ok, false);
			assert.match(res.error, /过期/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("多技能仓库：预览给候选，选中后安装", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			const p = await service.preview({ source: "o/r" });
			assert.equal(p.ok, true);
			assert.equal(p.needsPick, true);
			assert.deepEqual(p.candidates.map((c) => c.label).sort(), ["demo", "other"]);

			const picked = await service.preview({ token: p.token, path: "skills/other" });
			assert.equal(picked.ok, true);
			assert.equal(picked.inspection.skill.dirName, "other");

			const inst = await service.install({ token: p.token, path: "skills/other", scopeId: "project" });
			assert.equal(inst.ok, true, inst.error);
			assert.ok((await readdir(skillsDir)).includes("other"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("校验不通过（description 太长）→ 拒绝安装", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			const longDesc = "x".repeat(1100);
			const md = `---\nname: bad\ndescription: ${longDesc}\n---\n`;
			const p = await service.preview({ source: `text:${md}` });
			assert.equal(p.inspection.ok, false);
			const res = await service.install({ token: p.token, scopeId: "project" });
			assert.equal(res.ok, false);
			assert.match(res.error, /校验未通过/);
			await assert.rejects(() => readdir(skillsDir), "不该创建目录");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------- 对话侧：命令解析 / 导入流程 / 文案 ----------

describe("parseCommandArgs", () => {
	it("来源 + 作用域 + overwrite + path", () => {
		const p = parseCommandArgs("anthropics/skills --global --path skills/pdf --overwrite");
		assert.equal(p.source, "anthropics/skills");
		assert.equal(p.scopeId, "global");
		assert.equal(p.path, "skills/pdf");
		assert.equal(p.overwrite, true);
	});

	it("list 子命令", () => {
		assert.equal(parseCommandArgs("list").list, true);
		assert.equal(parseCommandArgs("  LIST  ").list, true);
	});

	it("text: 整段当内容（含空格）", () => {
		const p = parseCommandArgs("text:---\nname: a\ndescription: 这里 有 空格\n---\n");
		assert.match(p.source, /这里有空格|这里 有 空格/);
		assert.equal(p.scopeId, "");
	});

	it("空参数给用法", () => {
		assert.match(parseCommandArgs("").error, /用法/);
	});
});

describe("runImportFlow（对话侧）", () => {
	it("安装成功返回 installed，并提示 /reload", async () => {
		const { root, service } = await setup();
		try {
			const res = await runImportFlow(service, { source: "https://github.com/o/r/tree/main/skills/demo", scopeId: "project" });
			assert.equal(res.status, "installed", JSON.stringify(res));
			assert.equal(res.name, "pdf-tools");
			const text = formatResult(res);
			assert.match(text, /已安装技能/);
			assert.match(text, /\/reload/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("多技能仓库 → pick，带候选", async () => {
		const { root, service } = await setup();
		try {
			const res = await runImportFlow(service, { source: "o/r", scopeId: "project" });
			assert.equal(res.status, "pick");
			assert.ok(res.candidates.includes("skills/demo"));
			assert.match(formatResult(res), /path/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("同名冲突 → conflict，不写盘", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			await mkdir(skillsDir, { recursive: true });
			await mkdir(join(skillsDir, "pdf-tools"), { recursive: true });
			await writeFile(join(skillsDir, "pdf-tools", "SKILL.md"), "old");
			const res = await runImportFlow(service, { source: "https://github.com/o/r/tree/main/skills/demo", scopeId: "project" });
			assert.equal(res.status, "conflict");
			assert.match(formatResult(res), /overwrite/);
			assert.equal(await readFile(join(skillsDir, "pdf-tools", "SKILL.md"), "utf8"), "old", "冲突时不能动旧文件");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("校验失败 → invalid，列出错误", async () => {
		const { root, service } = await setup();
		try {
			const md = `---\nname: bad\ndescription: ${"x".repeat(1100)}\n---\n`;
			const res = await runImportFlow(service, { source: `text:${md}`, scopeId: "project" });
			assert.equal(res.status, "invalid");
			assert.ok(res.issues.some((i) => i.code === "description-too-long"));
			assert.match(formatResult(res), /校验未通过/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("formatList 标出本插件导入与可回滚", () => {
		const text = formatList({
			scopes: [{ label: "项目", skills: [{ name: "a", managed: true, backup: "/x/.a.__backup-1" }, { name: "b" }] }],
		});
		assert.match(text, /a\*/);
		assert.match(text, /可回滚/);
		assert.match(text, /b/);
	});
});

// ---------- diff / 更新 / 健康检查 ----------

describe("diff", () => {
	it("识别新增 / 修改 / 删除 / 未变", () => {
		const a = packFrom({ "SKILL.md": "1", "a.md": "x", "b.md": "y" });
		const b = packFrom({ "SKILL.md": "1", "a.md": "X", "c.md": "z" });
		const d = diffPacks(a, b);
		assert.deepEqual(d.added, ["c.md"]);
		assert.deepEqual(d.changed, ["a.md"]);
		assert.deepEqual(d.removed, ["b.md"]);
		assert.equal(d.counts.unchanged, 1);
		assert.equal(d.identical, false);
		assert.equal(diffPacks(a, a).identical, true);
	});

	it("忽略点开头的元数据文件", () => {
		const a = packFrom({ "SKILL.md": "1", ".skill-import.json": "meta" });
		const b = packFrom({ "SKILL.md": "1" });
		assert.equal(diffPacks(a, b).identical, true);
	});
});

describe("检查更新与更新", () => {
	it("装完是最新；上游变了能发现并更新", async () => {
		const { root, service, http, skillsDir } = await setup();
		try {
			const p = await service.preview({ source: "https://github.com/o/r/tree/main/skills/demo" });
			assert.equal((await service.install({ token: p.token, scopeId: "project" })).ok, true);

			const first = await service.checkUpdates();
			assert.equal(first.items.length, 1);
			assert.equal(first.items[0].status, "up-to-date");
			assert.equal(first.updates, 0);

			http.set(REPO_ZIP_V2);
			const second = await service.checkUpdates();
			const item = second.items[0];
			assert.equal(item.status, "update-available");
			assert.deepEqual(item.diff.changed, ["scripts/extract.sh"]);
			assert.deepEqual(item.diff.added, ["references/new.md"]);
			assert.equal(second.updates, 1);

			const up = await service.update({ name: "pdf-tools", scopeId: "project" });
			assert.equal(up.ok, true, up.error);
			assert.match(up.diffSummary, /新增/);
			assert.ok(up.backup);
			assert.match(await readFile(join(skillsDir, "pdf-tools", "scripts", "extract.sh"), "utf8"), /v2/);
			assert.ok((await stat(join(skillsDir, "pdf-tools", "references", "new.md"))).isFile());

			const third = await service.checkUpdates();
			assert.equal(third.items[0].status, "up-to-date");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("手装的技能（无 meta）不参与检查", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			await mkdir(join(skillsDir, "manual"), { recursive: true });
			await writeFile(join(skillsDir, "manual", "SKILL.md"), "---\nname: manual\ndescription: 手动放的技能，当测试检查更新时使用。\n---\n");
			const res = await service.checkUpdates();
			assert.equal(res.items.length, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("技能目录被手动删掉后，列表与 registry 自动清理", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			const p = await service.preview({ source: "text:---\nname: gone\ndescription: 会被删掉的技能，当测试清理 registry 时使用。\n---\n" });
			assert.equal((await service.install({ token: p.token, scopeId: "project" })).ok, true);
			await rm(join(skillsDir, "gone"), { recursive: true, force: true });
			const listed = await service.listInstalled();
			assert.deepEqual(listed.scopes[0].skills, []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("text: 来源没有可追溯地址 → no-source", async () => {
		const { root, service } = await setup();
		try {
			const p = await service.preview({ source: "text:---\nname: t1\ndescription: 来自剪贴板的技能，当测试来源追踪时使用。\n---\n" });
			assert.equal((await service.install({ token: p.token, scopeId: "project" })).ok, true);
			const res = await service.checkUpdates();
			assert.equal(res.items[0].status, "no-source");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("健康检查", () => {
	it("抓断链引用与跨作用域重名", async () => {
		const { root, service, skillsDir, globalDir } = await setup();
		try {
			await mkdir(join(skillsDir, "broken"), { recursive: true });
			await writeFile(
				join(skillsDir, "broken", "SKILL.md"),
				"---\nname: broken\ndescription: 缺文件的技能，当测试健康检查时使用。\n---\n\n读 `references/nope.md`。\n",
			);
			for (const dir of [globalDir, skillsDir]) {
				await mkdir(join(dir, "dup"), { recursive: true });
				await writeFile(
					join(dir, "dup", "SKILL.md"),
					"---\nname: dup\ndescription: 同名的一份，当测试 shadow 时使用。\n---\n",
				);
			}
			const res = await service.health();
			const broken = res.items.find((i) => i.name === "broken");
			assert.ok(broken.issues.some((i) => i.code === "reference-missing"));
			assert.deepEqual(res.duplicates.map((d) => d.name), ["dup"]);
			assert.equal(res.totals.duplicates, 1);
			assert.ok(res.totals.warns >= 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("对话侧：新子命令与文案", () => {
	it("check / health / update 解析", () => {
		assert.equal(parseCommandArgs("check").check, true);
		assert.equal(parseCommandArgs("health").health, true);
		const u = parseCommandArgs("update pdf-tools --global");
		assert.equal(u.update, "pdf-tools");
		assert.equal(u.scopeId, "global");
	});

	it("formatUpdates / formatHealth", () => {
		const text = formatUpdates({
			checked: 2,
			updates: 1,
			items: [
				{ name: "a", status: "up-to-date" },
				{ name: "b", status: "update-available", summary: "修改 1" },
			],
		});
		assert.match(text, /可更新/);
		assert.match(text, /skill-import update/);

		const health = formatHealth({
			totals: { skills: 1, errors: 1, warns: 0, duplicates: 1 },
			items: [{ name: "x", scopeId: "project", issues: [{ level: "error", message: "缺 SKILL.md" }] }],
			duplicates: [{ name: "x", scopes: ["global", "project"] }],
		});
		assert.match(health, /健康检查/);
		assert.match(health, /缺 SKILL.md/);
		assert.match(health, /shadow/);
	});
});

// ---------- 启停 / 删除 / 下载 ----------

describe("启停、删除、下载", () => {
	it("停用搬到 .disabled/，启用搬回来", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			const p = await service.preview({ source: "https://github.com/o/r/tree/main/skills/demo" });
			assert.equal((await service.install({ token: p.token, scopeId: "project" })).ok, true);

			const off = await service.setEnabled({ name: "pdf-tools", scopeId: "project", enabled: false });
			assert.equal(off.ok, true, off.error);
			await assert.rejects(() => stat(join(skillsDir, "pdf-tools")), "原目录应该不在了");
			assert.ok((await stat(join(skillsDir, ".disabled", "pdf-tools", "SKILL.md"))).isFile());

			const listed = await service.listInstalled();
			const item = listed.scopes[0].skills.find((s) => s.name === "pdf-tools");
			assert.equal(item.enabled, false);
			assert.equal(listed.scopes[0].skills.find((s) => s.name === "pdf-tools").managed, true);
			assert.equal(item.managed, true, "停用后仍能读到 meta");

			const on = await service.setEnabled({ name: "pdf-tools", scopeId: "project", enabled: true });
			assert.equal(on.ok, true, on.error);
			assert.ok((await stat(join(skillsDir, "pdf-tools", "SKILL.md"))).isFile());
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("启用时目标已存在 → 拒绝而不是覆盖", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			const p = await service.preview({ source: "https://github.com/o/r/tree/main/skills/demo" });
			await service.install({ token: p.token, scopeId: "project" });
			await service.setEnabled({ name: "pdf-tools", scopeId: "project", enabled: false });
			// 手放一份同名的启用技能
			await mkdir(join(skillsDir, "pdf-tools"), { recursive: true });
			await writeFile(join(skillsDir, "pdf-tools", "SKILL.md"), "---\nname: pdf-tools\ndescription: 占用同名，当测试启用冲突时使用。\n---\n");
			const res = await service.setEnabled({ name: "pdf-tools", scopeId: "project", enabled: true });
			assert.equal(res.ok, false);
			assert.match(res.error, /已经|已有一份/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("删除只认作用域里列出的技能", async () => {
		const { root, skillsDir, service } = await setup();
		try {
			const p = await service.preview({ source: "https://github.com/o/r/tree/main/skills/demo" });
			await service.install({ token: p.token, scopeId: "project" });

			const missing = await service.removeSkill({ name: "../../etc", scopeId: "project" });
			assert.equal(missing.ok, false);

			const res = await service.removeSkill({ name: "pdf-tools", scopeId: "project" });
			assert.equal(res.ok, true, res.error);
			await assert.rejects(() => stat(join(skillsDir, "pdf-tools")));
			const listed = await service.listInstalled();
			assert.deepEqual(listed.scopes[0].skills, []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("停用的技能也能下载（readSkill 返回完整文件）", async () => {
		const { root, service } = await setup();
		try {
			const p = await service.preview({ source: "https://github.com/o/r/tree/main/skills/demo" });
			await service.install({ token: p.token, scopeId: "project" });
			await service.setEnabled({ name: "pdf-tools", scopeId: "project", enabled: false });
			const out = await service.readSkill({ name: "pdf-tools", scopeId: "project" });
			assert.equal(out.ok, true, out.error);
			assert.ok(out.files.has("SKILL.md"));
			assert.ok(out.files.has("scripts/extract.sh"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("zip 打包（下载用）", () => {
	it("写出来的包能被自己的 reader 读回", () => {
		const files = new Map([
			["SKILL.md", Buffer.from("---\nname: a\n---\n")],
			["scripts/x.sh", Buffer.from("#!/bin/sh\necho hi\n")],
			["assets/blob.bin", Buffer.from([0, 1, 2, 3, 0, 255])],
		]);
		const zip = writeZip(files);
		const back = readZip(zip);
		assert.equal(back.ok, true, back.error);
		assert.deepEqual([...back.files.keys()].sort(), ["SKILL.md", "assets/blob.bin", "scripts/x.sh"]);
		assert.equal(back.files.get("scripts/x.sh").toString("utf8"), "#!/bin/sh\necho hi\n");
		assert.deepEqual([...back.files.get("assets/blob.bin")], [0, 1, 2, 3, 0, 255]);
	});
});

// ---------- 推荐安装：大仓库走子树、同仓复用整仓包 ----------

/** 只读网络桩：HEAD 报体积、tree 列表、raw 文件、codeload 计数。 */
function installHttp({ zipBytes = 0, zipBuffer = null, files = ["skills/demo/SKILL.md"] } = {}) {
	const calls = [];
	return {
		calls,
		head: async (url) => {
			calls.push(["HEAD", url]);
			return { ok: true, status: 200, contentLength: zipBytes };
		},
		get: async (url) => {
			calls.push(["GET", url]);
			if (url.includes("api.github.com")) {
				return { ok: true, buffer: Buffer.from(JSON.stringify({ tree: files.map((path) => ({ type: "blob", path, size: 10 })) })) };
			}
			if (url.includes("raw.githubusercontent.com")) {
				return url.endsWith("/SKILL.md") ? { ok: true, buffer: Buffer.from(SKILL_MD) } : { ok: false, error: "HTTP 404" };
			}
			if (url.includes("codeload")) {
				return zipBuffer ? { ok: true, buffer: zipBuffer } : { ok: false, error: "HTTP 404" };
			}
			return { ok: false, error: `unexpected ${url}` };
		},
	};
}

async function setupWithHttp(http) {
	const root = await mkdtemp(join(tmpdir(), "si-service-http-"));
	const skillsDir = join(root, ".pi", "skills");
	const globalDir = join(root, "global-skills");
	const host = createFakeHost(root);
	const service = createImportService({
		host,
		http,
		ops: createOps(host),
		getScopes: () => makeScopes(host, skillsDir, globalDir),
	});
	return { root, skillsDir, service };
}

describe("推荐安装的网络路径", () => {
	it("带 path 预览超大仓库：只拉子目录，不下载整包", async () => {
		const http = installHttp({ zipBytes: 300 * 1024 * 1024 });
		const { root, service } = await setupWithHttp(http);
		try {
			const p = await service.preview({ source: "o/r", path: "skills/demo" });
			assert.equal(p.ok, true, p.error);
			assert.equal(p.inspection.skill.name, "pdf-tools");
			assert.ok(!http.calls.some(([method, url]) => method === "GET" && url.includes("codeload")), "不该整包下载");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("同一仓库连续装两个技能：整仓包复用，只下载一次", async () => {
		const zip = buildZip([
			{ name: "repo-main/skills/demo/SKILL.md", data: SKILL_MD },
			{ name: "repo-main/skills/other/SKILL.md", data: "---\nname: other\ndescription: 另一个技能，当需要别的能力时使用。\n---\n" },
		]);
		const http = installHttp({ zipBytes: 1024, zipBuffer: zip });
		const { root, service } = await setupWithHttp(http);
		try {
			const first = await service.preview({ source: "o/r", path: "skills/demo" });
			assert.equal(first.ok, true, first.error);
			const second = await service.preview({ source: "o/r", path: "skills/other" });
			assert.equal(second.ok, true, second.error);
			assert.equal(second.inspection.skill.dirName, "other");
			const downloads = http.calls.filter(([method, url]) => method === "GET" && url.includes("codeload"));
			assert.equal(downloads.length, 1, "第二个技能应复用已下载的整仓包");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
