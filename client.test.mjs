/**
 * 客户端视图的交互测试：用一个极简 DOM 跑真实 mount，再喂服务端 payload。
 *
 * 目的不是像素级验证，而是挡住三类回归：
 * 1. mount 时该发的消息（probe / list / recommend）没发或发错动作；
 * 2. 推荐结果里的「收藏 / 任务推荐 / 已装状态 / 安装落点 / 等待重新加载」没渲染；
 * 3. 可编辑需求、候选搜索分页、多行粘贴这些交互把参数发错。
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createRequire } from "node:module";
import plugin from "./index.mjs";
import { createMockHost } from "./sdk/index.mjs";
const require = createRequire(import.meta.url);
const { readZip } = require("./core/zip.cjs");

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.style = { cssText: "", display: "", color: "" };
		this._text = "";
		this._cls = "";
		this._value = "";
		this._listeners = new Map();
		const set = new Set();
		this.classList = {
			_s: set,
			add: (c) => set.add(c),
			remove: (c) => set.delete(c),
			contains: (c) => set.has(c),
			toggle: (c, on) => {
				const v = on === undefined ? !set.has(c) : Boolean(on);
				if (v) set.add(c);
				else set.delete(c);
				return v;
			},
		};
	}
	get className() {
		return [...this.classList._s].join(" ");
	}
	set className(v) {
		this.classList._s = new Set(String(v ?? "").split(/\s+/).filter(Boolean));
	}
	get textContent() {
		return this._text + this.children.map((c) => c.textContent).join("");
	}
	set textContent(v) {
		this._text = String(v ?? "");
		this.children = [];
	}
	get value() {
		if (this.tagName === "SELECT") {
			const sel = this.children.find((o) => o.selected);
			return sel ? sel.value : this.children[0]?.value ?? "";
		}
		return this._value;
	}
	set value(v) {
		this._value = String(v ?? "");
	}
	appendChild(c) {
		if (c.parentNode) c.remove();
		c.parentNode = this;
		this.children.push(c);
		return c;
	}
	append(...cs) {
		for (const c of cs) this.appendChild(c);
	}
	replaceChildren(...cs) {
		for (const c of this.children) c.parentNode = null;
		this.children = [];
		this._text = "";
		this.append(...cs);
	}
	remove() {
		if (!this.parentNode) return;
		this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
		this.parentNode = null;
	}
	addEventListener(type, fn) {
		const list = this._listeners.get(type) ?? [];
		list.push(fn);
		this._listeners.set(type, list);
	}
	dispatch(type) {
		for (const fn of this._listeners.get(type) ?? []) fn({ type, target: this, key: "", preventDefault() {} });
	}
	click() {
		this.dispatch("click");
	}
	setAttribute(k, v) {
		this[`_attr_${k}`] = v;
	}
	getAttribute(k) {
		return this[`_attr_${k}`];
	}
}

globalThis.document = {
	activeElement: null,
	createElement: (tag) => new El(tag),
	body: new El("body"),
};

const view = (await import("./client/entry.mjs")).default;

function walk(el, out = []) {
	out.push(el);
	for (const c of el.children) walk(c, out);
	return out;
}

function findAll(root, pred) {
	return walk(root).filter(pred);
}

function findButton(root, text) {
	return findAll(root, (el) => el.tagName === "BUTTON" && el.textContent.trim() === text)[0];
}

function findInput(root, placeholderPrefix) {
	return findAll(
		root,
		(el) => (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && String(el.placeholder ?? "").startsWith(placeholderPrefix),
	)[0];
}

function mountView({ onSend = () => {} } = {}) {
	const container = new El("div");
	const sent = [];
	let onData = null;
	const ctx = {
		send: (payload) => { sent.push(payload); onSend(payload); },
		onData: (fn) => {
			onData = fn;
			return () => {
				onData = null;
			};
		},
	};
	const cleanup = view.mount(container, ctx);
	return {
		container,
		sent,
		emit: (payload) => onData?.(payload),
		cleanup,
		text: () => container.textContent,
	};
}

const SCOPES = [
	{
		id: "global",
		label: "全局 · Pi",
		path: "/home/u/.pi/agent/skills",
		writable: true,
		authorized: true,
		count: 2,
		skills: ["a", "b"],
		disabledSkills: [],
	},
	{
		id: "project",
		label: "项目 · .pi",
		path: "/tmp/demo-project/.pi/skills",
		writable: true,
		authorized: true,
		count: 0,
		skills: [],
		disabledSkills: [],
	},
];

function recommendPayload(over = {}) {
	return {
		type: "recommend",
		data: {
			ok: true,
			items: [
				{
					id: "o/r@HEAD:skills/pdf-tools",
					name: "pdf-tools",
					repo: "o/r",
					path: "skills/pdf-tools",
					description: "从 PDF 提取文本与表格",
					reason: "适合当前任务",
					addedCapability: "PDF 表格抽取",
				},
			],
			pinned: [
				{
					id: "o/r@HEAD:skills/commit",
					name: "git-commit",
					repo: "o/r",
					path: "skills/commit",
					description: "写 conventional commit",
					pinned: true,
					why: ["钉住"],
				},
			],
			installedHits: [
				{ name: "local-pdf", status: "disabled", enabled: false, scopeId: "global", note: "已停用，需先启用" },
				{ name: "local-log", status: "reloading", enabled: true, scopeId: "project", note: "已安装，等待重新加载" },
			],
			reload: { items: [{ name: "local-log", kind: "install", at: Date.now() }], count: 1, names: ["local-log"], command: "/reload" },
			task: { text: "帮我把 PDF 里的表格抽出来", mode: "latest", edited: false, inherited: false, capabilities: [], keywords: [] },
			indexCount: 1200,
			indexAt: Date.now(),
			sourceStats: [{ repo: "o/r", count: 2 }],
			candidatesCount: 3,
			installedCount: 2,
			usedLLM: true,
			feedback: { ignored: [], pinned: ["git-commit"] },
			...over,
		},
	};
}

describe("客户端视图", () => {
	it("mount 后先探测、拉清单、请求推荐", () => {
		const { sent, cleanup } = mountView();
		try {
			assert.deepEqual(
				sent.map((x) => x.action),
				["skill-import:probe", "skill-import:list", "skill-import:recommend"],
			);
		} finally {
			cleanup();
		}
	});

	it("推荐结果：收藏区独立、需求框可编辑、安装落点带项目名", () => {
		const { container, emit, cleanup, text } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(recommendPayload());

			assert.match(text(), /收藏（1）/);
			assert.match(text(), /按任务推荐/);
			assert.match(text(), /另有|git-commit/);
			// 需求框默认填入识别出的任务
			const demand = findInput(container, "这次要做的事");
			assert.equal(demand.value, "帮我把 PDF 里的表格抽出来");
			// 安装落点：项目名可见 + 按钮文案跟随当前选择
			assert.match(text(), /安装到项目/);
			const select = findAll(container, (el) => el.tagName === "SELECT")[0];
			assert.ok(select, "应该有安装落点选择");
			assert.deepEqual(
				select.children.map((o) => o.textContent),
				["全局 · Pi", "项目 · demo-project"],
			);
			// 已装命中区分状态
			assert.match(text(), /已停用/);
			assert.match(text(), /等待重新加载/);
			assert.ok(findButton(container, "启用"), "停用的技能要给启用入口");
			assert.match(text(), /\/reload/);
		} finally {
			cleanup();
		}
	});

	it("改需求后点「按这个需求推荐」带上 q；「用当前对话」清掉编辑态", () => {
		const { container, emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(recommendPayload());
			const demand = findInput(container, "这次要做的事");
			demand.value = "写一条 conventional commit";
			demand.dispatch("input");
			findButton(container, "按这个需求推荐").click();
			const last = sent.at(-1);
			assert.equal(last.action, "skill-import:recommend");
			assert.equal(last.q, "写一条 conventional commit");

			sent.length = 0;
			findButton(container, "用当前对话").click();
			assert.equal(sent.at(-1).action, "skill-import:recommend");
			assert.equal(sent.at(-1).q, undefined, "用当前对话时不该带手动需求");
		} finally {
			cleanup();
		}
	});

	it("安装成功 → 显示等待重新加载；「已重新加载」发 ack-reload 并收起横幅", () => {
		const { container, emit, sent, cleanup, text } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(recommendPayload({ reload: { items: [], count: 0, names: [] } }));
			emit({ type: "recommend-install", data: { ok: true, name: "pdf-tools", reload: { items: [{ name: "pdf-tools", kind: "install" }], count: 1, names: ["pdf-tools"] } } });

			assert.match(text(), /已安装推荐技能「pdf-tools」/);
			assert.match(text(), /pdf-tools/);
			const done = findButton(container, "已重新加载");
			assert.ok(done, "应该有「已重新加载」按钮");
			done.click();
			assert.equal(sent.at(-1).action, "skill-import:ack-reload");

			emit({ type: "ack-reload", data: { ok: true, cleared: ["pdf-tools"], reload: { items: [], count: 0, names: [] } } });
			assert.ok(!findButton(container, "已重新加载"), "确认后横幅应该收起");
		} finally {
			cleanup();
		}
	});

	it("反馈按钮发 op（服务端归一成 action）", () => {
		const { container, emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(recommendPayload());
			// 收藏区在前：它只有「取消钉住 / 不感兴趣」
			const unpin = findButton(container, "取消钉住");
			unpin.click();
			assert.equal(sent.at(-1).op, "unpin");
			assert.equal(sent.at(-1).name, "git-commit");

			// 任务推荐区的卡片才有「钉住」
			const pinButtons = findAll(container, (el) => el.tagName === "BUTTON" && el.textContent.trim() === "钉住");
			assert.equal(pinButtons.length, 1, "只有任务推荐卡片能给钉住");
			pinButtons[0].click();
			assert.equal(sent.at(-1).action, "skill-import:feedback");
			assert.equal(sent.at(-1).op, "pin");
			assert.equal(sent.at(-1).name, "pdf-tools");

			findAll(container, (el) => el.tagName === "BUTTON" && el.textContent.trim() === "不感兴趣").at(-1).click();
			assert.equal(sent.at(-1).op, "ignore");
			assert.equal(sent.at(-1).name, "pdf-tools");
		} finally {
			cleanup();
		}
	});

	it("按钮 → onMessage → 存储 → 回包 → 视图完整闭环，且反馈后保留手动需求", async () => {
		let ui;
		const queue = [];
		const host = createMockHost({
			cwd: "/tmp/wrong-project", settings: { repos: "o/r", rerank: false },
			getActiveConversation: () => ({ clientId: "test", conversationId: "one", cwd: "/tmp/demo-project", messages: [{ role: "user", text: "写 commit" }] }),
			fs: { listPath: async () => [], readTextPath: async () => { throw new Error("ENOENT"); } },
			sendTo: (_id, payload) => ui?.emit(payload),
		});
		host.storage.set("catalog", { schema: 3, at: Date.now(), sources: ["o/r"], entries: [{ id: "o/r@HEAD:pdf", name: "pdf-tools", repo: "o/r", path: "pdf", description: "从 PDF 提取文本与表格", tasks: ["提取 PDF 表格"] }] });
		const dispose = await plugin.activate(host);
		ui = mountView({ onSend: (payload) => queue.push(host.mock.emitAsync("onMessage", payload, "test")) });
		const flush = async () => {
			let rounds = 0;
			while (queue.length) { assert.ok(++rounds < 20, "不应循环派发请求"); await Promise.all(queue.splice(0)); }
		};
		try {
			await flush();
			const demand = findInput(ui.container, "这次要做的事");
			demand.value = "从 PDF 提取表格"; demand.dispatch("input");
			findButton(ui.container, "按这个需求推荐").click(); await flush();
			findButton(ui.container, "钉住").click(); await flush();
			assert.deepEqual(Object.keys(host.storage.get("feedback").pinned), ["pdf-tools"]);
			assert.ok(findButton(ui.container, "取消钉住"));
			assert.equal(ui.sent.filter((p) => p.action === "skill-import:recommend").at(-1).q, "从 PDF 提取表格");
			findButton(ui.container, "取消钉住").click(); await flush();
			assert.deepEqual(Object.keys(host.storage.get("feedback").pinned), []);
			findButton(ui.container, "不感兴趣").click(); await flush();
			assert.deepEqual(Object.keys(host.storage.get("feedback").ignored), ["pdf-tools"]);
			const restore = findAll(ui.container, (el) => el.className.includes("si-chip") && el.textContent === "pdf-tools ↩")[0];
			assert.ok(restore); restore.click(); await flush();
			assert.deepEqual(Object.keys(host.storage.get("feedback").ignored), []);
			assert.ok(findButton(ui.container, "钉住"));
		} finally { ui.cleanup(); dispose(); }
	});

	for (const allowed of [true, false]) {
		it(`授权${allowed ? "成功" : "拒绝"}后，页面既有项目下载链接仍可请求有效 ZIP`, async () => {
			const project = "/tmp/grant-download-project";
			const skills = `${project}/.pi/skills`;
			const document = "---\nname: pdf\ndescription: 从 PDF 提取表格\n---\n# project PDF skill\n";
			const granted = new Set();
			const requested = [];
			const reads = [];
			const probes = [];
			const queue = [];
			let ui;
			const host = createMockHost({
				cwd: "/tmp/not-this-project", settings: { rerank: false },
				getActiveConversation: () => ({ clientId: "grant-test", conversationId: "grant-conversation", cwd: project, messages: [] }),
				fs: {
					listPath: async (path) => {
						if (path === skills) return [{ name: "pdf", type: "dir" }];
						if (path === `${skills}/pdf`) return [{ name: "SKILL.md", type: "file" }];
						if (path.startsWith(`${skills}/`) || granted.has(path)) return [];
						throw new Error("目录未授权");
					},
					readTextPath: async (path) => { if (path === `${skills}/pdf/SKILL.md`) return document; throw new Error("ENOENT"); },
					readPath: async (path) => { assert.equal(path, `${skills}/pdf/SKILL.md`); reads.push(path); return Buffer.from(document); },
					requestAccess: async (path) => { requested.push(path); if (allowed) granted.add(path); return allowed; },
				},
				sendTo: (_id, payload) => { if (payload.type === "probe") probes.push(payload.data); ui?.emit(payload); },
			});
			const dispose = await plugin.activate(host);
			ui = mountView({ onSend: (payload) => queue.push(host.mock.emitAsync("onMessage", payload, "grant-test")) });
			const flush = async () => {
				let rounds = 0;
				while (queue.length) { assert.ok(++rounds < 20); await Promise.all(queue.splice(0)); }
			};
			const download = async () => {
				const link = findAll(ui.container, (el) => el.tagName === "A" && el.getAttribute("download") === "pdf.zip")[0];
				assert.ok(link?.href, "授权回包不能清空现有下载链接");
				const url = new URL(link.href, "http://localhost");
				assert.equal(url.searchParams.get("scopeId"), "project");
				assert.equal(url.searchParams.get("context"), probes.at(-1).downloadContext);
				const response = { headersSent: false, statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, setHeader() {}, end(body) { this.body = body; } };
				await host.mock.routes.find((r) => r.path === "/download").handler({ query: Object.fromEntries(url.searchParams) }, response);
				assert.equal(response.statusCode, 200, JSON.stringify(response.body));
				assert.ok(Buffer.isBuffer(response.body));
				const zip = readZip(response.body);
				assert.equal(zip.ok, true, zip.error);
				assert.equal(zip.files.get("SKILL.md").toString("utf8"), document);
			};
			try {
				await flush();
				await download();
				const originalToken = probes.at(-1).downloadContext;
				const globalScope = probes.at(-1).scopes.find((s) => s.id === "global");
				assert.equal(globalScope.authorized, false);
				findButton(ui.container, "授权访问").click();
				assert.equal(ui.sent.at(-1).action, "skill-import:grant");
				await flush();
				assert.deepEqual(requested, [globalScope.path]);
				assert.equal(typeof probes.at(-1).downloadContext, "string", "授权回包也必须携带下载句柄");
				assert.notEqual(probes.at(-1).downloadContext, originalToken, "授权后应生成新句柄");
				assert.equal(probes.at(-1).scopes.find((s) => s.id === "global").authorized, allowed);
				await download();
				assert.equal(reads.length, 2, "授权前后的下载都必须成功且指向原项目");
			} finally { ui.cleanup(); dispose(); }
		});
	}

	it("切换对话会清掉旧手动需求与旧推荐；未知状态不伪装成已启用", () => {
		const ui = mountView();
		try {
			ui.emit({ type: "probe", data: { cwd: "/tmp/demo-project", conversationId: "a", scopes: SCOPES } });
			ui.emit(recommendPayload());
			const demand = findInput(ui.container, "这次要做的事");
			demand.value = "旧任务"; demand.dispatch("input");
			ui.emit({ type: "context-changed" });
			assert.equal(ui.sent.at(-1).action, "skill-import:probe");
			ui.emit({ type: "probe", data: { cwd: "/tmp/demo-project", conversationId: "b", scopes: SCOPES } });
			assert.equal(demand.value, "");
			assert.match(ui.text(), /对话或项目已切换/);
			findButton(ui.container, "重新推荐").click();
			assert.equal(ui.sent.at(-1).q, undefined);
			ui.emit(recommendPayload({ items: [], pinned: [], installedHits: [{ name: "unknown-skill", status: "unknown", note: "未知" }], reload: { items: [] } }));
			assert.match(ui.text(), /状态未验证/);
		} finally { ui.cleanup(); }
	});

	it("卡片显示文档限制与未验证依赖；不同来源先预览精确 ref/path", () => {
		const ui = mountView();
		try {
			ui.emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			const data = recommendPayload({ pinned: [] });
			Object.assign(data.data.items[0], { limits: ["不支持 OCR"], deps: ["pypdf"], variants: [{ repo: "other/repo", path: "tools/pdf", ref: "v2" }] });
			ui.emit(data);
			assert.match(ui.text(), /文档限制：不支持 OCR/);
			assert.match(ui.text(), /文档依赖（未验证）：pypdf/);
			assert.match(ui.text(), /原文依据/);
			findButton(ui.container, "预览 other/repo#v2/tools/pdf").click();
			assert.deepEqual(ui.sent.at(-1), { action: "skill-import:preview", source: "other/repo#v2", path: "tools/pdf", scopeId: "project", projectDir: "/tmp/demo-project" });
		} finally { ui.cleanup(); }
	});

	it("多候选仓库：搜索 + 分页，不再只给前 40 个", () => {
		const { container, emit, sent, cleanup } = mountView();
		try {
			const candidates = Array.from({ length: 60 }, (_, i) => ({
				label: `skill-${String(i).padStart(2, "0")}`,
				path: `skills/skill-${String(i).padStart(2, "0")}`,
			}));
			findButton(container, "导入").click();
			emit({
				type: "preview",
				data: { ok: true, needsPick: true, token: "t1", candidates, source: { label: "GitHub · o/r" }, scopes: SCOPES },
			});

			const chips = () => findAll(container, (el) => el.className.includes("si-chip") && /^skill-\d+$/.test(el.textContent.trim()));
			assert.equal(chips().length, 24, "第一页 24 个");
			assert.match(container.textContent, /1–24 \/ 60/);

			findButton(container, "下一页").click();
			assert.match(container.textContent, /25–48 \/ 60/);

			const search = findInput(container, "搜索 60 个候选技能");
			search.value = "skill-05";
			search.dispatch("input");
			assert.deepEqual(chips().map((c) => c.textContent), ["skill-05"]);

			chips()[0].click();
			assert.deepEqual(sent.at(-1), {
				action: "skill-import:preview",
				token: "t1",
				path: "skills/skill-05",
				scopeId: "project",
			});
		} finally {
			cleanup();
		}
	});

	it("粘贴多行 SKILL.md 时自动加 text: 前缀", () => {
		const { container, sent, cleanup } = mountView();
		try {
			findButton(container, "导入").click();
			const input = findInput(container, "owner/repo");
			input.value = "---\nname: my-skill\ndescription: 当需要时使用\n---\n正文";
			findButton(container, "预览").click();
			const last = sent.at(-1);
			assert.equal(last.action, "skill-import:preview");
			assert.match(last.source, /^text:\n---\nname: my-skill/);
		} finally {
			cleanup();
		}
	});

	it("高级区域放着落点、索引、来源、健康检查；重新推荐不强制重建索引", () => {
		const { container, emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(recommendPayload());
			assert.ok(findButton(container, "更新技能库"), "高级里应有更新技能库");
			assert.ok(findButton(container, "检查全部技能"), "高级里应有健康检查");
			assert.match(container.textContent, /当前项目：demo-project/);

			sent.length = 0;
			findButton(container, "重新推荐").click();
			const last = sent.at(-1);
			assert.equal(last.action, "skill-import:recommend");
			assert.ok(!last.force, "重新推荐应复用索引");

			sent.length = 0;
			findButton(container, "更新技能库").click();
			assert.equal(sent.at(-1).force, true, "更新技能库才重建索引");
		} finally {
			cleanup();
		}
	});

	it("首次没有索引时按钮变成「建立索引并推荐」", () => {
		const { container, emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit({ type: "recommend", data: { ok: true, needsIndex: true, items: [], pinned: [], installedHits: [], indexCount: 0, task: null } });
			const b = findButton(container, "建立索引并推荐");
			assert.ok(b);
			sent.length = 0;
			b.click();
			assert.equal(sent.at(-1).force, true);
		} finally {
			cleanup();
		}
	});
});

describe("推荐安装不会永远卡在「安装中」", () => {
	const installItem = () => recommendPayload({ pinned: [], installedHits: [], reload: { items: [] } });
	const clickInstall = (container) => {
		const b = findAll(container, (el) => el.tagName === "BUTTON" && /^安装到/.test(el.textContent.trim()))[0];
		assert.ok(b, "应该有安装按钮");
		b.click();
		return b;
	};

	it("失败会恢复按钮并就地说明原因", () => {
		const { container, emit, cleanup, text } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(installItem());
			const btnEl = clickInstall(container);
			assert.equal(btnEl.disabled, true);
			assert.equal(btnEl.textContent, "安装中…");
			assert.ok(findButton(container, "取消"), "安装中应该能取消");

			emit({ type: "recommend-install", data: { ok: false, error: "拉取仓库失败：fetch failed" } });
			assert.equal(btnEl.disabled, false, "失败后按钮必须恢复");
			assert.match(btnEl.textContent, /^安装到/);
			assert.match(text(), /安装失败：拉取仓库失败/);
			assert.ok(!findButton(container, "取消"));
		} finally {
			cleanup();
		}
	});

	it("取消后迟到回包不会把卡片改回已安装", () => {
		const { container, emit, sent, cleanup, text } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(installItem());
			clickInstall(container);
			const rid = sent.at(-1).requestId;
			assert.ok(rid, "安装请求应带 requestId");

			findButton(container, "取消").click();
			assert.match(text(), /已取消等待/);
			emit({ type: "recommend-install", requestId: rid, data: { ok: true, name: "pdf-tools" } });
			assert.match(text(), /已取消等待/, "迟到回包应被忽略");
		} finally {
			cleanup();
		}
	});

	it("超过 45 秒给出「慢」提示，计时器一直在走", () => {
		const { container, emit, cleanup, text } = mountView();
		const clock = mock.timers;
		try {
			clock.enable({ apis: ["setTimeout", "setInterval", "Date"] });
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			emit(installItem());
			clickInstall(container);
			clock.tick(3000);
			assert.match(text(), /已等待 [23]s/);
			clock.tick(43_000);
			assert.match(text(), /比预期慢/);
		} finally {
			clock.reset();
			cleanup();
		}
	});
});

describe("项目目录显式指定", () => {
	it("摸不到项目时给出输入框；填绝对路径后请求都带上 projectDir", () => {
		const { container, emit, sent, cleanup, text } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "", conversationId: "c1", scopes: [SCOPES[0]] } });
			assert.match(text(), /宿主没给插件本标签页的项目目录/);
			const input = findInput(container, "项目目录");
			assert.ok(input, "应该有项目目录输入框");
			input.value = "relative/path";
			findButton(container, "使用此目录").click();
			assert.match(text(), /要填绝对路径/);
			input.value = "/Users/sereden/Documents/ppo-control/";
			findButton(container, "使用此目录").click();
			const probe = sent.filter((p) => p.action === "skill-import:probe").at(-1);
			assert.equal(probe.projectDir, "/Users/sereden/Documents/ppo-control");
			assert.ok(sent.filter((p) => p.action === "skill-import:list").at(-1).projectDir);
		} finally {
			cleanup();
		}
	});

	it("已识别的项目目录会填进输入框并直接随请求发送", () => {
		const { container, emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", conversationId: "c1", scopes: SCOPES } });
			emit(recommendPayload());
			assert.equal(findInput(container, "项目目录").value, "/tmp/demo-project");
			findButton(container, "重新推荐").click();
			assert.equal(sent.at(-1).projectDir, "/tmp/demo-project");
		} finally {
			cleanup();
		}
	});
});

describe("自动识别每个项目的目录", () => {
	it("从页面桥 getCwd 取到项目目录，并自动补一次 probe", () => {
		globalThis.window = { __piWebUiHost: { getCwd: () => "/Users/sereden/Documents/ppo-control" } };
		const { emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "", conversationId: "c1", scopes: [SCOPES[0]] } });
			const auto = sent.filter((p) => p.action === "skill-import:probe").at(-1);
			assert.equal(auto.projectDir, "/Users/sereden/Documents/ppo-control");
			assert.equal(sent.filter((p) => p.action === "skill-import:probe").length, 2, "只自动补一次");
			// 补回来的 probe（服务端仍认不出）不应再次触发
			emit({ type: "probe", data: { cwd: "", conversationId: "c1", scopes: [SCOPES[0]] } });
			assert.equal(sent.filter((p) => p.action === "skill-import:probe").length, 2);
		} finally {
			cleanup();
			delete globalThis.window;
		}
	});

	it("页面桥与上次服务端识别值不同时，以页面桥为准并补一次 probe", () => {
		globalThis.window = { __piWebUiHost: { getCwd: () => "/somewhere/else" } };
		const { container, emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/tmp/demo-project", scopes: SCOPES } });
			const auto = sent.filter((p) => p.action === "skill-import:probe");
			assert.equal(auto.length, 2, "桥值不同 → 补一次 probe");
			assert.equal(auto.at(-1).projectDir, "/somewhere/else");
			emit({ type: "probe", data: { cwd: "/somewhere/else", scopes: SCOPES } });
			emit(recommendPayload());
			findButton(container, "重新推荐").click();
			assert.equal(sent.at(-1).projectDir, "/somewhere/else");
			assert.equal(sent.filter((p) => p.action === "skill-import:probe").length, 2, "对齐后不再补");
		} finally {
			cleanup();
			delete globalThis.window;
		}
	});

	it("页面桥缺失时退回 localStorage 的当前工作区", () => {
		globalThis.localStorage = { getItem: (k) => (k === "pi-web-last-cwd" ? "/Users/sereden/Documents/ppo-control/" : null) };
		const { emit, sent, cleanup } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "", conversationId: "c1", scopes: [SCOPES[0]] } });
			assert.equal(sent.filter((p) => p.action === "skill-import:probe").at(-1).projectDir, "/Users/sereden/Documents/ppo-control");
		} finally {
			cleanup();
			delete globalThis.localStorage;
		}
	});
});

describe("已安装里的项目卡片", () => {
	const listPayload = (over = {}) => ({
		type: "list",
		data: {
			scopes: [
				{ id: "global", label: "全局 · Pi", writable: true, authorized: true, skills: [{ name: "g1" }] },
				{ id: "project", label: "项目 · .pi", writable: true, authorized: true, path: "/Users/sereden/Documents/ppo-control/.pi/skills", skills: [{ name: "p1" }, { name: "p2" }] },
			],
			...over,
		},
	});

	it("项目 0 个技能也要显示落点与数量", () => {
		const { emit, cleanup, text } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/Users/sereden/Documents/ppo-control", scopes: SCOPES } });
			emit({ type: "list", data: { scopes: [{ id: "project", label: "项目 · .pi", writable: true, authorized: true, path: "/Users/sereden/Documents/ppo-control/.pi/skills", skills: [] }] } });
			assert.match(text(), /项目 · ppo-control/);
			assert.match(text(), /ppo-control\/\.pi\/skills/);
			assert.match(text(), /已读 0 个技能/);
		} finally {
			cleanup();
		}
	});

	it("未授权时在已安装里就能授权，授权后自动刷新清单", () => {
		const { container, emit, sent, cleanup, text } = mountView();
		try {
			emit({ type: "probe", data: { cwd: "/Users/sereden/Documents/ppo-control", scopes: SCOPES } });
			emit({
				type: "list",
				data: { scopes: [{ id: "project", label: "项目 · .pi", writable: true, authorized: false, path: "/Users/sereden/Documents/ppo-control/.pi/skills", skills: [], error: "目录未授权" }] },
			});
			assert.match(text(), /目录未授权/);
			const grant = findButton(container, "授权访问");
			grant.click();
			assert.deepEqual(sent.at(-1), { action: "skill-import:grant", path: "/Users/sereden/Documents/ppo-control/.pi/skills", projectDir: "/Users/sereden/Documents/ppo-control" });
			emit({ type: "probe", data: { cwd: "/Users/sereden/Documents/ppo-control", scopes: SCOPES } });
			assert.equal(sent.at(-1).action, "skill-import:list", "授权完要重新拉清单");
		} finally {
			cleanup();
		}
	});
});
