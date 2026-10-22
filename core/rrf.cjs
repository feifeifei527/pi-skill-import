/**
 * rrf —— Reciprocal Rank Fusion：只吃名次，避免把 BM25 分数和别路分数硬加。
 *   S(s) = Σ 1 / (k + rank)
 *
 * 身份用 `id`（repo + ref + path）而不是 name：不同仓库可能有同名但能力不同的技能，
 * 按 name 合并会在这一步就把它们丢掉。同名版本留到展示层再归组（dedupe 里的 variants）。
 */

/** 条目的稳定身份：优先能力卡片/条目自带的 id，否则退回 name。 */
function itemKey(item) {
	return item?.id ?? item?.card?.id ?? item?.name ?? "";
}

function rrf(lists, { k = 60, limit = 20 } = {}) {
	const merged = new Map();
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		list.forEach((item, idx) => {
			const name = item?.name ?? item?.card?.name;
			if (!name) return;
			const key = itemKey(item) || name;
			const rank = idx + 1;
			const entry = merged.get(key) ?? { name, key, score: 0, ranks: [], item };
			entry.score += 1 / (k + rank);
			entry.ranks.push(rank);
			if (!entry.item && item) entry.item = item;
			merged.set(key, entry);
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
 * 保留前面（分数更高）的那个，被折叠的版本记进 `variants`，展示时可以列出来源。
 * @param {Array<{id?:string,name:string,repo?:string,path?:string,ref?:string,description?:string,
 *                card?:object,tokens?:Set<string>,variants?:Array<object>}>} items
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
		if (dup) {
			// 同 repo 同 path 的重复只是同一份，不记变体
			const samePlace = dup.repo === item.repo && (dup.path ?? "") === (item.path ?? "") && (dup.ref ?? "") === (item.ref ?? "");
			if (!samePlace) {
				const variant = {
					id: item.id ?? "",
					name: item.name,
					repo: item.repo ?? "",
					path: item.path ?? "",
					ref: item.ref ?? "",
					description: String(item.description ?? "").slice(0, 120),
				};
				dup.variants = dup.variants ?? [];
				if (!dup.variants.some((v) => v.repo === variant.repo && v.path === variant.path && v.ref === variant.ref)) {
					dup.variants.push(variant);
				}
			}
			continue;
		}
		kept.push({ ...item, tokens });
	}
	return kept;
}

module.exports = { rrf, dedupe, normalizeName, jaccard, itemKey };
