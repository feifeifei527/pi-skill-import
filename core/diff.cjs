/**
 * diff —— 技能包内容对比（按内容哈希，不看 mtime）。
 * 用于「覆盖前看看会改什么」与「检查更新」。
 */
const { createHash } = require("node:crypto");

/** 短哈希：够区分文件，又不至于在 UI 里刷屏。 */
function hashOf(buf) {
	return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** @param {Map<string,Buffer>} files */
function hashPack(files) {
	const out = new Map();
	for (const [path, buf] of files ?? []) {
		if (String(path).startsWith(".")) continue;
		out.set(path, hashOf(buf));
	}
	return out;
}

/**
 * @param {Map<string,Buffer>} current 已装内容
 * @param {Map<string,Buffer>} next 即将写入的内容
 * @returns {{added:string[], removed:string[], changed:string[], unchanged:number, identical:boolean,
 *            counts:{added:number,removed:number,changed:number,unchanged:number,total:number}}}
 */
function diffPacks(current, next) {
	const a = hashPack(current);
	const b = hashPack(next);
	const added = [];
	const removed = [];
	const changed = [];
	let unchanged = 0;

	for (const [path, hash] of b) {
		if (!a.has(path)) added.push(path);
		else if (a.get(path) !== hash) changed.push(path);
		else unchanged++;
	}
	for (const path of a.keys()) if (!b.has(path)) removed.push(path);

	added.sort();
	removed.sort();
	changed.sort();
	return {
		added,
		removed,
		changed,
		unchanged,
		identical: added.length === 0 && removed.length === 0 && changed.length === 0,
		counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged, total: b.size },
	};
}

/** 一句话摘要。 */
function describeDiff(diff) {
	if (!diff) return "";
	if (diff.identical) return "内容与已装版本一致";
	const parts = [];
	if (diff.counts.added) parts.push(`新增 ${diff.counts.added}`);
	if (diff.counts.changed) parts.push(`修改 ${diff.counts.changed}`);
	if (diff.counts.removed) parts.push(`删除 ${diff.counts.removed}`);
	return `${parts.join(" / ")}（未变 ${diff.counts.unchanged}）`;
}

module.exports = { hashPack, diffPacks, describeDiff };
