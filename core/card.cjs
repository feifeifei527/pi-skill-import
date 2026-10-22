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
		unknown,
		source: { repo, path, ref },
		...(typeof frontmatter.license === "string" ? { license: frontmatter.license } : {}),
	};
}

/** 给 LLM 看的一行卡片（省 token）。 */
function cardLine(card, max = 220) {
	const parts = [`${card.name}: ${String(card.description ?? "").slice(0, 100)}`];
	if (card.tasks?.length) parts.push(`任务: ${card.tasks.join(" / ").slice(0, 80)}`);
	if (card.limits?.length) parts.push(`限制: ${card.limits.join(" / ").slice(0, 60)}`);
	if (card.deps?.length) parts.push(`依赖: ${card.deps.join(" / ").slice(0, 60)}`);
	return parts.join(" | ").slice(0, max);
}

module.exports = { buildCard, cardLine, extractTasks, extractScenarios, extractIo, extractLimits, extractDeps };
