/**
 * impl —— 服务端实现（CJS）。
 *
 * 为什么是 CJS：宿主 plugins_reload 只对入口 index.mjs 做 `?e=N` 缓存击穿，
 * ESM 子模块的缓存**永不失效**（同进程里改完还是旧代码）。CJS 的 require.cache
 * 可以手动清，于是入口每次 activate 前清一遍本目录缓存，热重载才是真的。
 */
const { readFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { homedir } = require("node:os");
const { join } = require("node:path");

const { createHttp } = require("./http.cjs");
const { createOps } = require("./ops.cjs");
const { createImportService } = require("./import-service.cjs");
const { registerAgentSurface } = require("./agent-bridge.cjs");
const { writeZip } = require("../core/zip-write.cjs");
const { createRecommendService } = require("./recommend.cjs");
const { createRequestContext } = require("./context.cjs");

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
		...(cwd ? [{ id: "project", label: "项目 · .pi", writable: true, path: join(cwd, ".pi", "skills") }] : []),
		{ id: "agents-global", label: "全局 · .agents", writable: false, path: join(HOME, ".agents", "skills") },
		...(cwd ? [{ id: "agents-project", label: "项目 · .agents", writable: false, path: join(cwd, ".agents", "skills") }] : []),
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
		conversationId: host.getActiveConversation?.()?.conversationId ?? "",
		agentDir: AGENT_DIR,
		dataDir: String(host.dataDir ?? ""),
		node: typeof process !== "undefined" ? process.version : "",
		scopes,
		granted,
		at: Date.now(),
	};
}

async function activate(baseHost) {
	const requestContext = createRequestContext(baseHost);
	const host = requestContext.host;
	host.log("info", "skill-import 已激活", { agentDir: AGENT_DIR, netAllowlist: NET_ALLOWLIST });

	const http = createHttp({ host, allowlist: NET_ALLOWLIST });
	const ops = createOps(host);
	const getScopes = async () => (await probe(host)).scopes;
	const service = createImportService({ host, http, ops, getScopes });
	const recommendService = createRecommendService({ host, http, getScopes, importService: service });

	// 变更记账：装完/启停后列表里能直接显示「等待重新加载」
	const noteChange = (name, kind, scopeId) => {
		try {
			return recommendService.noteChange({ name, kind, scopeId });
		} catch (err) {
			host.log("warn", "记录重载待办失败", errText(err));
			return { ok: false, reload: undefined };
		}
	};
	const changed = (data, kind) => data.ok && !data.unchanged
		? { ...data, reload: noteChange(data.name, kind, data.scopeId).reload }
		: data;
	// 下载走 HTTP，用短期随机句柄携带已确认的项目上下文，不重新读全局 cwd。
	const downloadContexts = new Map();
	const rememberDownloadContext = () => {
		for (const [key, value] of downloadContexts) if (value.expires <= Date.now()) downloadContexts.delete(key);
		if (downloadContexts.size >= 200) downloadContexts.delete(downloadContexts.keys().next().value);
		const token = randomUUID();
		downloadContexts.set(token, { context: requestContext.capture(), expires: Date.now() + 15 * 60_000 });
		return token;
	};
	// 所有对外探测回包使用同一契约，授权成功或拒绝都不能让页面丢失下载句柄。
	// 内部 getScopes 继续使用纯 probe，避免每次读落点都创建句柄。
	const probeWithDownloadContext = async () => ({ ...await probe(host), downloadContext: rememberDownloadContext() });
	const FEEDBACK_VERBS = new Set(["ignore", "unignore", "pin", "unpin"]);
	const isFeedbackVerb = (value) => FEEDBACK_VERBS.has(String(value ?? "").trim().toLowerCase());

	// 对话侧入口：ai 工具 + 斜杠命令（和页面共用同一个 service）
	const offAgent = registerAgentSurface({ host, service });

	const handle = async (action, payload) => {
		if (!host.cwd && /project/.test(String(payload?.scopeId ?? ""))) {
			return { type: "error", message: "无法确认当前对话的项目目录；请重新打开技能面板，或明确选择全局安装。" };
		}
		switch (action) {
			case "skill-import:probe":
				return { type: "probe", data: await probeWithDownloadContext() };
			case "skill-import:grant": {
				const dir = String(payload?.path ?? "").trim();
				if (!dir) return { type: "error", message: "缺少目录" };
				const ok = await host.fs.requestAccess(dir, "技能导入需要读写这个技能目录");
				host.notify(ok ? "info" : "warning", ok ? `已授权：${dir}` : `授权被拒绝：${dir}`);
				return { type: "probe", data: await probeWithDownloadContext() };
			}
			case "skill-import:preview":
				return { type: "preview", data: await service.preview(payload ?? {}) };
			case "skill-import:install": {
				const data = await service.install(payload ?? {});
				return { type: "install", data: changed(data, "install") };
			}
			case "skill-import:rollback":
				return { type: "rollback", data: changed(await service.rollback(payload ?? {}), "rollback") };
			case "skill-import:list":
				return { type: "list", data: await service.listInstalled() };
			case "skill-import:check-updates":
				return { type: "updates", data: await service.checkUpdates() };
			case "skill-import:update": {
				const data = await service.update(payload ?? {});
				return { type: "update", data: changed(data, "update") };
			}
			case "skill-import:health":
				return { type: "health", data: await service.health() };
			case "skill-import:set-enabled": {
				const data = await service.setEnabled(payload ?? {});
				return { type: "toggle", data: changed(data, data.enabled ? "enable" : "disable") };
			}
			case "skill-import:remove": {
				const data = await service.removeSkill(payload ?? {});
				return { type: "remove", data: changed(data, "remove") };
			}
			case "skill-import:recommend":
				return {
					type: "recommend",
					data: await recommendService.recommend({
						force: payload?.force === true,
						q: payload?.q ?? payload?.query,
					}),
				};
			case "skill-import:recommend-install": {
				const data = await recommendService.installRecommended(payload ?? {});
				// 回显 requestId：页面取消后重试时，能区分是哪一次请求的结果
				return { type: "recommend-install", requestId: payload?.requestId, data };
			}
			case "skill-import:ack-reload":
				return { type: "ack-reload", data: recommendService.ackReload() };
			case "skill-import:sources":
				return { type: "sources", data: await recommendService.listSources() };
			case "skill-import:source-add":
				return { type: "source-change", data: await recommendService.addSource(payload ?? {}) };
			case "skill-import:source-remove":
				return { type: "source-change", data: await recommendService.removeSource(payload ?? {}) };
			case "skill-import:discover":
				return { type: "discover", data: await recommendService.discover() };
			case "skill-import:feedback": {
				// 客户端把操作放在 op（路由字段叫 action），HTTP 侧习惯用 action；这里统一成 op
				const op = payload?.op ?? payload?.verb ?? payload?.feedbackAction ?? payload?.feedback?.op;
				const feedbackAction = op !== undefined ? op : isFeedbackVerb(payload?.action) ? payload.action : undefined;
				if (!feedbackAction) {
					return { type: "feedback", data: { ok: false, error: "未知操作（ignore / unignore / pin / unpin）", received: String(payload?.action ?? "") } };
				}
				return {
					type: "feedback",
					data: recommendService.setFeedback({ action: feedbackAction, name: payload?.name, id: payload?.id }),
				};
			}
			default:
				return null;
		}
	};

	// 客户端 → 服务端（窄通道）
	const offMessage = host.onMessage(async (payload, from) => {
		const action = String(payload?.action ?? "");
		const replyToSender = (reply) => from && typeof host.sendTo === "function" ? host.sendTo(from, reply) : host.broadcast(reply);
		try {
			await requestContext.run(from, async () => {
				const reply = await handle(action, payload ?? {});
				if (!reply) return;
				// 一定要回包：静默丢弃会让页面永远停在「安装中」。旧对话的回包带 conversationId，
				// 由页面自己去重，而不是服务端扣住不发。
				const conversationId = requestContext.capture().snapshot?.conversationId ?? "";
				replyToSender(conversationId ? { ...reply, conversationId } : reply);
			}, { projectDir: payload?.projectDir });
		} catch (err) {
			host.log("error", `${action || "(空动作)"} 失败`, errText(err));
			replyToSender({ type: "error", action, message: errText(err) });
		}
	});

	// HTTP：给 curl / agent tool / 页面共存
	const json = (res, data, status = 200) => {
		res.status(status).json(data);
	};
	const safe = (fn) => async (req, res) => {
		try {
			// HTTP 调用没有 clientId：允许 ?projectDir= 或 body.projectDir 指定项目落点
			await requestContext.withProjectDir(req.query?.projectDir ?? req.body?.projectDir, () => fn(req, res));
		} catch (err) {
			host.log("error", "route 失败", errText(err));
			if (!res.headersSent) json(res, { ok: false, error: errText(err) }, 500);
		}
	};

	const offRoutes = [
		host.route(
			"GET",
			"/probe",
			safe(async (req, res) => json(res, await requestContext.withProjectDir(req.query?.projectDir, () => probeWithDownloadContext()))),
		),
		host.route(
			"POST",
			"/preview",
			safe(async (req, res) => json(res, await service.preview(req.body ?? {}))),
		),
		host.route(
			"POST",
			"/install",
			safe(async (req, res) => json(res, (await handle("skill-import:install", req.body ?? {})).data)),
		),
		host.route(
			"POST",
			"/rollback",
			safe(async (req, res) => json(res, (await handle("skill-import:rollback", req.body ?? {})).data)),
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
			safe(async (req, res) => json(res, (await handle("skill-import:update", req.body ?? {})).data)),
		),
		host.route(
			"GET",
			"/health",
			safe(async (_req, res) => json(res, await service.health())),
		),
		host.route(
			"POST",
			"/set-enabled",
			safe(async (req, res) => json(res, (await handle("skill-import:set-enabled", req.body ?? {})).data)),
		),
		host.route(
			"POST",
			"/remove",
			safe(async (req, res) => json(res, (await handle("skill-import:remove", req.body ?? {})).data)),
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
			"/reload",
			safe(async (_req, res) => json(res, { ok: true, ...recommendService.pending() })),
		),
		host.route(
			"POST",
			"/ack-reload",
			safe(async (_req, res) => json(res, recommendService.ackReload())),
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
				const saved = q.context ? downloadContexts.get(String(q.context)) : null;
				if (q.context && (!saved || saved.expires <= Date.now())) {
					json(res, { ok: false, error: "下载上下文已过期，请刷新技能面板后重试" }, 410);
					return;
				}
				const read = () => service.readSkill({ name: q.name, scopeId: q.scopeId });
				const out = saved ? await requestContext.withContext(saved.context, read) : await read();
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
	const contextChanged = () => host.broadcast({ type: "context-changed" });
	const offCwd = host.onCwdChange(contextChanged);
	const offConversation = host.onConversationChanged?.(contextChanged);

	return () => {
		offAgent();
		offMessage();
		offCwd();
		offConversation?.();
		downloadContexts.clear();
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
