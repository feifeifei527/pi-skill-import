/**
 * source —— 把用户粘进来的东西识别成「可拉取的来源」。
 * 纯字符串解析，不联网；怎么取由调用方（fetcher）决定。
 */

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const RAW_HOST = "raw.githubusercontent.com";
const CODELOAD_HOST = "codeload.github.com";

function ok(kind, rest) {
	return { ok: true, kind, ...rest };
}
function bad(error, hint) {
	return hint ? { ok: false, error, hint } : { ok: false, error };
}

function cleanRepo(seg) {
	return String(seg ?? "").replace(/\.git$/i, "");
}

function parseHash(input) {
	const i = input.lastIndexOf("#");
	if (i <= 0) return { input, ref: "" };
	return { input: input.slice(0, i), ref: decodeURIComponent(input.slice(i + 1).trim()) };
}

/**
 * @param {string} raw
 * @returns {{ok:true, kind:string, [k:string]:unknown} | {ok:false, error:string, hint?:string}}
 */
function parseSource(raw) {
	const original = String(raw ?? "").trim();
	if (!original) return bad("来源为空");

	// 显式前缀：text:/npm:/git:/file:
	const prefixed = /^(text|npm|git|file):([\s\S]+)$/i.exec(original);
	if (prefixed) {
		const scheme = prefixed[1].toLowerCase();
		const rest = prefixed[2].trim();
		if (scheme === "text") return ok("text", { content: rest });
		if (scheme === "file") return ok("local", { path: rest, explicit: true });
		if (scheme === "npm") {
			return bad("npm 包来源还没实现", "先支持 GitHub / zip / 本地目录；npm 放到第二版");
		}
		if (scheme === "git") return parseGitUrl(rest) ?? bad(`无法识别的 git 地址：${rest}`);
	}

	// 本地路径（绝对 / ~ / 相对）
	if (/^(~\/|\/|\.{1,2}\/)/.test(original)) return ok("local", { path: original });

	// ssh 形式的 GitHub
	const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(original);
	if (ssh) return ok("github", { owner: ssh[1], repo: cleanRepo(ssh[2]), ref: "", path: "", form: "repo" });

	// 有 scheme 的 URL
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(original)) {
		let url;
		try {
			url = new URL(original);
		} catch {
			return bad(`URL 解析失败：${original}`);
		}
		const host = url.hostname.toLowerCase();

		if (GITHUB_HOSTS.has(host)) {
			const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (segs.length < 2) return bad("GitHub 地址至少需要 owner/repo");
			const owner = segs[0];
			const repo = cleanRepo(segs[1]);
			const rest = segs.slice(2);
			const hashRef = parseHash(original).ref;
			if (rest[0] === "tree" || rest[0] === "blob") {
				const ref = hashRef || rest[1] || "";
				const path = (hashRef ? rest.slice(1) : rest.slice(2)).join("/");
				return ok("github", { owner, repo, ref, path, form: rest[0] });
			}
			if (rest[0] === "archive" || rest[0] === "zipball") {
				return ok("url-zip", { url: original, repo: `${owner}/${repo}` });
			}
			if (/\.zip$/i.test(url.pathname)) return ok("url-zip", { url: original });
			return ok("github", { owner, repo, ref: hashRef, path: "", form: "repo", url: original });
		}

		if (host === RAW_HOST) {
			const segs = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			if (segs.length < 3) return bad("raw.githubusercontent.com 地址缺少 ref/path");
			const [owner, repo, ...rest] = segs;
			const hashRef = parseHash(original).ref;
			return ok("github", {
				owner,
				repo: cleanRepo(repo),
				ref: hashRef || rest[0],
				path: rest.slice(1).join("/"),
				form: "raw",
			});
		}

		if (host === CODELOAD_HOST) return ok("url-zip", { url: original });
		if (/\.zip$/i.test(url.pathname)) return ok("url-zip", { url: original });
		if (/\.(md|markdown)$/i.test(url.pathname)) return ok("url-md", { url: original });
		return ok("url", { url: original });
	}

	// 裸 owner/repo（允许 #ref 后缀）
	const bareInput = parseHash(original);
	const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(bareInput.input);
	if (bare) {
		return ok("github", { owner: bare[1], repo: cleanRepo(bare[2]), ref: bareInput.ref, path: "", form: "repo" });
	}

	return bad(`无法识别的来源：${original.slice(0, 80)}`, "支持 owner/repo、GitHub 链接、zip 链接、本地路径、粘贴 SKILL.md");
}

function parseGitUrl(rest) {
	if (/^https?:\/\/github\.com\//i.test(rest)) return parseSource(rest);
	const ssh = /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(rest);
	if (ssh) return { ok: true, kind: "github", owner: ssh[1], repo: cleanRepo(ssh[2]), ref: "", path: "", form: "repo" };
	return null;
}

/** 给 UI 用的一句话描述。 */
function describeSource(src) {
	if (!src?.ok) return "无法识别";
	switch (src.kind) {
		case "github":
			return `GitHub · ${src.owner}/${src.repo}${src.ref ? `@${src.ref}` : ""}${src.path ? ` / ${src.path}` : ""}`;
		case "url-zip":
			return `zip 包 · ${src.repo ?? shortUrl(src.url)}`;
		case "url-md":
		case "url":
			return `直链 · ${shortUrl(src.url)}`;
		case "local":
			return `本地 · ${src.path}`;
		case "text":
			return "粘贴的 SKILL.md";
		default:
			return src.kind;
	}
}

function shortUrl(u) {
	try {
		const url = new URL(u);
		const tail = url.pathname.split("/").filter(Boolean).pop() ?? "";
		return `${url.hostname}/${tail}`.slice(0, 60);
	} catch {
		return String(u).slice(0, 60);
	}
}

/**
 * 直达 SKILL.md 的 raw 地址。
 * 注意：raw.githubusercontent.com 的 URL 里 ref 与 path 的切分不影响结果
 * （两者拼起来就是同一串路径），所以这里不需要猜 ref。
 * 仓库形态（没有 path）没法直接拼——交给 API 探测，返回空数组。
 */
function rawCandidates(src) {
	if (src?.kind !== "github") return [];
	const tail = [src.ref, src.path].filter(Boolean).join("/");
	if (!tail) return [];
	const url = /\.[a-z0-9]+$/i.test(tail)
		? `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${tail}`
		: `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${tail}/SKILL.md`;
	return [url];
}

module.exports = { parseSource, describeSource, rawCandidates };
