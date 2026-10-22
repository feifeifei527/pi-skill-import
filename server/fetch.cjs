/**
 * fetch —— 把「来源」变成内存文件包（Map<posix路径, Buffer>）。
 * 纯逻辑，网络与文件系统都通过注入的 http / fs 适配器，方便单测。
 */
const { rawCandidates } = require("../core/source.cjs");
const { readZip, stripCommonRoot } = require("../core/zip.cjs");
const { fetchSubtree } = require("./repo-tree.cjs");
const { baseName, dirnamePosix, joinPosix } = require("../core/util.cjs");

const DEFAULT_LIMITS = {
	zipBytes: 64 * 1024 * 1024,
	zipTimeoutMs: 60_000,
	textBytes: 2 * 1024 * 1024,
	maxFiles: 2000,
	maxDepth: 8,
};

function fail(error, extra) {
	return { ok: false, error, ...(extra ?? {}) };
}

/** GitHub 仓库 → zipball 候选地址（默认分支优先，其次 main/master）。 */
function zipCandidates(src) {
	const base = `https://codeload.github.com/${src.owner}/${src.repo}/zip`;
	const ref = String(src.ref ?? "").trim();
	if (!ref) return [`${base}/HEAD`, `${base}/refs/heads/main`, `${base}/refs/heads/master`];
	const enc = ref
		.split("/")
		.map((s) => encodeURIComponent(s))
		.join("/");
	return [`${base}/${enc}`, `${base}/refs/heads/${enc}`, `${base}/refs/tags/${enc}`];
}

/** 从完整仓库文件里挑出技能（或给出候选）。 */
function narrowToSkill(files, path) {
	const prefix = String(path ?? "").replace(/^\/+|\/+$/g, "");
	if (prefix) {
		// path 直接指到某个文件（blob / raw 形态）：取它所在目录
		if (/\.md$/i.test(prefix) && files.has(prefix)) {
			const root = dirnamePosix(prefix);
			return { ok: true, files: subset(files, root), skillRoot: root };
		}
		if (files.has(joinPosix(prefix, "SKILL.md"))) {
			return { ok: true, files: subset(files, prefix), skillRoot: prefix };
		}
		return fail(`这个位置没有 SKILL.md：${prefix}`, { code: "no-skill-at-path" });
	}

	if (files.has("SKILL.md")) return { ok: true, files };

	const candidates = [...files.keys()]
		.filter((p) => /(^|\/)SKILL\.md$/.test(p))
		.map((p) => {
			const root = dirnamePosix(p);
			return { path: root, label: root ? baseName(root) : "(仓库根目录)" };
		});

	if (candidates.length === 0) return fail("这个来源里没有 SKILL.md", { code: "no-skill" });
	if (candidates.length === 1) return { ok: true, files: subset(files, candidates[0].path) };
	return { ok: true, files, needsPick: true, candidates };
}

function subset(files, prefix) {
	if (!prefix) return files;
	const out = new Map();
	for (const [p, v] of files) {
		if (p === prefix) out.set(baseName(prefix), v);
		else if (p.startsWith(`${prefix}/`)) out.set(p.slice(prefix.length + 1), v);
	}
	return out;
}

/** 单文件能力：把一段 markdown 包成 {SKILL.md}。 */
function packSingleMarkdown(text) {
	return new Map([["SKILL.md", Buffer.from(String(text ?? ""), "utf8")]]);
}

/**
 * @param {object} args
 * @param {object} args.src parseSource 的结果
 * @param {{get:(url:string,opts?:object)=>Promise<any>}} args.http
 * @param {{listPath:Function, readPath:Function, statPath:Function}} [args.fs]
 * @param {(dir:string, reason?:string)=>Promise<boolean>} [args.requestAccess]
 * @param {object} [args.limits]
 */
async function resolvePack({ src, http, fs, requestAccess, limits = {} }) {
	const lim = { ...DEFAULT_LIMITS, ...limits };
	if (!src?.ok) return fail(src?.error ?? "来源无法识别");

	switch (src.kind) {
		case "text":
			return { ok: true, files: packSingleMarkdown(src.content), label: "粘贴的 SKILL.md", meta: { kind: "text" } };

		case "local":
			return readLocal({ path: src.path, fs, requestAccess, lim });

		case "url-md":
		case "url": {
			const res = await http.get(src.url, { maxBytes: lim.textBytes });
			if (!res.ok) return fail(res.error);
			const text = res.buffer.toString("utf8");
			if (!/^---[ \t]*\r?\n/.test(text) && !/#\s/.test(text)) {
				return fail("这个地址不像 SKILL.md（既没有 frontmatter 也没有标题）");
			}
			return { ok: true, files: packSingleMarkdown(text), label: src.url, meta: { kind: "url", url: src.url } };
		}

		case "url-zip": {
			const res = await http.get(src.url, { maxBytes: lim.zipBytes });
			if (!res.ok) return fail(res.error);
			const zip = readZip(res.buffer);
			if (!zip.ok) return fail(zip.error);
			const files = stripCommonRoot(zip.files);
			const narrowed = narrowToSkill(files, "");
			if (!narrowed.ok) return narrowed;
			return {
				...narrowed,
				full: files,
				label: src.repo ?? src.url,
				meta: { kind: "zip", url: src.url, repo: src.repo },
				skipped: zip.skipped,
			};
		}

		case "github": {
			const errors = [];
			let tooBig = false;
			for (const url of zipCandidates(src)) {
				// 先 HEAD 探大小：大仓库直接走 tree API 子目录通道，不浪费流量
				const head = typeof http.head === "function" ? await http.head(url, { timeoutMs: 15_000 }) : { ok: true, contentLength: 0 };
				if (head.ok && head.contentLength > lim.zipBytes) {
					tooBig = true;
					errors.push(`包太大（${(head.contentLength / 1048576).toFixed(0)}MB > ${(lim.zipBytes / 1048576).toFixed(0)}MB）`);
					break;
				}
				// zipball 可能几十 MB：单独给更长的超时
				const res = await http.get(url, { maxBytes: lim.zipBytes, timeoutMs: lim.zipTimeoutMs ?? 60_000 });
				if (!res.ok) {
					errors.push(res.error);
					if (/超过上限/.test(res.error)) {
						tooBig = true;
						break;
					}
					// 404 可能只是「这个 ref 不存在」，可以换下一个试；
					// 超时/超限是仓库本身的问题，换 ref 也没用，直接停。
					const soft = /HTTP 404/.test(res.error);
					if (!soft) break;
					continue;
				}
				const zip = readZip(res.buffer);
				if (!zip.ok) return fail(zip.error);
				const files = stripCommonRoot(zip.files);
				const narrowed = narrowToSkill(files, src.path);
				if (!narrowed.ok) return narrowed;
				return {
					...narrowed,
					full: files,
					label: `${src.owner}/${src.repo}${src.ref ? `@${src.ref}` : ""}${src.path ? `/${src.path}` : ""}`,
					meta: {
						kind: "github",
						repo: `${src.owner}/${src.repo}`,
						ref: src.ref || "",
						path: src.path || "",
						zip: url,
					},
					skipped: zip.skipped,
				};
			}
			// 大仓库：只拉目标子目录（按文件 raw），内存与流量都小得多
			if (tooBig && src.path) {
				const sub = await fetchSubtree({ owner: src.owner, repo: src.repo, ref: src.ref, path: src.path, http });
				if (sub.ok) {
					const narrowed = narrowToSkill(sub.files, src.path);
					if (narrowed.ok) {
						return {
							...narrowed,
							full: sub.files,
							label: `${src.owner}/${src.repo}${src.ref ? `@${src.ref}` : ""}/${src.path}`,
							meta: { kind: "github", repo: `${src.owner}/${src.repo}`, ref: src.ref || "", path: src.path },
							skipped: sub.errors ?? [],
						};
					}
					return narrowed;
				}
				return fail(`${errors[0] || "仓库太大"}；按目录拉取也失败：${sub.error}`, { code: "fetch-failed" });
			}
			if (tooBig) {
				return fail(`${errors[0] || "仓库太大"}，请贴到具体技能目录（tree URL）再导入`, { code: "repo-too-large" });
			}
			return fail(`拉取仓库失败：${errors[0] || "未知错误"}`, { code: "fetch-failed" });
		}

		default:
			return fail(`暂不支持这种来源：${src.kind}`);
	}
}

async function readLocal({ path, fs, requestAccess, lim }) {
	if (!fs) return fail("缺少文件系统适配器");
	let target = path;
	if (target === "~") target = "";
	const ok = requestAccess ? await requestAccess(target, "读取本地技能目录") : true;
	if (!ok) return fail(`没有读取权限：${target}`);

	let stat;
	try {
		stat = await fs.statPath(target);
	} catch (err) {
		return fail(`读不到 ${target}：${err instanceof Error ? err.message : String(err)}`);
	}
	if (stat.type === "file") {
		let buf;
		try {
			buf = await fs.readPath(target);
		} catch (err) {
			return fail(`读取失败：${err instanceof Error ? err.message : String(err)}`);
		}
		if (buf.length > lim.textBytes) return fail("文件太大");
		const files = packSingleMarkdown(buf.toString("utf8"));
		return { ok: true, files, full: files, label: baseName(target), meta: { kind: "local-file", path: target } };
	}

	const files = new Map();
	let count = 0;
	const walk = async (dir, rel, depth) => {
		if (depth > lim.maxDepth) return;
		let entries;
		try {
			entries = await fs.listPath(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === ".git" || e.name === "node_modules" || e.name === ".DS_Store") continue;
			const abs = `${dir}/${e.name}`;
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.type === "dir") {
				await walk(abs, r, depth + 1);
				continue;
			}
			if (++count > lim.maxFiles) throw new Error(`文件太多（>${lim.maxFiles}）`);
			let st;
			try {
				st = await fs.statPath(abs);
			} catch {
				continue;
			}
			if (st.size > 4 * 1024 * 1024) continue;
			files.set(r, await fs.readPath(abs));
		}
	};

	try {
		await walk(target.replace(/\/+$/, ""), "", 0);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
	if (files.size === 0) return fail("目录里没有文件");
	const narrowed = narrowToSkill(files, "");
	if (!narrowed.ok) return narrowed;
	return {
		...narrowed,
		full: files,
		label: baseName(target),
		meta: { kind: "local-dir", path: target },
	};
}

module.exports = { zipCandidates, narrowToSkill, packSingleMarkdown, resolvePack };
