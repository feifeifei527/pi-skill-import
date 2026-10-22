import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/index.mjs";
const require = createRequire(import.meta.url);
const { createRequestContext } = require("./server/context.cjs");

function fakeHost() {
	return {
		cwd: "/tmp/wrong-project",
		getActiveConversation: ({ clientId } = {}) => ({ clientId, conversationId: clientId, title: clientId, messages: [{ role: "user", text: `${clientId} task` }] }),
		conversations: { list: async () => [{ id: "a", cwd: "/tmp/project-a" }, { id: "b", cwd: "/tmp/project-b" }] },
	};
}

describe("请求级上下文", () => {
	it("按 clientId 取快照，并从同一会话的清单取 cwd，不用全局 host.cwd", async () => {
		const context = createRequestContext(fakeHost());
		await context.run("a", () => {
			assert.equal(context.host.cwd, "/tmp/project-a");
			assert.equal(context.host.getActiveConversation().title, "a");
		});
		assert.equal(context.host.cwd, "/tmp/wrong-project", "请求外不能留下可变 cwd");
	});

	it("并发且交错 await 的两个标签页仍使用各自上下文", async () => {
		const context = createRequestContext(fakeHost());
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		let entered;
		const started = new Promise((resolve) => { entered = resolve; });
		const a = context.run("a", async () => {
			entered();
			await gate;
			assert.equal(context.host.cwd, "/tmp/project-a");
			assert.equal(context.host.getActiveConversation().conversationId, "a");
		});
		await started;
		await context.run("b", async () => {
			await Promise.resolve();
			assert.equal(context.host.cwd, "/tmp/project-b");
			release();
		});
		await a;
	});

	it("没有项目元数据或宿主回落到其它客户端时保持未知", async () => {
		const host = fakeHost();
		host.getActiveConversation = () => ({ clientId: "other", conversationId: "a" });
		const context = createRequestContext(host);
		await context.run("a", () => {
			assert.equal(context.host.cwd, "");
			assert.equal(context.host.getActiveConversation(), null);
		});
	});

	it("真实 onMessage(from) 只定向回包，probe 不串项目", async () => {
		const directed = [];
		const broadcasts = [];
		const base = fakeHost();
		const host = createMockHost({
			...base,
			fs: { listPath: async () => [] },
			sendTo: (id, payload) => directed.push({ id, payload }),
			broadcast: (payload) => broadcasts.push(payload),
		});
		const dispose = await plugin.activate(host);
		try {
			await Promise.all(["a", "b"].map((id) => host.mock.emitAsync("onMessage", { action: "skill-import:probe" }, id)));
			assert.equal(broadcasts.length, 0);
			for (const id of ["a", "b"]) {
				const data = directed.find((r) => r.id === id).payload.data;
				assert.equal(data.conversationId, id);
				assert.equal(data.scopes.find((s) => s.id === "project").path, `/tmp/project-${id}/.pi/skills`);
			}
		} finally { dispose(); }
	});

	it("HTTP 下载沿用探测时确认的项目，未知句柄报错而不是回落其它项目", async () => {
		const sent = [];
		const reads = [];
		const base = fakeHost();
		const host = createMockHost({
			...base, sendTo: (_id, payload) => sent.push(payload),
			fs: {
				listPath: async (path) => path === "/tmp/project-a/.pi/skills" ? [{ name: "pdf", type: "dir" }] : path === "/tmp/project-a/.pi/skills/pdf" ? [{ name: "SKILL.md", type: "file" }] : [],
				readPath: async (path) => { reads.push(path); return Buffer.from("project-a document"); },
			},
		});
		const dispose = await plugin.activate(host);
		const response = () => ({ headersSent: false, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, setHeader() {}, end(body) { this.body = body; } });
		try {
			await host.mock.emitAsync("onMessage", { action: "skill-import:probe" }, "a");
			const token = sent.at(-1).data.downloadContext;
			assert.ok(token);
			const route = host.mock.routes.find((r) => r.path === "/download");
			const res = response();
			await route.handler({ query: { name: "pdf", scopeId: "project", context: token } }, res);
			assert.equal(res.statusCode, 200, JSON.stringify(res.body));
			assert.ok(Buffer.isBuffer(res.body));
			assert.deepEqual(reads, ["/tmp/project-a/.pi/skills/pdf/SKILL.md"]);
			const invalid = response();
			await route.handler({ query: { name: "pdf", scopeId: "project", context: "invalid" } }, invalid);
			assert.equal(invalid.statusCode, 410);
		} finally { dispose(); }
	});

	it("HTTP probe 也返回可用于下载的有效上下文句柄", async () => {
		const host = createMockHost({
			cwd: "/tmp/project-a",
			fs: {
				listPath: async (path) => path === "/tmp/project-a/.pi/skills" ? [{ name: "pdf", type: "dir" }] : path === "/tmp/project-a/.pi/skills/pdf" ? [{ name: "SKILL.md", type: "file" }] : [],
				readPath: async () => Buffer.from("HTTP project-a skill"),
			},
		});
		const response = () => ({ headersSent: false, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, setHeader() {}, end(body) { this.body = body; } });
		const dispose = await plugin.activate(host);
		try {
			const probe = response();
			await host.mock.routes.find((r) => r.method === "GET" && r.path === "/probe").handler({}, probe);
			assert.equal(typeof probe.body.downloadContext, "string");
			const zip = response();
			await host.mock.routes.find((r) => r.path === "/download").handler({ query: { name: "pdf", scopeId: "project", context: probe.body.downloadContext } }, zip);
			assert.equal(zip.statusCode, 200);
			assert.ok(Buffer.isBuffer(zip.body));
		} finally { dispose(); }
	});

	it("切换对话后，旧推荐完成也不再向新对话发回", async () => {
		const host = fakeHost();
		let id = "a";
		host.getActiveConversation = ({ clientId } = {}) => ({ clientId, conversationId: id });
		const context = createRequestContext(host);
		await context.run("client", async () => {
			assert.equal(context.isCurrent(), true);
			id = "b";
			await Promise.resolve();
			assert.equal(context.isCurrent(), false);
		});
	});

	it("项目目录未知时不暴露项目落点，也不把项目安装静默转成全局", async () => {
		const sent = [];
		const host = createMockHost({ cwd: "/tmp/wrong", getActiveConversation: () => null, sendTo: (_id, p) => sent.push(p) });
		const dispose = await plugin.activate(host);
		try {
			await host.mock.emitAsync("onMessage", { action: "skill-import:probe" }, "a");
			assert.ok(!sent.at(-1).data.scopes.some((s) => s.id.includes("project")));
			await host.mock.emitAsync("onMessage", { action: "skill-import:install", scopeId: "project", token: "old-token" }, "a");
			assert.equal(sent.at(-1).type, "error");
			assert.match(sent.at(-1).message, /无法确认/);
		} finally { dispose(); }
	});
});

describe("显式项目目录（宿主不给 cwd 时的兜底）", () => {
	it("消息里带 projectDir 就能拿到项目落点", async () => {
		const sent = [];
		const host = createMockHost({
			cwd: "/tmp/wrong-project",
			getActiveConversation: () => ({ clientId: "x", conversationId: "c1" }),
			conversations: { list: async () => [] },
			fs: { listPath: async () => [] },
			sendTo: (_id, payload) => sent.push(payload),
		});
		const dispose = await plugin.activate(host);
		try {
			await host.mock.emitAsync("onMessage", { action: "skill-import:probe", projectDir: "/tmp/real-project" }, "x");
			const probe = sent.at(-1).data;
			assert.equal(probe.cwd, "/tmp/real-project");
			assert.equal(probe.scopes.find((s) => s.id === "project").path, "/tmp/real-project/.pi/skills");
		} finally { dispose(); }
	});

	it("相对路径不被采信，仍按未确认处理", async () => {
		const sent = [];
		const host = createMockHost({
			cwd: "", getActiveConversation: () => null,
			fs: { listPath: async () => [] },
			sendTo: (_id, payload) => sent.push(payload),
		});
		const dispose = await plugin.activate(host);
		try {
			await host.mock.emitAsync("onMessage", { action: "skill-import:probe", projectDir: "relative/path" }, "x");
			const probe = sent.at(-1).data;
			assert.equal(probe.cwd, "");
			assert.ok(!probe.scopes.some((s) => s.id.includes("project")));
		} finally { dispose(); }
	});

	it("HTTP 也能用 ?projectDir= 指定（curl/脚本）", async () => {
		const host = createMockHost({ cwd: "/tmp/wrong-project", fs: { listPath: async () => [] } });
		const dispose = await plugin.activate(host);
		const response = () => ({ headersSent: false, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, setHeader() {}, end() {} });
		try {
			const res = response();
			await host.mock.routes.find((r) => r.method === "GET" && r.path === "/probe").handler({ query: { projectDir: "/tmp/http-project" } }, res);
			assert.equal(res.body.cwd, "/tmp/http-project");
			assert.ok(res.body.scopes.some((s) => s.id === "project"));
		} finally { dispose(); }
	});
});
