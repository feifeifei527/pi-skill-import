import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRATEGIES, createProjectResolver, defaultEnv, normalizePath } from "./client/project-dir.mjs";

const resolverFor = (env) => createProjectResolver(env);

describe("项目目录解析链", () => {
	it("只接受绝对路径，去掉尾部斜杠", () => {
		assert.equal(normalizePath("/Users/x/proj/"), "/Users/x/proj");
		assert.equal(normalizePath("  /a  "), "/a");
		assert.equal(normalizePath("relative/path"), "");
		assert.equal(normalizePath("file:///Users/x"), "");
		assert.equal(normalizePath("/"), "");
		assert.equal(normalizePath(null), "");
	});

	it("getCwd 优先于其它策略", () => {
		const r = resolverFor({
			host: { getCwd: () => "/proj/from-bridge" },
			storage: { getItem: () => "/proj/from-storage" },
		});
		assert.deepEqual(
			{ path: r.resolve().path, id: r.resolve().sourceId },
			{ path: "/proj/from-bridge", id: "host.cwd" },
		);
	});

	it("getCwd 抛错/为空时退回按会话 id 匹配", () => {
		const r = resolverFor({
			host: {
				getCwd: () => { throw new Error("boom"); },
				getConversationId: () => "c9",
				listSessions: () => [
					{ id: "c1", cwd: "/wrong" },
					{ id: "c9", cwd: "/proj/right/" },
				],
			},
			storage: { getItem: () => "/proj/from-storage" },
		});
		const found = r.resolve();
		assert.equal(found.path, "/proj/right");
		assert.equal(found.sourceId, "host.session");
	});

	it("会话 id 不匹配时不硬用别的会话目录", () => {
		const r = resolverFor({
			host: { getCwd: () => "", getConversationId: () => "c9", listSessions: () => [{ id: "c1", cwd: "/other" }] },
			storage: { getItem: (k) => (k === "pi-web-last-cwd" ? "/proj/last" : null) },
		});
		const found = r.resolve();
		assert.equal(found.path, "/proj/last");
		assert.equal(found.sourceId, "storage.last-cwd");
	});

	it("最近项目只在唯一候选时采用，并标记低置信", () => {
		const one = resolverFor({ host: null, storage: { getItem: (k) => (k === "pi-web-recent-projects" ? JSON.stringify([{ path: "/proj/only" }]) : null) } });
		assert.equal(one.resolve().path, "/proj/only");
		assert.equal(one.resolve().confidence, "low");
		const many = resolverFor({ host: null, storage: { getItem: (k) => (k === "pi-web-recent-projects" ? JSON.stringify(["/a", "/b"]) : null) } });
		assert.equal(many.resolve().path, "");
	});

	it("全部失效时返回空，并给出逐条诊断", () => {
		const r = resolverFor({ host: null, storage: null });
		assert.deepEqual({ ...r.resolve(), source: undefined, sourceId: undefined }, { path: "", confidence: "none", source: undefined, sourceId: undefined });
		const diag = r.diagnose();
		assert.equal(diag.length, STRATEGIES.length);
		assert.ok(diag.every((d) => d.value === ""));
		assert.ok(diag.some((d) => d.id === "host.cwd"));
	});

	it("默认环境从 globalThis 取，宿主没有桥也不报错", () => {
		const before = { window: globalThis.window, localStorage: globalThis.localStorage };
		try {
			delete globalThis.window;
			delete globalThis.localStorage;
			const env = defaultEnv();
			assert.equal(env.host, null);
			assert.equal(env.storage, null);
			globalThis.window = { __piWebUiHost: { getCwd: () => "/proj/window" } };
			assert.equal(createProjectResolver().resolve().path, "/proj/window", "延迟读取，不在 import 时固化");
		} finally {
			if (before.window === undefined) delete globalThis.window; else globalThis.window = before.window;
			if (before.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = before.localStorage;
		}
	});
});
