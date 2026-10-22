/**
 * impl —— 服务端实现（CJS）。
 *
 * 为什么是 CJS：宿主 plugins_reload 只对入口 index.mjs 做 `?e=N` 缓存击穿，
 * ESM 子模块的缓存**永不失效**（同进程里改完还是旧代码）。CJS 的 require.cache
 * 可以手动清，于是入口每次 activate 前清一遍本目录缓存，热重载才是真的。
 */
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const { createHttp } = require("./http.cjs");
const { createOps } = require("./ops.cjs");
const { createImportService } = require("./import-service.cjs");
const { registerAgentSurface } = require("./agent-bridge.cjs");
const { writeZip } = require("../core/zip-write.cjs");
const { createRecommendService } = require("./recommend.cjs");

const HOME = homedir();
/** Pi 的 agent 目录：优先 env（pi 自己也认这个），否则 ~/.pi/agent。 */
const AGENT_DIR = (process.env.PI_CODING_AGENT_DIR ?? "").trim() || join(HOME, ".pi", "agent");

const MANIFEST = (() => {
	try {
		return JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));
	} catch {
		return {};
	}
})();
const NET_ALLOWLIST = Array.isArray(MANIFEST.netAllowlist) ? MANIFEST.netAllowlist : [];

/** 与 Pi 的发现顺序保持一致的落点清单（前两个是主入口，后两个是兼容位置）。 */
function scopesFor(cwd) {
	return [
		{ id: "global", label: "全局 · Pi", writable: true, path: join(AGENT_DIR, "skills") },
		{ id: "project", label: "项目 · .pi", writable: true, path: join(cwd, ".pi", "skills") },
		{ id: "agents-global", label: "全局 · .agents", writable: false, path: join(HOME, ".agents", "skills") },
		{ id: "agents-project", label: "项目 · .agents", writable: false, path: join(cwd, ".agents", "skills") },
	];
}

function errText(err) {
	return err instanceof Error ? err.message : String(err);
}

function isDenied(msg) {
	return /未授权|not authorized|requestAccess|EACCES|EPERM/i.test(msg);
}

async function describeScope(host, scope) {
	const out = {
		...scope,
		skills: [],
		skillFiles: [],
		disabledSkills: [],
		disabledFiles: [],
		count: 0,
		authorized: false,
		exists: false,
	};
	try {
		const entries = await host.fs.listPath(scope.path);
		out.authorized = true;
		out.exists = true;
		// 与 Pi 的扫描口径一致："." 开头的条目不参与（备份/暂存目录就是靠这个隐身的）
		out.skills = entries
			.filter((e) => e.type === "dir" && !e.name.startsWith("."))
			.map((e) => e.name)
			.sort();
		out.skillFiles = entries
			.filter((e) => e.type === "file" && e.name.endsWith(".md") && !e.name.startsWith("."))
			.map((e) => e.name)
			.sort();
		out.count = out.skills.length;
		// 停用区（.disabled/）：Pi 不扫描点开头目录，但我们要能列出来
		try {
			const parked = await host.fs.listPath(join(scope.path, ".disabled"));
			out.disabledSkills = parked
				.filter((e) => e.type === "dir" && !e.name.startsWith("."))
				.map((e) => e.name)
				.sort();
			out.disabledFiles = parked
				.filter((e) => e.type === "file" && e.name.endsWith(".md"))
				.map((e) => e.name)
				.sort();
		} catch {
			/* 没有停用区 */
		}
	} catch (err) {
		const msg = errText(err);
		out.error = msg.slice(0, 300);
		out.authorized = !isDenied(msg);
		out.exists = out.authorized && !/ENOENT|no such file/i.test(msg);
	}
	return out;
}

async function probe(host) {
	const cwd = String(host.cwd ?? "");
	const scopes = [];
	for (const scope of scopesFor(cwd)) scopes.push(await describeScope(host, scope));
	let granted = [];
	try {
		granted = host.fs.authorizedDirs();
	} catch {
		/* 无 fs 能力时忽略 */
	}
	return {
		cwd,
		agentDir: AGENT_DIR,
		dataDir: String(host.dataDir ?? ""),
		node: typeof process !== "undefined" ? process.version : "",
		scopes,
		granted,
		at: Date.now(),
	};
}

async function activate(host) {
	host.log("info", "skill-import 已激活", { agentDir: AGENT_DIR, netAllowlist: NET_ALLOWLIST });

	const http = createHttp({ host, allowlist: NET_ALLOWLIST });
	const ops = createOps(host);
	const getScopes = async () => (await probe(host)).scopes;
	const service = createImportService({ host, http, ops, getScopes });
	const recommendService = createRecommendService({ host, http, getScopes, importService: service });

	// 对话侧入口：ai 工具 + 斜杠命令（和页面共用同一个 service）
	const offAgent = registerAgentSurface({ host, service });

	const handle = async (action, payload) => {
		switch (action) {
			case "skill-import:probe":
				return { type: "probe", data: await probe(host) };
			case "skill-import:grant": {
				const dir = String(payload?.path ?? "").trim();
				if (!dir) return { type: "error", message: "缺少目录" };
				const ok = await host.fs.requestAccess(dir, "技能导入需要读写这个技能目录");
				host.notify(ok ? "info" : "warning", ok ? `已授权：${dir}` : `授权被拒绝：${dir}`);
				return { type: "probe", data: await probe(host) };
			}
			case "skill-import:preview":
				return { type: "preview", data: await service.preview(payload ?? {}) };
			case "skill-import:install":
				return { type: "install", data: await service.install(payload ?? {}) };
			case "skill-import:rollback":
				return { type: "rollback", data: await service.rollback(payload ?? {}) };
			case "skill-import:list":
				return { type: "list", data: await service.listInstalled() };
			case "skill-import:check-updates":
				return { type: "updates", data: await service.checkUpdates() };
			case "skill-import:update":
				return { type: "update", data: await service.update(payload ?? {}) };
			case "skill-import:health":
				return { type: "health", data: await service.health() };
			case "skill-import:set-enabled":
				return { type: "toggle", data: await service.setEnabled(payload ?? {}) };
			case "skill-import:remove":
				return { type: "remove", data: await service.removeSkill(payload ?? {}) };
			case "skill-import:recommend":
				return {
					type: "recommend",
					data: await recommendService.recommend({ force: payload?.force === true, q: payload?.q }),
				};
			case "skill-import:recommend-install":
				return { type: "recommend-install", data: await recommendService.installRecommended(payload ?? {}) };
			case "skill-import:sources":
				return { type: "sources", data: await recommendService.listSources() };
			case "skill-import:source-add":
				return { type: "source-change", data: await recommendService.addSource(payload ?? {}) };
			case "skill-import:source-remove":
				return { type: "source-change", data: await recommendService.removeSource(payload ?? {}) };
			case "skill-import:discover":
				return { type: "discover", data: await recommendService.discover() };
			case "skill-import:feedback":
				return { type: "feedback", data: recommendService.setFeedback(payload ?? {}) };
			default:
				return null;
		}
	};

	// 客户端 → 服务端（窄通道）
	const offMessage = host.onMessage(async (payload) => {
		const action = String(payload?.action ?? "");
		try {
			const reply = await handle(action, payload ?? {});
			if (reply) host.broadcast(reply);
		} catch (err) {
			host.log("error", `${action || "(空动作)"} 失败`, errText(err));
			host.broadcast({ type: "error", action, message: errText(err) });
		}
	});

	// HTTP：给 curl / agent tool / 页面共存
	const json = (res, data, status = 200) => {
		res.status(status).json(data);
	};
	const safe = (fn) => async (req, res) => {
		try {
			await fn(req, res);
		} catch (err) {
			host.log("error", "route 失败", errText(err));
			if (!res.headersSent) json(res, { ok: false, error: errText(err) }, 500);
		}
	};

	const offRoutes = [
		host.route(
			"GET",
			"/probe",
			safe(async (_req, res) => json(res, await probe(host))),
		),
		host.route(
			"POST",
			"/preview",
			safe(async (req, res) => json(res, await service.preview(req.body ?? {}))),
		),
		host.route(
			"POST",
			"/install",
			safe(async (req, res) => json(res, await service.install(req.body ?? {}))),
		),
		host.route(
			"POST",
			"/rollback",
			safe(async (req, res) => json(res, await service.rollback(req.body ?? {}))),
		),
		host.route(
			"GET",
			"/list",
			safe(async (_req, res) => json(res, await service.listInstalled())),
		),
		host.route(
			"GET",
			"/check-updates",
			safe(async (_req, res) => json(res, await service.checkUpdates())),
		),
		host.route(
			"POST",
			"/update",
			safe(async (req, res) => json(res, await service.update(req.body ?? {}))),
		),
		host.route(
			"GET",
			"/health",
			safe(async (_req, res) => json(res, await service.health())),
		),
		host.route(
			"POST",
			"/set-enabled",
			safe(async (req, res) => json(res, await service.setEnabled(req.body ?? {}))),
		),
		host.route(
			"POST",
			"/remove",
			safe(async (req, res) => json(res, await service.removeSkill(req.body ?? {}))),
		),
		host.route(
			"GET",
			"/sources",
			safe(async (_req, res) => json(res, await recommendService.listSources())),
		),
		host.route(
			"POST",
			"/sources",
			safe(async (req, res) => {
				const body = req.body ?? {};
				const out = body.action === "remove" ? await recommendService.removeSource(body) : await recommendService.addSource(body);
				json(res, out);
			}),
		),
		host.route(
			"GET",
			"/feedback",
			safe(async (_req, res) => json(res, recommendService.listFeedback())),
		),
		host.route(
			"POST",
			"/feedback",
			safe(async (req, res) => json(res, recommendService.setFeedback(req.body ?? {}))),
		),
		host.route(
			"GET",
			"/discover-sources",
			safe(async (_req, res) => json(res, await recommendService.discover())),
		),
		host.route(
			"GET",
			"/recommend",
			safe(async (req, res) =>
				json(res, await recommendService.recommend({ force: req.query?.force === "1", q: req.query?.q })),
			),
		),
		host.route(
			"POST",
			"/recommend-install",
			safe(async (req, res) => json(res, await recommendService.installRecommended(req.body ?? {}))),
		),
		host.route(
			"GET",
			"/download",
			safe(async (req, res) => {
				const q = req.query ?? {};
				const out = await service.readSkill({ name: q.name, scopeId: q.scopeId });
				if (!out.ok) {
					json(res, out, 404);
					return;
				}
				const zip = writeZip(out.files);
				const ascii = String(out.name).replace(/[^A-Za-z0-9._-]/g, "_");
				res.setHeader("Content-Type", "application/zip");
				res.setHeader(
					"Content-Disposition",
					`attachment; filename="${ascii}.zip"; filename*=UTF-8''${encodeURIComponent(out.name)}.zip`,
				);
				res.setHeader("Content-Length", String(zip.length));
				res.end(zip);
			}),
		),
	];

	// 切换项目后落点跟着变
	const offCwd = host.onCwdChange(async () => {
		try {
			host.broadcast({ type: "probe", data: await probe(host) });
		} catch (err) {
			host.log("error", "cwd 变更后探测失败", errText(err));
		}
	});

	return () => {
		offAgent();
		offMessage();
		offCwd();
		for (const off of offRoutes) {
			try {
				off();
			} catch {
				/* ignore */
			}
		}
	};
}

module.exports = { activate, probe, errText, scopesFor, AGENT_DIR, NET_ALLOWLIST };
