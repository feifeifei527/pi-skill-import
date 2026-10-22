/**
 * repo-tree —— 大仓库的「只取需要的文件」通道。
 *
 * zipball 一次能拿全量，但几百 MB 的库（K-Dense 那个 235MB）下载慢、解压更吃内存。
 * 这里用 GitHub 的 tree API 拿路径列表（~几百 KB），再按路径并发拉 raw：
 *   - 索引：只拉所有 SKILL.md
 *   - 安装：只拉目标技能子目录下的文件
 * 内存只跟「实际要的文件」成正比。
 */
const { readZip, stripCommonRoot } = require("../core/zip.cjs");

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const UA = { "User-Agent": "pi-web-ui-skill-import", Accept: "application/vnd.github+json" };

/** 有 token 就带上：API 限额 60/h → 5000/h。只发给 api.github.com。 */
function apiHeaders(auth = {}) {
	return auth?.Authorization ? { ...UA, ...auth } : UA;
}

function encPath(p) {
	return String(p ?? "")
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/");
}

function rawUrl(owner, repo, ref, path) {
	const r = ref ? encPath(ref) : "HEAD";
	return `${RAW}/${owner}/${repo}/${r}/${encPath(path)}`;
}

/** 仓库元信息：只用来判断「有没有新提交」，避免重下整包。 */
async function fetchRepoMeta({ owner, repo, http, auth = {} }) {
	const url = `${API}/repos/${owner}/${repo}`;
	const res = await http.get(url, { headers: apiHeaders(auth), maxBytes: 512 * 1024, timeoutMs: 15_000 });
	if (!res.ok) return { ok: false, error: res.error };
	try {
		const data = JSON.parse(res.buffer.toString("utf8"));
		return {
			ok: true,
			pushedAt: String(data.pushed_at ?? ""),
			defaultBranch: String(data.default_branch ?? ""),
			size: Number(data.size) || 0,
		};
	} catch {
		return { ok: false, error: "仓库元信息不是 JSON" };
	}
}

/** 仓库文件清单（不看内容）。 */
async function listRepoTree({ owner, repo, ref, http, auth = {}, maxEntries = 20000 }) {
	const r = ref ? encPath(ref) : "HEAD";
	const url = `${API}/repos/${owner}/${repo}/git/trees/${r}?recursive=1`;
	const res = await http.get(url, { headers: apiHeaders(auth), maxBytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
	if (!res.ok) return { ok: false, error: res.error };
	let data;
	try {
		data = JSON.parse(res.buffer.toString("utf8"));
	} catch {
		return { ok: false, error: "tree API 返回的不是 JSON" };
	}
	if (!Array.isArray(data?.tree)) return { ok: false, error: data?.message ?? "tree API 没有返回文件列表" };
	if (data.truncated) return { ok: false, error: "仓库太大，tree API 返回被截断" };
	const paths = data.tree
		.filter((e) => e.type === "blob" && typeof e.path === "string")
		.slice(0, maxEntries)
		.map((e) => ({ path: e.path, size: Number(e.size) || 0 }));
	return { ok: true, paths, truncated: Boolean(data.truncated) };
}

/** 并发拉一批 raw 文件（默认 8 路）。 */
async function fetchRawBatch({ owner, repo, ref, paths, http, concurrency = 16, maxFiles = 600, maxBytesPerFile = 4 * 1024 * 1024 }) {
	const out = new Map();
	const errors = [];
	const list = paths.slice(0, maxFiles);
	let cursor = 0;

	const worker = async () => {
		for (;;) {
			const idx = cursor++;
			if (idx >= list.length) return;
			const p = typeof list[idx] === "string" ? list[idx] : list[idx].path;
			const url = rawUrl(owner, repo, ref, p);
			const res = await http.get(url, { maxBytes: maxBytesPerFile, timeoutMs: 20_000 });
			if (res.ok) out.set(p, res.buffer);
			else errors.push(`${p}: ${res.error}`);
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, worker));
	return { ok: out.size > 0, files: out, errors };
}

/** 索引用：只取所有 SKILL.md。 */
async function fetchSkillDocs({ owner, repo, ref, http, auth = {}, maxFiles = 1500 }) {
	const tree = await listRepoTree({ owner, repo, ref, http, auth });
	if (!tree.ok) return tree;
	const docs = tree.paths.filter((p) => /(^|\/)SKILL\.md$/i.test(p.path));
	if (docs.length === 0) return { ok: false, error: "这个来源里没有 SKILL.md" };
	const batch = await fetchRawBatch({ owner, repo, ref, paths: docs, http, maxFiles: maxFiles });
	if (!batch.ok) return { ok: false, error: `拉取 SKILL.md 失败：${batch.errors[0] ?? "未知错误"}` };
	return { ok: true, files: batch.files, errors: batch.errors, via: "tree" };
}

/** 安装用：只取 path 子树下的文件。 */
async function fetchSubtree({ owner, repo, ref, path, http, auth = {}, maxFiles = 600 }) {
	const prefix = String(path ?? "").replace(/^\/+|\/+$/g, "");
	if (!prefix) return { ok: false, error: "缺少子目录" };
	const tree = await listRepoTree({ owner, repo, ref, http, auth });
	if (!tree.ok) return tree;
	const wanted = tree.paths.filter((p) => p.path === prefix || p.path.startsWith(`${prefix}/`));
	if (wanted.length === 0) return { ok: false, error: `仓库里没有这个目录：${prefix}` };
	if (wanted.some((p) => p.size > 4 * 1024 * 1024)) {
		return { ok: false, error: "目标目录里有超过 4MB 的文件，无法按单文件拉取" };
	}
	const batch = await fetchRawBatch({ owner, repo, ref, paths: wanted, http, maxFiles });
	if (!batch.ok) return { ok: false, error: `拉取技能文件失败：${batch.errors[0] ?? "未知错误"}` };
	return { ok: true, files: batch.files, errors: batch.errors, via: "tree" };
}

/**
 * 索引专用入口：先试 zipball（一次请求最快），体积超限就转 tree API。
 * @returns {{ok:true, files:Map<string,Buffer>, via:"zip"|"tree"} | {ok:false, error:string}}
 */
async function fetchSourceDocs({ owner, repo, ref, http, auth = {}, zipCandidates, zipBytes = 64 * 1024 * 1024, preferTree = false }) {
	// 已知包太大（按 size 或上次失败记住的标记）：只走 tree，别白下 64MB
	if (preferTree) {
		const docsOnly = await fetchSkillDocs({ owner, repo, ref, http, auth });
		if (docsOnly.ok) return { ok: true, files: docsOnly.files, via: "tree" };
		return { ok: false, error: `包超过单次上限，且 tree API 拉取失败：${docsOnly.error}` };
	}
	let zipError = "";
	for (const url of zipCandidates) {
		const head = typeof http.head === "function" ? await http.head(url, { timeoutMs: 15_000 }) : { ok: true, contentLength: 0 };
		if (!head.ok) {
			zipError = head.error;
			continue;
		}
		if (head.contentLength > zipBytes) {
			zipError = `包太大（${(head.contentLength / 1048576).toFixed(0)}MB > ${(zipBytes / 1048576).toFixed(0)}MB）`;
			break;
		}
		const res = await http.get(url, { maxBytes: zipBytes, timeoutMs: 90_000 });
		if (!res.ok) {
			zipError = res.error;
			break;
		}
		const zip = readZip(res.buffer, {
			filter: (name) => /(^|\/)SKILL\.md$/i.test(name),
			maxTotalBytes: 8 * 1024 * 1024,
		});
		if (!zip.ok) {
			zipError = zip.error;
			break;
		}
		// zipball 顶层是 owner-repo-sha/，剥掉才能和树 API 的路径口径一致
		return { ok: true, files: stripCommonRoot(zip.files), via: "zip" };
	}

	const docs = await fetchSkillDocs({ owner, repo, ref, http, auth });
	if (!docs.ok) return { ok: false, error: `${zipError ? `${zipError}；` : ""}${docs.error}` };
	return { ok: true, files: docs.files, via: "tree" };
}

module.exports = { listRepoTree, fetchRawBatch, fetchSkillDocs, fetchSubtree, fetchSourceDocs, fetchRepoMeta, rawUrl };
