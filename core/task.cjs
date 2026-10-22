/**
 * task —— 从「当前上下文」提炼这次要干的事。
 * 规则版（不调模型）：任务句、关键词、想要的能力。
 * 长期偏好不参与——只有当前对话与当前项目。
 *
 * 关键点：**短回复不能顶掉真正的任务**。
 * 用户经常连着说「这个呢 / 好的 / 继续」，如果只看最近三条，任务会变成「继续」，
 * 查询里的 PPO 直接消失。这里从后往前找最近一条「有信息量」的用户消息当锚点，
 * 后面那些短回复只当补充上下文。
 */
const { tokenize } = require("./recommend.cjs");

const VERB_ZH = /提取|分析|生成|转换|比较|诊断|创建|读取|写入|检查|部署|搜索|抓取|整理|绘制|训练|评估|优化|修复|安装|配置|审查|测试|总结|翻译|识别|解析|导出|导入|监控|统计|清洗|标注|推荐|调试|排查|回滚|迁移|重构|画|绘|写|做|查|看|改|列|跑|算|测|删|加|搜|画一/;
const VERB_EN =
	/\b(extract|analy[sz]e|generate|create|convert|compare|diagnos|read|write|check|deploy|search|fetch|summar|plot|train|evaluat|optimi[sz]e|fix|build|install|configure|migrate|review|test|translat|recogni|pars|export|import|monitor|clean|annotat|recommend|debug|audit|render|design|troubleshoot|rollback|refactor)\b/i;

/** 纯承接语：整句只有它们时不算任务。 */
const CONTINUATION =
	/^(继续|接着|接着说|接着说下去|然后呢?|这个呢?|那个呢?|那这个呢?|好的?|好呀|好啊|好滴|行|可以|嗯+|哦+|ok|okay|okey|yes|yep|yup|sure|go on|continue|next|cool|nice|great|收到|明白|了解|知道了|谢谢|thx|thanks|再试试|试试吧|试试看|走起|来吧|来吧继续|看下|看一下)[\s。！!，,、~～…·.]*$/i;

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

/** 这句话里有没有「实义」：技术词 / 动词 / 足够长。 */
function hasTechnicalToken(text) {
	const s = String(text ?? "");
	// 英文单词或缩写（≥2 个字母）都算：PPO / RL / reward / pdf
	return /[a-z]{2,}/i.test(s);
}

/**
 * 低信息量回复：承接语、过短且没有动词/技术词的句子。
 * @param {string} text
 * @param {number} [minLen] 短句阈值（字符数）
 */
function isLowInformation(text, minLen = 8) {
	const t = clean(text, 400);
	if (!t) return true;
	if (CONTINUATION.test(t)) return true;
	if (t.length >= minLen) return false;
	if (VERB_ZH.test(t) || VERB_EN.test(t)) return false;
	if (hasTechnicalToken(t.replace(CONTINUATION, ""))) return false;
	// 短问句（「下一步做什么」「哪里错了」）仍然是需求，不是承接语
	if (/[?？]/.test(t) || /什么|怎么|为什么|哪|如何|是否|多少/.test(t)) return false;
	return true;
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
 *          recent?:number, lookback?:number}} args
 * @param {number} [args.recent] 锚点之后还要带几条上下文
 * @param {number} [args.lookback] 往前找锚点时最多看几条用户消息
 */
function buildTask({ messages = [], project = {}, recent = 3 } = {}) {
	const userTexts = messages
		.filter((m) => String(m?.role ?? "") === "user")
		.map((m) => messageText(m))
		.filter(Boolean);

	// 往前找到最后一个明确需求，不因承接语超过固定窗口而丢任务。
	const window = userTexts;
	// 只把「有信息量」的句子当任务/查询；承接语（继续/好的/这个呢）既不顶掉任务，也不污染查询
	const substantive = window.filter((t) => !isLowInformation(t));
	const anchor = substantive.length ? substantive[substantive.length - 1] : "";
	// 锚点放最前（关键词/能力从它领），再带最近几条实义上下文（同一话题的补充）
	const anchorTokens = new Set(tokenize(anchor));
	const context = substantive.slice(0, -1)
		.filter((text) => tokenize(text).some((token) => anchorTokens.has(token)))
		.slice(-Math.max(0, recent - 1));
	const queryParts = [anchor, ...context].filter(Boolean).map((t) => clean(t, 600));
	const queryText = queryParts.join("\n");
	const projectSummary = Object.entries(project.files ?? {})
		.slice(0, 6)
		.map(([k, v]) => `${k}: ${clean(v, 120)}`)
		.join("; ");

	const keywords = [...new Set(tokenize(`${queryText}\n${projectSummary}`))];
	const capabilities = extractCapabilities(queryText);
	// 全部都是承接语时退回最后一条用户消息，至少不空
	const lastUserText = window[window.length - 1] ?? "";
	const task = anchor ? clean(anchor, 100) : clean(lastUserText, 100);
	// 最近的回复只是「继续」→ 任务是从更早那条沿用来的
	const inherited = Boolean(anchor) && clean(lastUserText, 400) !== clean(anchor, 400);

	return {
		task,
		queryText,
		projectSummary,
		keywords,
		capabilities,
		hints: project.hints ?? [],
		hasSignal: Boolean(queryText.trim() || projectSummary.trim()),
		/** 任务来自更早的消息（最近的回复只是「继续」） */
		inherited,
		/** latest = 就是最近一条；inherited = 沿用了更早的任务；none = 没有可用任务 */
		mode: !anchor ? "none" : inherited ? "inherited" : "latest",
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

module.exports = { buildTask, extractCapabilities, isLowInformation, mergeExpansion, messageText, CONTINUATION };
