/**
 * card —— 能力卡片：把 SKILL.md 变成「能解决什么任务 / 输入输出 / 限制 / 依赖」。
 *
 * 全部靠规则从 description + 正文前半段提取；**没有提到的字段标 unknown，
 * 不编造**。LLM 精修是后续可选项（这一版不调用模型生成卡片）。
 */

const VERB = /提取|分析|生成|转换|比较|诊断|创建|读取|写入|检查|部署|搜索|抓取|整理|绘制|训练|评估|优化|修复|安装|配置|迁移|审查|测试|总结|翻译|识别|解析|导出|导入|监控|统计|清洗|标注|推荐|调试|extract|analy[sz]|generate|create|convert|compare|diagnos|read|write|check|deploy|search|fetch|scrap|summar|plot|train|evaluat|optimi[sz]|fix|build|run|install|configure|migrate|review|test|translat|recogni|pars|export|import|monitor|clean|annotat|recommend|debug|audit|render|design/i;

const LIMIT_HINT = /^(?:[-*]\s*)?(不支持|不能|无法|仅支持|限制|注意|cannot|does not|doesn't|not supported|only supports?|limitations?|note[:：])/i;

const DEPS = [
	/(?:pip3?|uv|poetry)\s+(?:install|add)\s+([\w.@/-]+)/gi,
	/npm\s+(?:i|install|add)\s+([\w@/.-]+)/gi,
	/(?:brew|apt-get|apt|dnf|yum)\s+install\s+([\w.@/-]+)/gi,
	/(?:pnpm|yarn)\s+(?:add|install)\s+([\w@/.-]+)/gi,
];

function clean(s, max = 120) {
	return String(s ?? "")
		.replace(/^[-*]\s*/, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function uniq(list, max) {
	const out = [];
	for (const item of list) {
		const v = clean(item);
		if (!v || out.includes(v)) continue;
		out.push(v);
		if (out.length >= max) break;
	}
	return out;
}

/** 描述/正文里的任务句：含动词的分句，长度 6–120。 */
function extractTasks(text, max = 4) {
	const clauses = String(text ?? "")
		.split(/[。；;!?\n]+|(?<=[a-z])\.\s/)
		.map((s) => clean(s, 160))
		.filter((s) => s.length >= 6 && s.length <= 160);
	const picked = [];
	for (const clause of clauses) {
		if (!VERB.test(clause)) continue;
		// 太长的句子再按逗号断一下
		for (const part of clause.split(/[，,]/)) {
			const p = clean(part, 120);
			if (p.length >= 6 && VERB.test(p) && !picked.includes(p)) picked.push(p);
			if (picked.length >= max) return picked;
		}
	}
	return picked;
}

/** description 里的「当…时使用」子句。 */
function extractScenarios(description, max = 3) {
	const text = String(description ?? "");
	const out = [];
	for (const m of text.matchAll(/(use (?:this|it)[^.]{0,80}|when(?:ever)?[^.]{0,80}|当[^。；]{0,60}|用于[^。；]{0,60}|适用于[^。；]{0,60})/gi)) {
		out.push(m[1]);
		if (out.length >= max) break;
	}
	return uniq(out, max);
}

/** 正文里的输入/输出说明。 */
function extractIo(body) {
	const text = String(body ?? "").slice(0, 4000);
	const grab = (re) => {
		const m = re.exec(text);
		return m ? clean(m[1], 100) : "";
	};
	const input = grab(/(?:输入|input)\s*[:：]\s*([^。；;\n]{2,100})/i);
	const output = grab(/(?:输出|output|returns?|返回)\s*[:：]\s*([^。；;\n]{2,100})/i);
	return { input: input ? [input] : [], output: output ? [output] : [] };
}

/** 限制/注意事项：正文里明确写的否定句。 */
function extractLimits(body, max = 3) {
	const lines = String(body ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const out = [];
	for (const line of lines) {
		if (!LIMIT_HINT.test(line)) continue;
		out.push(line.replace(/^[-*]\s*/, ""));
		if (out.length >= max) break;
	}
	return uniq(out, max);
}

/** 依赖 → 生态：从安装命令本身就能看出是 python 还是 node，比猜包名准。 */
const DEP_SOURCES = [
	{ re: /(?:pip3?|uv|poetry)\s+(?:install|add)\s+([\w.@/-]+)/gi, ecosystem: "python" },
	{ re: /npm\s+(?:i|install|add)\s+([\w@/.-]+)/gi, ecosystem: "node" },
	{ re: /(?:brew|apt-get|apt|dnf|yum)\s+install\s+([\w.@/-]+)/gi, ecosystem: "" },
	{ re: /(?:pnpm|yarn)\s+(?:add|install)\s+([\w@/.-]+)/gi, ecosystem: "node" },
];

/** 依赖：安装命令 + compatibility 字段。 */
function extractDeps(body, frontmatter, max = 6) {
	const text = String(body ?? "");
	const out = [];
	for (const re of DEPS) {
		for (const m of text.matchAll(re)) out.push(m[1]);
	}
	const compat = frontmatter?.compatibility;
	if (typeof compat === "string") out.push(`compat: ${compat}`);
	else if (Array.isArray(compat)) for (const c of compat) out.push(`compat: ${c}`);
	return uniq(out, max);
}

/**
 * @param {{name:string, description:string, body?:string, frontmatter?:object,
 *          repo?:string, path?:string, ref?:string}} args
 */
function buildCard({ name, description, body = "", frontmatter = {}, repo = "", path = "", ref = "" }) {
	const tasks = extractTasks(`${description}\n${String(body).slice(0, 1200)}`);
	const scenarios = extractScenarios(description);
	const io = extractIo(`${description}\n${body}`);
	const limits = extractLimits(body);
	const deps = extractDeps(body, frontmatter);
	const evidence = description ? [{ field: "description", section: "frontmatter.description", quote: description }] : [];
	for (const line of String(body).split(/\r?\n/)) {
		if (evidence.length >= 9) break;
		if (LIMIT_HINT.test(line.trim()) || /(?:输入|输出|input|output)\s*[:：]|(?:pip3?|uv|poetry|npm|pnpm|yarn|brew|apt(?:-get)?)\s+(?:install|add|i)\s+/i.test(line)) {
			evidence.push({ field: "requirements", section: "body", quote: line });
		}
	}
	// 每个依赖是从哪类安装命令里看出来的：pip → python，npm/yarn/pnpm → node
	const depEcosystems = {};
	for (const src of DEP_SOURCES) {
		if (!src.ecosystem) continue;
		for (const m of String(body ?? "").matchAll(src.re)) depEcosystems[m[1]] = src.ecosystem;
	}
	const unknown = [];
	if (tasks.length === 0) unknown.push("tasks");
	if (io.input.length === 0 && io.output.length === 0) unknown.push("io");
	if (limits.length === 0) unknown.push("limits");
	if (deps.length === 0) unknown.push("deps");

	return {
		name,
		description,
		tasks,
		scenarios,
		io,
		limits,
		deps,
		depEcosystems,
		evidence,
		unknown,
		source: { repo, path, ref },
		...(typeof frontmatter.license === "string" ? { license: frontmatter.license } : {}),
	};
}

/** 给 LLM 看的一行卡片（省 token）。
 *
 * 重要：限制与依赖是「值不值得装」的关键依据，不能被总长度截掉。
 * 所以每个字段单独设上限，再拼起来；末尾截断只影响描述这类可以牺牲的部分。
 */
function summaryLine(prefix, fields, max) {
	const clip = (value, size) => value.length <= size ? value : size > 1 ? `${value.slice(0, size - 1)}…` : value.slice(0, size);
	prefix = clip(prefix, Math.min(80, Math.floor(max / 4)));
	const labels = fields.reduce((n, [label]) => n + label.length, 0);
	const budget = Math.max(0, max - prefix.length - labels - fields.length * 3);
	const share = Math.floor(budget / fields.length);
	const sizes = fields.map(([, value]) => Math.min(value.length, share));
	let left = budget - sizes.reduce((n, s) => n + s, 0);
	// 限制、依赖优先获得剩余预算；每个字段都先保留最小份额。
	for (let i = 0; i < fields.length && left > 0; i++) {
		const add = Math.min(left, fields[i][1].length - sizes[i]);
		sizes[i] += add;
		left -= add;
	}
	return [prefix, ...fields.map(([label, value], i) => label + clip(value, sizes[i]))].join(" | ").slice(0, max);
}

function summaryFields(card, deps) {
	const io = card.io ?? {};
	return [
		["限制: ", (card.limits ?? []).join(" / ") || "未声明"],
		["依赖: ", deps || "未声明，未验证"],
		["输入输出: ", `输入 ${(io.input ?? []).join(" / ") || "未声明"} → 输出 ${(io.output ?? []).join(" / ") || "未声明"}`],
		["任务: ", (card.tasks ?? []).join(" / ") || "未声明"],
		["描述: ", String(card.description ?? "") || "未声明"],
	];
}

function cardLine(card, max = 380) {
	return summaryLine(`${card.name}: `, summaryFields(card, (card.deps ?? []).join(" / ")), max);
}

/**
 * 已装技能的摘要行：精排模型判断「能不能补上已有能力」时必须看到这些。
 * 与候选卡片不同，这里额外带上「当前是否启用」和「依赖在当前项目里是否具备」。
 * @param {{name:string, description?:string, tasks?:string[], io?:object, limits?:string[], deps?:string[],
 *          enabled?:boolean, depStatus?:Array<{dep:string, status:string}>}} item
 */
function installedLine(item, max = 380) {
	const state = item.status === "reloading"
		? (item.enabled === false ? "已停用，等待重载" : "已安装，等待重载")
		: item.enabled === false ? "已停用" : "磁盘已启用，加载未验证";
	const deps = item.depStatus?.length
		? item.depStatus.map((d) => `${d.dep}(${d.status === "available" ? "已验证可用" : "未验证"})`).join(" / ")
		: (item.deps ?? []).map((d) => `${d}(未验证)`).join(" / ");
	return summaryLine(`${item.name}（${state}）`, summaryFields(item, deps), max);
}

/**
 * 生态信号不等于包已安装。只有明确的验证结果才能标为可用；本插件未执行环境探测。
 * 拿不到运行环境时不要断言不可用——宁可是「未验证」。
 */
const DEP_ECOSYSTEM = [
	{ id: "python", re: /python|pip3?|uv\b|poetry|torch|tensorflow|numpy|pandas|scipy|matplotlib|jupyter|gymnasium|scikit|transformers/i },
	{ id: "node", re: /\bnode\b|npm|npx|pnpm|yarn|react|typescript|playwright|puppeteer|vite|next\.js/i },
	{ id: "docker", re: /docker|podman|compose/i },
	{ id: "git", re: /\bgit\b|gh\b/i },
];

/**
 * @param {string[]} deps
 * @param {{ecosystems?:string[]}} signals 当前项目能看到的生态（来自依赖清单/清单文件）
 */
function dependencyStatus(deps = [], signals = {}) {
	const have = new Set(signals.ecosystems ?? []);
	const hints = signals.hints ?? {};
	return (Array.isArray(deps) ? deps : []).slice(0, 6).map((dep) => {
		// 先看安装命令的出处（pip → python），再按包名猜，最后才是 unknown
		const eco = hints[dep] || DEP_ECOSYSTEM.find((e) => e.re.test(dep))?.id || "";
		return { dep, ecosystem: eco, ecosystemDetected: Boolean(eco && have.has(eco)), status: signals.verified?.[dep] === true ? "available" : "unknown" };
	});
}

/** 从项目特征（readProjectSignals 的 files 键）推断可用生态。 */
function ecosystemsFromSignals(files = {}) {
	const have = new Set();
	if (files["requirements.txt"] || files["pyproject.toml"]) have.add("python");
	if (files["package.json"]) have.add("node");
	if (files["Dockerfile"] || files["docker-compose.yml"]) have.add("docker");
	const pkg = String(files["package.json"] ?? "").toLowerCase();
	if (pkg.includes("playwright") || pkg.includes("puppeteer")) have.add("node");
	const py = `${files["requirements.txt"] ?? ""}\n${files["pyproject.toml"] ?? ""}`.toLowerCase();
	if (/torch|tensorflow|numpy|pandas|matplotlib|gymnasium|scikit/.test(py)) have.add("python");
	return [...have];
}

module.exports = {
	buildCard,
	cardLine,
	installedLine,
	dependencyStatus,
	ecosystemsFromSignals,
	extractTasks,
	extractScenarios,
	extractIo,
	extractLimits,
	extractDeps,
};
