/**
 * rrf —— Reciprocal Rank Fusion：只吃名次，避免把 BM25 分数和别路分数硬加。
 *   S(s) = Σ 1 / (k + rank)
 */
function rrf(lists, { k = 60, limit = 20 } = {}) {
	const merged = new Map();
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		list.forEach((item, idx) => {
			const name = item?.name ?? item?.card?.name;
			if (!name) return;
			const rank = idx + 1;
			const entry = merged.get(name) ?? { name, score: 0, ranks: [], item };
			entry.score += 1 / (k + rank);
			entry.ranks.push(rank);
			if (!entry.item && item) entry.item = item;
			merged.set(name, entry);
		});
	}
	return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 近似重复：名字规范化 + token Jaccard。 */
function normalizeName(name) {
	return String(name ?? "")
		.toLowerCase()
		.replace(/^(superpowers|anthropic|k-dense|vercel)[-_]/, "")
		.replace(/[-_](skill|skills|tool|tools|helper)$/, "");
}

function jaccard(a, b) {
	if (!a.size || !b.size) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

/**
 * 去重：同 repo 且名字规范化相同；或 token 集合 Jaccard ≥ threshold。
 * 保留前面（分数更高）的那个。
 * @param {Array<{name:string, repo?:string, description?:string, card?:object, tokens?:Set<string>}>} items
 */
function dedupe(items, { threshold = 0.8 } = {}) {
	const kept = [];
	for (const item of items) {
		const name = normalizeName(item.name);
		const tokens =
			item.tokens ??
			new Set(
				String(`${item.name ?? ""} ${item.description ?? ""}`)
					.toLowerCase()
					.split(/[^a-z0-9\u4e00-\u9fa5]+/)
					.filter((t) => t.length >= 3),
			);
		const dup = kept.find(
			(k) =>
				normalizeName(k.name) === name ||
				(k.repo && item.repo && k.repo === item.repo && jaccard(k.tokens, tokens) >= threshold),
		);
		if (dup) continue;
		kept.push({ ...item, tokens });
	}
	return kept;
}

module.exports = { rrf, dedupe, normalizeName, jaccard };
