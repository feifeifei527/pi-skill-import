/**
 * task —— 从「当前上下文」提炼这次要干的事。
 * 规则版（不调模型）：任务句、关键词、想要的能力。
 * 长期偏好不参与——只有当前对话与当前项目。
 */
const { tokenize } = require("./recommend.cjs");

const VERB_ZH = /提取|分析|生成|转换|比较|诊断|创建|读取|写入|检查|部署|搜索|抓取|整理|绘制|训练|评估|优化|修复|安装|配置|审查|测试|总结|翻译|识别|解析|导出|导入|监控|统计|清洗|标注|推荐|调试/;
const VERB_EN =
	/\b(extract|analy[sz]e|generate|create|convert|compare|diagnos|read|write|check|deploy|search|fetch|summar|plot|train|evaluat|optimi[sz]e|fix|build|install|configure|migrate|review|test|translat|recogni|pars|export|import|monitor|clean|annotat|recommend|debug|audit|render|design)\b/i;

function clean(text, max = 80) {
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function messageText(m) {
	if (!m) return "";
	if (typeof m.text === "string") return m.text;
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((b) => (typeof b === "string" ? b : b?.text ?? ""))
			.filter(Boolean)
			.join(" ");
	}
	return "";
}

/** 中文/英文的「动词 + 宾语」片段。 */
function extractCapabilities(text, max = 4) {
	const clauses = String(text ?? "")
		.split(/[。；;!?\n]+|(?<=[a-z])\.\s/)
		.map((s) => clean(s, 160))
		.filter(Boolean);
	const out = [];
	for (const clause of clauses) {
		for (const part of clause.split(/[，,]/)) {
			const p = clean(part, 80);
			if (p.length < 4) continue;
			if (!(VERB_ZH.test(p) || VERB_EN.test(p))) continue;
			if (!out.includes(p)) out.push(p);
			if (out.length >= max) return out;
		}
	}
	return out;
}

/**
 * @param {{messages?:Array<{role:string,text:string}|any>, project?:{files?:Record<string,string>, hints?:string[]},
 *          recent?:number}} args
 */
function buildTask({ messages = [], project = {}, recent = 3 } = {}) {
	const userTexts = messages
		.filter((m) => String(m?.role ?? "") === "user")
		.map((m) => messageText(m))
		.filter(Boolean);

	const recentTexts = userTexts.slice(-recent).map((t) => clean(t, 600));
	const queryText = recentTexts.join("\n");
	const projectSummary = Object.entries(project.files ?? {})
		.slice(0, 6)
		.map(([k, v]) => `${k}: ${clean(v, 120)}`)
		.join("; ");

	const keywords = [...new Set(tokenize(`${queryText}\n${projectSummary}`))];
	const capabilities = extractCapabilities(queryText);
	const task = recentTexts.length ? clean(recentTexts[recentTexts.length - 1], 100) : "";

	return {
		task,
		queryText,
		projectSummary,
		keywords,
		capabilities,
		hints: project.hints ?? [],
		hasSignal: Boolean(queryText.trim() || projectSummary.trim()),
	};
}

/**
 * 把 LLM 给的扩展词并进查询：**多词短语要切开**（BM25 只认 token），
 * 否则 "Proximal Policy Optimization" 整串永远匹配不到。
 */
function mergeExpansion(baseKeywords, extraTerms, max = 48) {
	const out = [...baseKeywords];
	const push = (t) => {
		const token = String(t ?? "").trim().toLowerCase();
		if (!token || token.length > 40) return;
		if (out.includes(token)) return;
		out.push(token);
	};
	for (const raw of Array.isArray(extraTerms) ? extraTerms : []) {
		const term = String(raw ?? "").trim();
		if (!term) continue;
		for (const token of tokenize(term)) push(token);
		if (!/\s/.test(term)) push(term);
		if (out.length >= max) break;
	}
	return out.slice(0, max);
}

module.exports = { buildTask, extractCapabilities, mergeExpansion, messageText };
