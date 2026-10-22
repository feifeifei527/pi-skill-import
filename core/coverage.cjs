/**
 * coverage —— 「这个候选真的像用户在找的吗」的最低门槛。
 *
 * 单独抽出来是因为它同时被推荐服务与离线评测使用，两边口径必须一致。
 *
 * 为什么不能只看覆盖率：中文查询会被切成很多二元组（「把这个 PDF 里的表格抽出来」
 * 能切出 10 来个词），只撞上「表格」一个词就有 10% 覆盖率——足够骗过 0.1 的门槛，
 * 于是 xlsx、matplotlib 这类只共享一个通用词的技能也会进候选。
 * 所以长查询还要求至少命中两个词。
 */
const { GENERIC_TOKENS, tokenize } = require("./recommend.cjs");

const MIN_COVERAGE = 0.15;
/**
 * 唯一命中是有辨识度的技术词时，覆盖率下限可以放宽：
 * 中文需求往往有十来个二元组，只撞上一个英文词（pdf / pptx）覆盖率天然就很低，
 * 但那个词恰恰是最有信息量的。
 */
const STRONG_SINGLE_COVERAGE = 0.06;
/** 查询词多到这个数量就算「长查询」 */
const LONG_QUERY_TOKENS = 6;

/**
 * 「有辨识度的词」：拉丁技术词 / 产品名（pdf、pptx、commit、matplotlib）。
 * 中文二元组不在此列——「表格 / 文件 / 数据」在技能描述里到处都是，撞一个说明不了什么。
 */
function isStrongToken(token) {
	const t = String(token ?? "").trim().toLowerCase();
	if (t.length < 2) return false;
	if (!/^[a-z][a-z0-9+#._-]*$/.test(t)) return false;
	return !GENERIC_TOKENS.has(t);
}

/**
 * @param {number} matched 候选命中的查询词数
 * @param {number} baseCount 查询词总数
 * @param {{minCoverage?:number, minMatched?:number, strongSingle?:boolean}} [opts]
 *   strongSingle：唯一命中的那个词是不是有辨识度的技术词（跨语言场景很常见：
 *   中文需求里只有一个 `pdf` / `pptx` 能撞上英文描述，这种情况要放行）
 */
function coverageOk(matched, baseCount, opts = {}) {
	if (!Number.isFinite(matched) || matched <= 0) return false;
	const base = Math.max(1, Number(baseCount) || 1);
	const strongSingle = opts.strongSingle === true;
	const minCoverage = opts.minCoverage ?? (strongSingle ? STRONG_SINGLE_COVERAGE : MIN_COVERAGE);
	if (matched / base < minCoverage) return false;
	const minMatched = opts.minMatched ?? (base >= LONG_QUERY_TOKENS ? 2 : 1);
	if (matched >= minMatched) return true;
	// 只差一个词时，只有技术词才算「够辨识」
	return matched === 1 && strongSingle;
}

/** 已声明的输出格式不能充当读取/抽取任务的输入能力。未知 IO 不猜测。 */
function directionCompatible(entry, queryText = "") {
	const input = entry?.io?.input ?? [];
	const output = entry?.io?.output ?? [];
	if (!input.length || !output.length) return true;
	const consuming = String(queryText).split(/生成|输出|导出|绘制|\b(?:generate|output|export|plot)\b/i)[0];
	if (!/读取|读入|提取|抽取|抽出来|解析|\b(?:extract|read|parse)\b/i.test(consuming)) return true;
	const query = tokenize(consuming).filter(isStrongToken);
	const inTokens = new Set(tokenize(input.join(" ")));
	const outTokens = new Set(tokenize(output.join(" ")));
	return !query.some((t) => outTokens.has(t) && !inTokens.has(t));
}

module.exports = { coverageOk, directionCompatible, isStrongToken, MIN_COVERAGE, STRONG_SINGLE_COVERAGE, LONG_QUERY_TOKENS };
