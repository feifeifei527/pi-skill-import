/**
 * recommend —— 纯逻辑：把「你做的事」和技能描述都切成词，算相似度。
 * 不联网、不读磁盘，方便单测。
 */

const STOP_EN = new Set([
	"the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "was", "were", "have", "has", "had",
	"not", "but", "can", "could", "will", "would", "should", "use", "used", "using", "when", "what", "which", "how",
	"why", "into", "out", "all", "any", "our", "their", "they", "them", "then", "than", "also", "just", "make", "made",
	"get", "set", "run", "runs", "new", "one", "two", "its", "does", "did", "is", "be", "to", "of", "in", "on", "at",
	"as", "by", "or", "a", "an", "i", "we", "he", "she", "it", "if", "so", "my", "me", "up", "do", "no", "yes",
	"need", "needs", "want", "wants", "please", "help", "let", "lets", "here", "there", "about", "more", "some",
]);

/**
 * 通用词：在各家技能描述里到处都是，命中它们说明不了「这件事需要它」。
 * 命中后权重乘 GENERIC_FACTOR，压掉「skills / agent / 工具」这类词的统治力。
 */
const GENERIC_TOKENS = new Set([
	"skill", "skills", "agent", "agents", "assistant", "claude", "openai", "gpt", "ai", "llm",
	"code", "coding", "developer", "developers", "tool", "tools", "toolkit", "plugin", "plugins",
	"file", "files", "data", "api", "app", "apps", "application", "project", "projects", "system",
	"workflow", "workflows", "help", "helper", "util", "utils", "utility", "task", "tasks",
	"use", "user", "users", "using", "integration", "integrations", "service", "services",
	"platform", "framework", "library", "package", "packages", "module", "modules",
	"技能", "工具", "助手", "代理", "智能体", "模型", "代码", "文件", "数据", "项目", "系统",
	"平台", "服务", "框架", "开发", "插件", "模块", "组件", "功能", "支持", "管理",
]);
/** 通用词降权系数 */
const GENERIC_FACTOR = 0.2;
/** 词出现在超过这个比例的文档里，也按通用词处理（自动发现未来变烂大街的词） */
const COMMON_DF_RATIO = 0.3;

const STOP_ZH = new Set([
	"这个", "那个", "我们", "你们", "他们", "可以", "需要", "一个", "什么", "怎么", "如何", "现在", "已经", "还是",
	"然后", "因为", "所以", "但是", "如果", "就是", "没有", "不是", "这样", "那样", "一下", "一些", "这些", "那些",
	"进行", "使用", "通过", "对于", "关于", "以及", "并且", "或者", "而且", "之后", "之前", "时候", "问题", "东西",
]);

/** 英文词（≥3）+ 中文二元组（过滤高频虚词）。 */
function tokenize(text) {
	const out = [];
	const s = String(text ?? "").toLowerCase();
	for (const m of s.matchAll(/[a-z][a-z0-9+#._-]{2,}/g)) {
		const w = m[0].replace(/[._-]+$/, "");
		if (w.length >= 3 && !STOP_EN.has(w)) out.push(w);
		// 复合词再拆一次：pdf-lib → pdf / lib，node-fetch → node / fetch
		if (/[._-]/.test(w)) {
			for (const part of w.split(/[._-]+/)) {
				if (part.length >= 3 && !STOP_EN.has(part)) out.push(part);
			}
		}
	}
	for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
		const seg = m[0];
		const grams = seg.length <= 4 ? [seg] : [];
		for (let i = 0; i + 1 < seg.length; i++) grams.push(seg.slice(i, i + 2));
		for (const g of grams) {
			if (STOP_ZH.has(g)) continue;
			// 纯虚词二元组（的/了/是…组合）意义不大，挡一批
			if (/[的了着过是在有和与及把被让给对从到就都也还很更最]$/.test(g) && g.length === 2) continue;
			out.push(g);
		}
	}
	return out;
}

/**
 * 画像：weights = 词 → 权重。
 * @param {{messages?:Array<{role:string,text:string}>, files?:Record<string,string>, hints?:string[], recent?:number}} args
 */
function buildProfile({ messages = [], files = {}, hints = [], recent = 6 } = {}) {
	const weights = new Map();
	const add = (text, w) => {
		for (const t of tokenize(text)) weights.set(t, (weights.get(t) ?? 0) + w);
	};

	// 对话：只取最近几条，用户说的权重更高
	for (const m of messages.slice(-recent)) {
		const w = m.role === "user" ? 2 : 1;
		add(m.text, w);
	}
	// 项目特征更稳定，权重高
	for (const [k, v] of Object.entries(files)) add(`${k} ${v}`, 3);
	for (const h of hints) add(h, 4);

	const keywords = [...weights.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([t, w]) => ({ token: t, weight: w }));

	return { weights, keywords };
}

/**
 * 打分：tf-idf（idf 用目录内 df 现算）+ 名字命中加权 + 长度归一。
 * @param {{entries:Array<{name:string,description:string,[k:string]:any}>, profile:ReturnType<typeof buildProfile>,
 *          installed?:Set<string>, limit?:number, minScore?:number}} args
 */
function scoreCatalog({ entries, profile, installed = new Set(), ignored = new Set(), limit = 5, minScore = 0.15 } = {}) {
	const docs = entries.map((e) => {
		const tokens = tokenize(`${e.name} ${e.description ?? ""}`);
		const tf = new Map();
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		return { entry: e, tf, len: tokens.length || 1 };
	});

	const df = new Map();
	for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
	const N = docs.length || 1;

	const ranked = [];
	for (const d of docs) {
		const name = String(d.entry.name ?? "");
		if (!name || installed.has(name) || ignored.has(name)) continue;

		let score = 0;
		const hits = [];
		for (const [t, c] of d.tf) {
			const w = profile.weights.get(t);
			if (!w) continue;
			const idf = Math.log(1 + N / (1 + (df.get(t) ?? 0)));
			// 权重压缩 + 通用词降权：避免「skills」出现 7 次就把所有技能类顶上来
			let weight = Math.sqrt(w);
			if (GENERIC_TOKENS.has(t)) weight *= GENERIC_FACTOR;
			if ((df.get(t) ?? 0) / N > COMMON_DF_RATIO) weight *= 0.3;
			const s = weight * idf * (1 + Math.log(c));
			score += s;
			hits.push({ token: t, s });
		}
		// 技能名被对话/项目直接提到 → 强信号
		const nameTokens = tokenize(name);
		const nameHit = nameTokens.filter((t) => profile.weights.has(t)).length;
		if (nameHit) score += nameHit * 3;

		score /= Math.sqrt(d.len);
		if (score < minScore) continue;

		ranked.push({
			...d.entry,
			score: Number(score.toFixed(4)),
			why: hits
				.sort((a, b) => b.s - a.s)
				.slice(0, 4)
				.map((h) => h.token),
		});
	}

	return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 从 LLM 的回复里抠出 [{name, reason}]，尽量宽容。 */
function parseRerank(text, candidates) {
	const raw = String(text ?? "");
	const start = raw.indexOf("[");
	const end = raw.lastIndexOf("]");
	if (start < 0 || end <= start) return null;
	let arr;
	try {
		arr = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!Array.isArray(arr)) return null;
	const byName = new Map(candidates.map((c) => [c.name, c]));
	const out = [];
	for (const item of arr) {
		const name = typeof item === "string" ? item : item?.name;
		if (typeof name !== "string") continue;
		const hit = byName.get(name.trim());
		if (!hit) continue;
		out.push({ ...hit, reason: typeof item?.reason === "string" ? item.reason.slice(0, 60) : "" });
	}
	return out.length ? out : null;
}

/** 解析精排结果：{"picks":[{name,reason,added_capability,requirements}]} 或裸数组。 */
function parsePicks(text, candidates) {
	const raw = String(text ?? "");
	const byName = new Map(candidates.map((c) => [c.name, c]));
	const tryParse = (slice) => {
		try {
			return JSON.parse(slice);
		} catch {
			return null;
		}
	};

	// 先试数组（裸数组里也含 {}），再试对象（{"picks":[...]}）
	const slices = [];
	const aStart = raw.indexOf("[");
	const aEnd = raw.lastIndexOf("]");
	if (aStart >= 0 && aEnd > aStart) slices.push(raw.slice(aStart, aEnd + 1));
	const oStart = raw.indexOf("{");
	const oEnd = raw.lastIndexOf("}");
	if (oStart >= 0 && oEnd > oStart) slices.push(raw.slice(oStart, oEnd + 1));

	let list = null;
	for (const slice of slices) {
		const data = tryParse(slice);
		if (data === null) continue;
		const found = Array.isArray(data) ? data : Array.isArray(data?.picks) ? data.picks : null;
		if (found) {
			list = found;
			break;
		}
	}
	if (list === null) return null;

	const out = [];
	let rawCount = 0;
	for (const item of list) {
		const name = typeof item === "string" ? item : item?.name;
		if (typeof name !== "string") continue;
		rawCount++;
		const hit = byName.get(name.trim());
		if (!hit) continue;
		out.push({
			...hit,
			reason: typeof item?.reason === "string" ? item.reason.slice(0, 120) : "",
			addedCapability:
				typeof item?.added_capability === "string"
					? item.added_capability.slice(0, 120)
					: typeof item?.addedCapability === "string"
						? item.addedCapability.slice(0, 120)
						: "",
			requirements: Array.isArray(item?.requirements)
				? item.requirements.filter((x) => typeof x === "string").slice(0, 4).map((x) => x.slice(0, 80))
				: [],
		});
	}
	// 有内容但一个都不在候选里 → 视为解析失败（调用方回落），而不是「没有合适的」
	if (rawCount > 0 && out.length === 0) return null;
	return out;
}

module.exports = { tokenize, buildProfile, scoreCatalog, parseRerank, parsePicks, GENERIC_TOKENS, GENERIC_FACTOR };
