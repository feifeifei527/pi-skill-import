/**
 * bm25 —— 标准 BM25（k1=1.2, b=0.75），支持字段权重。
 * 字段权重在「建索引」时把 name 重复计 3 次、tasks 计 2 次…，检索时只算一次。
 */
const { tokenize } = require("./recommend.cjs");

const K1 = 1.2;
const B = 0.75;

/**
 * @param {Array<object>} cards 能力卡片（见 core/card.cjs）
 * @param {{nameWeight?:number, tasksWeight?:number, descWeight?:number}} [fieldWeights]
 */
function buildBm25Index(cards, fieldWeights = {}) {
	const w = { name: 3, tasks: 2, desc: 1, ...fieldWeights };
	const docs = [];
	const df = new Map();
	let totalLen = 0;

	for (const card of cards) {
		const tf = new Map();
		const bump = (text, times) => {
			for (let i = 0; i < times; i++) for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
		};
		bump(card.name ?? "", w.name);
		bump(Array.isArray(card.tasks) ? card.tasks.join(" ") : "", w.tasks);
		bump(card.description ?? "", w.desc);

		let len = 0;
		for (const c of tf.values()) len += c;
		totalLen += len;
		for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
		docs.push({ card, tf, len: len || 1 });
	}

	return { docs, df, N: docs.length, avgLen: docs.length ? totalLen / docs.length : 1 };
}

/**
 * @param {{docs:any[], df:Map<string,number>, N:number, avgLen:number}} index
 * @param {string[]} queryTokens
 * @param {{limit?:number, minScore?:number}} [opts]
 */
function bm25Search(index, queryTokens, opts = {}) {
	const limit = opts.limit ?? 30;
	const minScore = opts.minScore ?? 0;
	const { docs, df, N, avgLen } = index;
	const q = [...new Set(queryTokens)];
	const out = [];

	for (const d of docs) {
		let score = 0;
		for (const t of q) {
			const f = d.tf.get(t);
			if (!f) continue;
			const n = df.get(t) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen)));
		}
		if (score > minScore) out.push({ card: d.card, score });
	}

	return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { buildBm25Index, bm25Search, K1, B };
