/**
 * inspect —— 把一个「文件集合」鉴定成技能包：定位 SKILL.md、校验规范、
 * 检查正文引用的相对路径是否真的存在、统计体积与可疑文件。
 *
 * 全部纯函数：files 是 Map<posix相对路径, Buffer>。
 */
const { splitFrontmatter, validateFrontmatter } = require("./frontmatter.cjs");
const { baseName, dirnamePosix, joinPosix } = require("./util.cjs");

// 体积/数量：超过 warn 线只提醒，超过 max 线才拦（真实技能带字体/图片，5MB 很常见）
const WARN_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const WARN_FILE_COUNT = 300;
const MAX_FILE_COUNT = 1000;

const EXEC_EXTS = /\.(sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts|ps1|bat|cmd|exe)$/i;
const BINARY_EXTS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp[34]|wav|sqlite|db)$/i;

const KNOWN_DIR = /^(scripts?|references?|assets?|examples?|templates?|docs?)\//i;
const EXT_RE =
	/\.(md|markdown|txt|py|sh|bash|zsh|js|mjs|cjs|ts|json|ya?ml|toml|csv|tsv|png|jpe?g|gif|svg|pdf|zip|html?|css|rb|go|rs|java|sql|ipynb|xlsx?|docx?|pptx?|bib|tex|r)$/i;
/** 正文里的裸文件名常相对于这些子目录（技能作者的习惯写法）。 */
const REF_BASES = ["", "references/", "scripts/", "assets/"];

function issue(level, code, message, hint) {
	return hint ? { level, code, message, hint } : { level, code, message };
}

/** 从正文里抽取「看起来是技能内相对路径」的引用。 */
function extractReferences(body) {
	const found = new Map();
	const add = (raw, kind) => {
		let p = String(raw ?? "").trim();
		if (!p) return;
		if (/^(https?:|mailto:|data:|ftp:|#|\/)/i.test(p)) return;
		p = p.replace(/^\.\//, "").replace(/[).,;:'"`\]]+$/, "");
		if (!p || p.includes("\\") || p.length > 160) return;
		if (/[\s{}<>*?|]/.test(p)) return;
		if (p.startsWith(".") || p.includes(":")) return; // .png / 隐藏文件 / model id
		const isDir = p.endsWith("/");
		if (isDir) p = p.replace(/\/+$/, "");
		if (!/^[\w.@\-/]+$/.test(p)) return;
		// 只认「已知目录开头」或「像文件名」的，避免把 google/gemini-x 这类当路径
		if (!KNOWN_DIR.test(p) && !(EXT_RE.test(p) && /^[A-Za-z0-9_][\w.@\-/]*$/.test(p))) return;
		const prev = found.get(p);
		if (prev) prev.count += 1;
		else found.set(p, { ref: p, kind, count: 1, isDir });
	};

	const text = String(body);
	// markdown 链接 / 图片
	for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) add(m[1], "link");
	// 行内代码里出现的路径
	for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1], "code");
	// 裸的已知目录：先去掉 URL，再要求左边界不是单词字符
	// （否则 subscript/superscript、https://x/docs/components 都会被误判）
	const noUrls = text.replace(/https?:\/\/\S+/g, " ");
	for (const m of noUrls.matchAll(/(?<![\w./-])(?:\.\/)?(?:scripts?|references?|assets?|examples?|templates?|docs?)\/[\w.@\-/]+/g)) {
		add(m[0], "bare");
	}

	return [...found.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

function isBinary(buf) {
	if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
	const probe = buf.subarray(0, Math.min(512, buf.length));
	for (const byte of probe) if (byte === 0) return true;
	return false;
}

/** 定位技能根：优先根目录 SKILL.md，其次唯一的 **\/SKILL.md。 */
function findSkillRoot(files) {
	if (files.has("SKILL.md")) return { root: "", candidates: ["SKILL.md"] };
	const candidates = [...files.keys()].filter((p) => /(^|\/)SKILL\.md$/.test(p));
	if (candidates.length === 1) return { root: dirnamePosix(candidates[0]), candidates };
	return { root: null, candidates };
}

/**
 * @param {{files:Map<string,Buffer>, label?:string, limits?:{maxBytes?:number,maxFiles?:number}}} args
 */
function inspectPack({ files, label = "", dirNameHint = "", limits = {} }) {
	const maxBytes = limits.maxBytes ?? MAX_TOTAL_BYTES;
	const warnBytes = limits.warnBytes ?? WARN_TOTAL_BYTES;
	const maxFiles = limits.maxFiles ?? MAX_FILE_COUNT;
	const warnFiles = limits.warnFiles ?? WARN_FILE_COUNT;
	const issues = [];
	const list = [...files.entries()].map(([path, buf]) => ({ path, buf }));

	// 1. 找 SKILL.md
	const located = findSkillRoot(files);
	if (located.root === null) {
		if (located.candidates.length === 0) {
			return {
				ok: false,
				skill: { root: "", name: "", dirName: "", description: "", files: [], references: [], totals: { files: files.size, bytes: 0 } },
				issues: [issue("error", "skill-md-missing", "包里没有 SKILL.md", "技能目录必须包含 SKILL.md")],
			};
		}
		return {
			ok: false,
			skill: { root: "", name: "", dirName: "", description: "", files: [], references: [], totals: { files: files.size, bytes: 0 } },
			issues: [
				issue(
					"error",
					"skill-md-ambiguous",
					`包里发现 ${located.candidates.length} 个 SKILL.md，无法确定装哪一个`,
					located.candidates.slice(0, 5).join("、"),
				),
			],
		};
	}

	const root = located.root;
	const skillMdPath = joinPosix(root, "SKILL.md");
	const skillMd = files.get(skillMdPath)?.toString("utf8") ?? "";
	const parsed = splitFrontmatter(skillMd);
	if (parsed.error) issues.push(issue("error", "frontmatter-unclosed", parsed.error));
	if (!parsed.present) {
		issues.push(issue("error", "frontmatter-missing", "SKILL.md 缺少 frontmatter", "文件开头需要 --- 包住 name/description"));
	}

	// 2. 技能内文件（剥掉根前缀）
	const inner = list
		.filter((f) => (root ? f.path.startsWith(`${root}/`) : true))
		.map((f) => ({ path: root ? f.path.slice(root.length + 1) : f.path, buf: f.buf }));

	const dirName = root ? baseName(root) : String(dirNameHint ?? "");
	const data = parsed.data ?? {};
	const rawName = typeof data.name === "string" ? data.name.trim() : "";
	const declaredDescription = typeof data.description === "string" ? data.description.trim() : "";
	const name = rawName || dirName;

	// 3. 规范校验
	issues.push(...validateFrontmatter(data, { dirName: dirName || undefined }));

	// 4. 引用完整性
	const refs = extractReferences(parsed.body);
	const innerSet = new Set(inner.map((f) => f.path));
	const dirs = new Set();
	for (const p of innerSet) {
		const segs = p.split("/");
		for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
	}
	for (const r of refs) {
		const hit = REF_BASES.some((base) => {
			const p = base + r.ref;
			return r.isDir ? dirs.has(p) : innerSet.has(p);
		});
		if (hit) continue;
		// 强信号：带已知目录前缀 / markdown 链接 / 裸路径——这些基本就是技能自带文件
		const strong = r.kind === "link" || r.kind === "bare" || KNOWN_DIR.test(r.ref);
		issues.push(
			strong
				? issue(
						"warn",
						"reference-missing",
						`正文引用了「${r.ref}」，但包里没有这个文件`,
						r.kind === "code" ? "导进来的技能会读不到它，模型会卡住" : undefined,
					)
				: issue(
						"info",
						"reference-hint",
						`正文提到了「${r.ref}」，包里没有（可能只是示例文件名）`,
					),
		);
	}

	// 5. 体积 / 数量 / 可疑文件
	const bytes = inner.reduce((n, f) => n + f.buf.length, 0);
	if (bytes > maxBytes) {
		issues.push(issue("error", "pack-too-large", `技能包太大（${(bytes / 1048576).toFixed(1)}MB > ${maxBytes / 1048576}MB）`));
	} else if (bytes > warnBytes) {
		issues.push(issue("warn", "pack-large", `技能包偏大（${(bytes / 1048576).toFixed(1)}MB）`, "每次加载会多读一些文件"));
	}
	if (inner.length > maxFiles) {
		issues.push(issue("error", "pack-too-many-files", `文件太多（${inner.length} > ${maxFiles}）`));
	} else if (inner.length > warnFiles) {
		issues.push(issue("warn", "pack-many-files", `文件较多（${inner.length} 个）`));
	}

	const filesInfo = inner.map((f) => ({
		path: f.path,
		size: f.buf.length,
		binary: isBinary(f.buf),
		exec: EXEC_EXTS.test(f.path),
	}));
	const execFiles = filesInfo.filter((f) => f.exec).map((f) => f.path);
	if (execFiles.length > 0) {
		issues.push(
			issue(
				"info",
				"has-executables",
				`包含 ${execFiles.length} 个可执行脚本`,
				execFiles.slice(0, 6).join("、") + (execFiles.length > 6 ? " …" : ""),
			),
		);
	}
	const hasLicense =
		typeof data.license === "string" || innerSet.has("LICENSE") || innerSet.has("LICENSE.md") || innerSet.has("LICENSE.txt");
	if (!hasLicense) issues.push(issue("info", "no-license", "没有 license 声明（分享给别人时可能需要）"));

	const disabled = data["disable-model-invocation"] === true;
	if (disabled) {
		issues.push(issue("info", "model-invocation-disabled", "该技能只能通过 /skill:name 手动触发"));
	}

	const ok = issues.every((i) => i.level !== "error");
	return {
		ok,
		skill: {
			root,
			skillMdPath,
			name,
			dirName: dirName || name,
			description: declaredDescription,
			frontmatter: data,
			body: parsed.body,
			references: refs.map((r) => r.ref),
			files: filesInfo,
			totals: { files: inner.length, bytes },
			label,
		},
		issues,
	};
}

/** 供 UI 展示的一句话摘要。 */
function summarize(inspection) {
	const errors = inspection.issues.filter((i) => i.level === "error").length;
	const warns = inspection.issues.filter((i) => i.level === "warn").length;
	const s = `${inspection.skill.totals.files} 个文件 / ${(inspection.skill.totals.bytes / 1024).toFixed(1)}KB`;
	if (errors) return `${errors} 个错误 · ${s}`;
	if (warns) return `${warns} 个警告 · ${s}`;
	return `可以安装 · ${s}`;
}

module.exports = { extractReferences, findSkillRoot, inspectPack, summarize };
