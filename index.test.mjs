import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import plugin from "./index.mjs";
const require = createRequire(import.meta.url);
const { probe } = require("./server/impl.cjs");
import { createMockHost } from "./sdk/index.mjs";

const CWD = "/tmp/si-test-project";

describe("skill-import 第 1 步：探测与授权", () => {
	it("activate 注册了消息与诊断路由", async () => {
		const host = createMockHost({ cwd: CWD });
		await plugin.activate(host);
		const methods = host.calls.map((c) => c.method);
		assert.ok(methods.includes("onMessage"), "应该订阅 onMessage");
		assert.ok(methods.includes("route"), "应该挂 HTTP 路由");
		const routes = host.mock.routes.map((r) => `${r.method} ${r.path}`).sort();
		assert.deepEqual(routes, [
			"GET /check-updates",
			"GET /discover-sources",
			"GET /download",
			"GET /feedback",
			"GET /health",
			"GET /list",
			"GET /probe",
			"GET /recommend",
			"GET /sources",
			"POST /feedback",
			"POST /install",
			"POST /preview",
			"POST /recommend-install",
			"POST /remove",
			"POST /rollback",
			"POST /set-enabled",
			"POST /sources",
			"POST /update",
		]);
	});

	it("probe 列出四个落点，并能读到技能目录", async () => {
		const host = createMockHost({
			cwd: CWD,
			fs: {
				listPath: async (p) =>
					String(p).includes("/.pi/agent/skills")
						? [
								{ name: "alpha", type: "dir" },
								{ name: "beta", type: "dir" },
								{ name: "README.md", type: "file" },
							]
						: [],
			},
		});
		const data = await probe(host);
		assert.equal(data.cwd, CWD);
		assert.equal(data.scopes.length, 4);
		const global = data.scopes.find((s) => s.id === "global");
		assert.equal(global.authorized, true);
		assert.deepEqual(global.skills, ["alpha", "beta"], "只统计目录，忽略零散文件");
		assert.equal(global.count, 2);
		const project = data.scopes.find((s) => s.id === "project");
		assert.equal(project.path, `${CWD}/.pi/skills`);
		assert.equal(project.count, 0);
	});

	it("未授权目录给出 denied 标记而不是抛错", async () => {
		const host = createMockHost({
			cwd: CWD,
			fs: {
				listPath: async (p) => {
					if (String(p).includes(".pi/agent/skills")) throw new Error("目录未授权：先 await host.fs.requestAccess(dir)");
					if (String(p).includes(".agents")) throw new Error("ENOENT: no such file or directory");
					return [];
				},
			},
		});
		const data = await probe(host);
		const global = data.scopes.find((s) => s.id === "global");
		assert.equal(global.authorized, false);
		assert.match(global.error, /未授权/);
		const agentsGlobal = data.scopes.find((s) => s.id === "agents-global");
		assert.equal(agentsGlobal.authorized, true, "ENOENT 不是权限问题");
		assert.equal(agentsGlobal.exists, false);
	});

	it("点开头的条目被过滤（备份/暂存目录不会变成幽灵技能）", async () => {
		const host = createMockHost({
			cwd: CWD,
			fs: {
				listPath: async () => [
					{ name: ".demo.__backup-1", type: "dir" },
					{ name: "demo", type: "dir" },
					{ name: ".hidden.md", type: "file" },
					{ name: "x.md", type: "file" },
				],
			},
		});
		const data = await probe(host);
		assert.deepEqual(data.scopes[0].skills, ["demo"]);
		assert.deepEqual(data.scopes[0].skillFiles, ["x.md"]);
	});

	it("收到 probe 消息后把结果广播回客户端", async () => {
		const sent = [];
		const host = createMockHost({
			cwd: CWD,
			broadcast: (payload) => sent.push(payload),
		});
		await plugin.activate(host);
		await host.mock.emitAsync("onMessage", { action: "skill-import:probe" });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].type, "probe");
		assert.equal(sent[0].data.scopes.length, 4);
	});

	it("注册了 import_skill 工具与 /skill-import 命令", async () => {
		const host = createMockHost({ cwd: CWD });
		await plugin.activate(host);
		assert.equal(host.mock.agentTools.length, 1);
		const tool = host.mock.agentTools[0];
		assert.equal(tool.name, "import_skill");
		assert.ok(tool.parameters?.properties?.source);
		assert.deepEqual(tool.parameters?.properties?.mode?.enum, ["install", "list", "check", "update", "health"]);
		assert.equal(typeof tool.execute, "function");
		assert.equal(host.mock.commands.length, 1);
		// 右侧面板挂了「技能」tab（就在文件列表旁边）——manifest 声明，mock 不反射，直接读文件
		const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
		const tab = manifest.ui?.["rightpanel.tabs"]?.[0];
		assert.ok(tab, "应该有 rightpanel.tabs 条目");
		assert.equal(tab.label, "技能");
		assert.equal(tab.kind, "view");
		const cmd = host.mock.commands[0];
		assert.equal(cmd.name, "skill-import");
		assert.equal(typeof cmd.run, "function");
		assert.match(cmd.argumentHint ?? "", /overwrite/);
	});

	it("list 动作回一份落点清单（空目录也能用）", async () => {
		const sent = [];
		const host = createMockHost({ cwd: CWD, broadcast: (payload) => sent.push(payload) });
		await plugin.activate(host);
		await host.mock.emitAsync("onMessage", { action: "skill-import:list" });
		const last = sent.at(-1);
		assert.equal(last.type, "list");
		assert.equal(last.data.ok, true);
		assert.equal(last.data.scopes.length, 4);
		assert.deepEqual(last.data.scopes[0].skills, []);
	});

	it("授权成功后重新广播探测结果，并给出提示", async () => {
		const sent = [];
		const notices = [];
		const asked = [];
		const host = createMockHost({
			cwd: CWD,
			broadcast: (payload) => sent.push(payload),
			notify: (level, text) => notices.push({ level, text }),
			fs: {
				requestAccess: async (dir, reason) => {
					asked.push({ dir, reason });
					return true;
				},
			},
		});
		await plugin.activate(host);
		await host.mock.emitAsync("onMessage", { action: "skill-import:grant", path: "/Users/x/.pi/agent/skills" });
		assert.equal(asked.length, 1);
		assert.match(asked[0].reason, /技能/);
		assert.equal(notices[0].level, "info");
		assert.equal(sent.at(-1).type, "probe");
	});

	it("动作里抛错时转成 error 广播，且不炸 handler", async () => {
		const sent = [];
		const host = createMockHost({
			cwd: CWD,
			broadcast: (payload) => sent.push(payload),
			fs: { requestAccess: async () => { throw new Error("boom"); } },
		});
		await plugin.activate(host);
		await host.mock.emitAsync("onMessage", { action: "skill-import:grant", path: "/x" });
		const last = sent.at(-1);
		assert.equal(last.type, "error");
		assert.match(last.message, /boom/);
	});
});
