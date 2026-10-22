/**
 * project-dir —— 「这个标签页现在属于哪个项目」的解析策略链。
 *
 * 背景：pi-web 给插件的**服务端**会话快照里没有 cwd，而插件面板跑在页面里，
 * 能看到浏览器侧的状态。宿主前端没有公开「把 cwd 交给插件」的接口，所以这里把
 * 可用信号按可信度排成一条链，逐个尝试；任何一条失效都只是降级，不会装错目录。
 *
 * 设计要点：
 * - 每个策略单独可测（resolve(env) 是纯函数，env 可注入）；
 * - 只返回绝对路径，去掉尾部斜杠；相对路径、空值一律忽略；
 * - 带 source / confidence，面板能显示「这个目录是哪来的」；
 * - diagnose() 给出每条策略的原始结果，宿主升级改名时能一眼看出断在哪。
 */

/** 只接受绝对路径：/foo、/Users/x（不接受相对路径、file:// URI）。 */
export function normalizePath(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed.startsWith("/")) return "";
	const clean = trimmed.replace(/\/+$/, "");
	return clean === "" ? "" : clean;
}

function call(fn) {
	try {
		return typeof fn === "function" ? fn() : "";
	} catch {
		return "";
	}
}

/** 页面桥：当前对话的工作区（最可信）。 */
function fromHostCwd(env) {
	return normalizePath(call(env.host?.getCwd));
}

/** 页面桥：按当前会话 id 在 listSessions 里找它自己的 cwd。 */
function fromHostSession(env) {
	const id = call(env.host?.getConversationId);
	if (!id) return "";
	const list = call(env.host?.listSessions);
	if (!Array.isArray(list)) return "";
	const hit = list.find((x) => x && x.id === id);
	return normalizePath(hit?.cwd);
}

/** 主界面把当前工作区记在 localStorage（pi-web-last-cwd）。 */
function fromLastCwd(env) {
	return normalizePath(call(() => env.storage?.getItem("pi-web-last-cwd")));
}

/** 最近项目列表里的第一项：只在它是唯一可信候选时使用（标记低置信）。 */
function fromRecentProject(env) {
	const raw = call(() => env.storage?.getItem("pi-web-recent-projects"));
	if (!raw) return "";
	try {
		const list = JSON.parse(raw);
		if (!Array.isArray(list) || list.length !== 1) return "";
		const first = list[0];
		return normalizePath(typeof first === "string" ? first : first?.path);
	} catch {
		return "";
	}
}

export const STRATEGIES = [
	{ id: "host.cwd", label: "页面桥 getCwd", confidence: "high", resolve: fromHostCwd },
	{ id: "host.session", label: "页面桥 listSessions", confidence: "high", resolve: fromHostSession },
	{ id: "storage.last-cwd", label: "本地记录 last-cwd", confidence: "medium", resolve: fromLastCwd },
	{ id: "storage.recent-project", label: "最近项目（唯一）", confidence: "low", resolve: fromRecentProject },
];

/** 默认环境：浏览器里的 window / localStorage；Node 测试里可完全注入。 */
export function defaultEnv() {
	const g = globalThis;
	return {
		host: g.window?.__piWebUiHost ?? g.__piWebUiHost ?? null,
		storage: g.localStorage ?? null,
	};
}

/**
 * @param {ReturnType<typeof defaultEnv>} [env]
 */
export function createProjectResolver(env = null) {
	const read = () => env ?? defaultEnv();
	return {
		/** @returns {{path:string, source:string, sourceId:string, confidence:string}} */
		resolve() {
			const current = read();
			for (const strategy of STRATEGIES) {
				const path = strategy.resolve(current);
				if (path) {
					return { path, source: strategy.label, sourceId: strategy.id, confidence: strategy.confidence };
				}
			}
			return { path: "", source: "", sourceId: "", confidence: "none" };
		},
		/** 给面板/日志用的降级说明：每条策略拿到了什么（不打印完整路径以外的东西）。 */
		diagnose() {
			const current = read();
			return STRATEGIES.map((strategy) => ({
				id: strategy.id,
				label: strategy.label,
				value: strategy.resolve(current),
			}));
		},
	};
}
