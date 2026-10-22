/**
 * recommend（服务端）—— 技能索引、项目信号、推荐编排、可选 LLM 重排。
 *
 * 索引：把配置的 GitHub 仓库当 zipball 拉一次（复用 fetch.cjs），
 *       从树里挑出每个 SKILL.md 的 name/description，缓存进 host.storage。
 * 信号：当前对话 messages + 工作区文件特征（不联网、不外发）。
 * 重排：仅当设置里开启且宿主有 llm 能力；失败静默回落规则结果。
 */
const { splitFrontmatter } = require("../core/frontmatter.cjs");
const { buildCard, cardLine } = require("../core/card.cjs");
const { buildTask, mergeExpansion } = require("../core/task.cjs");
const { buildBm25Index, bm25Search } = require("../core/bm25.cjs");
const { rrf, dedupe } = require("../core/rrf.cjs");
const { parsePicks } = require("../core/recommend.cjs");
const { buildProfile, scoreCatalog, parseRerank } = require("../core/recommend.cjs");
const { baseName, dirnamePosix } = require("../core/util.cjs");
const { zipCandidates } = require("./fetch.cjs");
const { fetchSourceDocs, fetchRepoMeta } = require("./repo-tree.cjs");

const CATALOG_KEY = "catalog";
/** 索引结构版本：卡片字段变了就 +1，旧缓存自动作废（否则老条目没有能力卡片）。 */
const CATALOG_SCHEMA = 2;
/** 仓库元信息缓存：6 小时内不重复问 GitHub（API 限额 60/h）。 */
const META_TTL_MS = 6 * 60 * 60 * 1000;
/** 查询词覆盖率下限：低于它视为「库中没有合适的技能」。 */
const MIN_COVERAGE = 0.1;
/** 元信息失败后的重试间隔（有旧条目可沿用时不至于每次都重下）。 */
const META_RETRY_MS = 10 * 60 * 1000;
const SOURCES_KEY = "sources";
const FEEDBACK_KEY = "feedback";
const FEEDBACK_MAX = 200;
const marketAsked = { done: false };
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;
// 默认源：官方 → 聚合库 → 社区大库（顺序即去重优先级，名字冲突时保留靠前的描述）
const DEFAULT_SOURCES = [
	"anthropics/skills",
	"feifeifei527/pi-skills-hub",
	"addyosmani/agent-skills",
	"obra/superpowers",
	"peterfei/ai-agent-team",
	"badlogic/pi-skills",
	"ComposioHQ/awesome-claude-skills",
];

/** "owner/repo", "owner/repo#ref", 或 GitHub URL → {owner, repo, ref} */
function parseRepoSpec(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return null;
	let spec = text
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/^git@github\.com:/i, "")
		.replace(/\.git$/i, "");
	let ref = "";
	const hash = spec.indexOf("#");
	if (hash >= 0) {
		ref = spec.slice(hash + 1).trim();
		spec = spec.slice(0, hash);
	}
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2) return null;
	return { owner: segs[0], repo: segs[1], ref };
}

function sourceList(value) {
	const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
	const list = raw
		.split(/[\n,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : DEFAULT_SOURCES;
}

/** 从一个仓库的完整文件树里提取技能条目。 */
function entriesFromTree(files, repo, ref) {
	const out = [];
	const seen = new Set();
	for (const [path, buf] of files) {
		if (!/(^|\/)SKILL\.md$/.test(path)) continue;
		const dir = dirnamePosix(path);
		let fm = { data: {}, body: "" };
		try {
			fm = splitFrontmatter(buf.toString("utf8"));
		} catch {
			fm = { data: {}, body: "" };
		}
		const data = fm.data ?? {};
		const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : baseName(dir);
		const description = typeof data.description === "string" ? data.description.trim() : "";
		if (!name || !description || seen.has(name)) continue;
		seen.add(name);
		// 能力卡片：任务 / 场景 / IO / 限制 / 依赖（规则提取，未声明标 unknown）
		const card = buildCard({
			name,
			description: description.slice(0, 400),
			body: fm.body ?? "",
			frontmatter: data,
			repo,
			path: dir,
			ref: ref || "",
		});
		out.push({
			...card,
			repo,
			ref: ref || "",
			path: dir,
		});
		if (out.length >= MAX_ENTRIES) break;
	}
	return out;
}

async function buildIndex({ sources, http, previous = null, auth = {} }) {
	const errors = [];
	const specs = [];
	for (const raw of sources) {
		const spec = parseRepoSpec(raw);
		if (!spec) {
			errors.push(`${raw}：不是 owner/repo 形式`);
			continue;
		}
		specs.push({ raw, spec, repo: `${spec.owner}/${spec.repo}` });
	}

	// 并发上限 6：再多会互相抢带宽，反而更容易超时
	const prevPerSource = previous?.perSource ?? {};
	const nextPerSource = {};
	const results = [];
	const CONCURRENCY = 6;
	for (let i = 0; i < specs.length; i += CONCURRENCY) {
		const chunk = specs.slice(i, i + CONCURRENCY);
		results.push(...(await Promise.all(
			chunk.map(async ({ spec, repo }) => {
			try {
				// 元信息缓存 6h：避免每次重建都消耗 GitHub API 配额（60/h）
				const cached = prevPerSource[repo];
				// 只有「上次真的问到了」才算新鲜；上次失败（metaOk=false）就继续重试
				const metaFresh = cached?.metaAt && cached.metaOk !== false && Date.now() - cached.metaAt < META_TTL_MS;
				let meta = {
					ok: Boolean(metaFresh),
					pushedAt: cached?.pushedAt ?? "",
					size: cached?.size ?? 0,
				};
				if (!metaFresh) {
					meta = await fetchRepoMeta({ owner: spec.owner, repo: spec.repo, http, auth });
				}
				// 元信息拿不到（配额/网络）且已有旧条目：先沿用，10 分钟后再试
				if (!meta.ok && Array.isArray(cached?.entries) && cached.entries.length) {
					nextPerSource[repo] = { ...cached, metaOk: false, metaAt: Date.now() - META_TTL_MS + META_RETRY_MS };
					return { repo, entries: cached.entries, count: cached.entries.length, via: "stale", error: meta.error };
				}
				if (meta.ok && cached?.pushedAt && cached.pushedAt === meta.pushedAt && Array.isArray(cached.entries)) {
					nextPerSource[repo] = { ...cached, metaOk: true, metaAt: Date.now(), size: meta.size ?? cached.size ?? 0 };
					return { repo, entries: cached.entries, count: cached.entries.length, via: "cache" };
				}
				// 仓库体积（KB）已经超过单包上限 → 直接走 tree，别先下 64MB 再失败
				const sizeBytes = (Number(meta.size) || 0) * 1024;
				// 上次已经证明「包太大」：不再试 zip，直接 tree
				const preferTree = sizeBytes > 64 * 1024 * 1024 || cached?.tooBig === true;
				const docs = await fetchSourceDocs({
					owner: spec.owner,
					repo: spec.repo,
					ref: spec.ref,
					http,
					auth,
					preferTree,
					zipCandidates: zipCandidates({ owner: spec.owner, repo: spec.repo, ref: spec.ref }),
				});
				if (!docs.ok) {
					// 记住「太大」，下次直接走 tree，不再下 64MB 才失败
					if (/超过上限|太大|too large/i.test(docs.error)) {
						nextPerSource[repo] = {
							pushedAt: meta.ok ? meta.pushedAt : "",
							metaOk: Boolean(meta.ok),
							metaAt: Date.now(),
							size: Number(meta.size) || 0,
							ref: spec.ref,
							tooBig: true,
							entries: [],
						};
					}
					return { repo, error: docs.error };
				}
				const entries = entriesFromTree(docs.files, repo, spec.ref);
				if (entries.length === 0) return { repo, error: "没找到 SKILL.md" };
				nextPerSource[repo] = {
					pushedAt: meta.ok ? meta.pushedAt : "",
					metaOk: Boolean(meta.ok),
					metaAt: Date.now(),
					size: Number(meta.size) || 0,
					ref: spec.ref,
					entries,
				};
				return { repo, entries, count: entries.length, via: docs.via };
			} catch (err) {
				return { repo, error: err instanceof Error ? err.message : String(err) };
			}
			}),
		)));
	}

	const entries = [];
	const okSources = [];
	const sourceStats = [];
	for (const r of results) {
		if (r.error) {
			const prev = prevPerSource[r.repo];
			if (Array.isArray(prev?.entries) && prev.entries.length) {
				nextPerSource[r.repo] = prev;
				errors.push(`${r.repo}：${r.error}（已沿用上次索引 ${prev.entries.length} 条）`);
				sourceStats.push({ repo: r.repo, count: prev.entries.length, added: 0, via: "stale", error: r.error });
				for (const e of prev.entries) if (!entries.some((x) => x.name === e.name)) entries.push(e);
				continue;
			}
			errors.push(`${r.repo}：${r.error}`);
			sourceStats.push({ repo: r.repo, count: 0, error: r.error });
			continue;
		}
		okSources.push(r.repo);
		let added = 0;
		for (const e of r.entries) {
			if (entries.some((x) => x.name === e.name)) continue;
			entries.push(e);
			added++;
		}
		sourceStats.push({ repo: r.repo, count: r.count, added, via: r.via });
	}
	return { at: Date.now(), schema: CATALOG_SCHEMA, entries, errors, sources: okSources, sourceStats, perSource: nextPerSource };
}

function messageText(m) {
	if (!m) return "";
	if (typeof m.text === "string") return m.text;
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((b) => b && (b.type === "text" || typeof b.text === "string"))
			.map((b) => b.text ?? "")
			.join(" ");
	}
	return "";
}

async function readProjectSignals(host) {
	const files = {};
	const hints = [];
	const read = async (rel, max = 200_000) => {
		try {
			return await host.fs.readText(rel, max);
		} catch {
			return null;
		}
	};

	const pkg = await read("package.json");
	if (pkg) {
		try {
			const data = JSON.parse(pkg);
			const deps = Object.keys({ ...(data.dependencies ?? {}), ...(data.devDependencies ?? {}) });
			files["package.json"] = deps.join(" ");
		} catch {
			files["package.json"] = pkg.slice(0, 800);
		}
	}
	for (const name of ["pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml"]) {
		const text = await read(name, 60_000);
		if (text) files[name] = text.replace(/[^\w+#.\-\s]/g, " ").slice(0, 600);
	}
	for (const name of ["Dockerfile", "docker-compose.yml", "Makefile"]) {
		const text = await read(name, 4000);
		if (text !== null) files[name] = text.slice(0, 300);
	}

	// 扩展名分布（最多 2 层、400 个文件，避免扫大仓）
	const exts = {};
	const budget = { n: 400 };
	const walk = async (dir, depth) => {
		if (depth > 2 || budget.n <= 0) return;
		let entries;
		try {
			entries = await host.fs.list(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (budget.n <= 0) return;
			if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "build") continue;
			const rel = dir ? `${dir}/${e.name}` : e.name;
			if (e.type === "dir") {
				await walk(rel, depth + 1);
				continue;
			}
			budget.n--;
			const m = /\.([a-z0-9]{1,8})$/i.exec(e.name);
			if (m) exts[m[1].toLowerCase()] = (exts[m[1].toLowerCase()] ?? 0) + 1;
		}
	};
	await walk("", 0);
	const topExts = Object.entries(exts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6)
		.map(([k, v]) => `${k} ${v}`);
	if (topExts.length) files.extensions = topExts.join(" ");

	for (const name of ["AGENTS.md", "README.md", "README.txt"]) {
		const text = await read(name, 20_000);
		if (!text) continue;
		const heading = text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.startsWith("#"));
		if (heading) {
			hints.push(heading.replace(/^#+\s*/, ""));
			break;
		}
	}

	return { files, hints };
}

/** 从 <dataDir>/market-cache/*.json 里收集用户在市场里看过的仓库（零网络）。 */
async function readMarketCacheRepos({ host, requestAccess, asked }) {
	const dir = `${String(host.dataDir ?? "").replace(/\/+$/, "")}/market-cache`;
	if (!dir.startsWith("/")) return [];
	try {
		if (requestAccess && !asked.done) {
			asked.done = true;
			const ok = await requestAccess(dir, "读取技能市场缓存，自动纳入推荐索引的来源仓库");
			if (!ok) return [];
		}
		const entries = await host.fs.listPath(dir);
		const repos = [];
		for (const e of entries) {
			if (e.type !== "file" || !e.name.endsWith(".json")) continue;
			try {
				const raw = await host.fs.readTextPath(`${dir}/${e.name}`, 512 * 1024);
				const data = JSON.parse(raw);
				for (const item of data?.data ?? []) {
					if (typeof item?.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(item.repo)) repos.push(item.repo);
				}
			} catch {
				/* 坏缓存跳过 */
			}
		}
		return repos;
	} catch {
		return [];
	}
}

/** GitHub 搜索一次，拿到更多候选库（官方 API，不是爬页面）。 */
async function discoverSources({ http, limit = 24 }) {
	const queries = ["topic:agent-skills", "topic:claude-skills"];
	const seen = new Map();
	for (const q of queries) {
		const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`;
		const res = await http.get(url, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-web-ui-skill-import" },
			maxBytes: 1024 * 1024,
			timeoutMs: 15_000,
		});
		if (!res.ok) continue;
		let data;
		try {
			data = JSON.parse(res.buffer.toString("utf8"));
		} catch {
			continue;
		}
		for (const item of data?.items ?? []) {
			const repo = String(item?.full_name ?? "");
			if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || seen.has(repo)) continue;
			const desc = String(item.description ?? "");
			// 只留名字或描述里明确提到 skill 的，挡掉靠刷 star 混进来的无关仓库
			if (!/skill/i.test(`${repo} ${desc}`)) continue;
			seen.set(repo, {
				repo,
				stars: Number(item.stargazers_count) || 0,
				description: desc.slice(0, 120),
			});
		}
	}
	return [...seen.values()].sort((a, b) => b.stars - a.stars).slice(0, limit);
}

function createRecommendService({ host, http, getScopes, importService }) {
	let catalog = null; // 内存镜像，storage 是持久层
	let bm25Cache = null;
	const expandCache = new Map();
	const EXPAND_TTL_MS = 10 * 60 * 1000;

	function readFeedback() {
		const raw = host.storage.get(FEEDBACK_KEY, null);
		const out = { ignored: {}, pinned: {} };
		if (raw && typeof raw === "object") {
			if (raw.ignored && typeof raw.ignored === "object") out.ignored = { ...raw.ignored };
			if (raw.pinned && typeof raw.pinned === "object") out.pinned = { ...raw.pinned };
		}
		return out;
	}

	function feedbackView(fb) {
		return { ignored: Object.keys(fb.ignored).sort(), pinned: Object.keys(fb.pinned).sort() };
	}

	function writeFeedback(fb) {
		// 按插入顺序保留最近 200 条（时间戳可能同毫秒，不能拿来排序）
		const trim = (obj) => {
			const keys = Object.keys(obj);
			return Object.fromEntries(keys.slice(Math.max(0, keys.length - FEEDBACK_MAX)).map((k) => [k, obj[k]]));
		};
		host.storage.set(FEEDBACK_KEY, { ignored: trim(fb.ignored), pinned: trim(fb.pinned) });
	}

	/** 忽略 / 恢复 / 钉住 / 取消钉住 */
	function setFeedback({ action, name } = {}) {
		const clean = String(name ?? "").trim();
		if (!clean) return { ok: false, error: "缺少技能名" };
		const fb = readFeedback();
		if (action === "ignore") {
			fb.ignored[clean] = Date.now();
			delete fb.pinned[clean];
		} else if (action === "unignore") {
			delete fb.ignored[clean];
		} else if (action === "pin") {
			fb.pinned[clean] = Date.now();
			delete fb.ignored[clean];
		} else if (action === "unpin") {
			delete fb.pinned[clean];
		} else {
			return { ok: false, error: "未知操作（ignore / unignore / pin / unpin）" };
		}
		writeFeedback(fb);
		return { ok: true, action, name: clean, feedback: feedbackView(fb) };
	}

	function readCatalog() {
		if (catalog) return catalog;
		const raw = host.storage.get(CATALOG_KEY, null);
		if (raw && Array.isArray(raw.entries)) catalog = raw;
		return catalog;
	}

	function settingsValues() {
		try {
			const s = host.getSettings() ?? {};
			const stored = host.storage.get(SOURCES_KEY, null);
			const sources = Array.isArray(stored) && stored.length ? stored : sourceList(s.repos);
			return {
				sources,
				count: Math.max(1, Math.min(Number(s.topN ?? s.count) || 3, 8)),
				// 新键 rerank 默认开；兼容旧的 llmRerank 存储值
				llmRerank: (s.rerank ?? s.llmRerank) !== false,
			};
		} catch {
			return { sources: DEFAULT_SOURCES, count: 3, llmRerank: true };
		}
	}

	/** 实际索引源 = 用户列表 + 已装技能的来源仓库（市场缓存只做「建议加入」）。 */
	async function resolveSources() {
		const base = settingsValues().sources;
		const out = [];
		const push = (repo) => {
			const clean = String(repo ?? "").trim();
			if (!parseRepoSpec(clean)) return;
			if (!out.includes(clean)) out.push(clean);
		};
		for (const r of base) push(r);

		try {
			const listed = await importService.listInstalled();
			for (const scope of listed.scopes ?? []) {
				for (const skill of scope.skills ?? []) {
					const repo = skill.sourceMeta?.repo;
					if (typeof repo === "string") push(repo);
				}
			}
		} catch {
			/* 读不到就只用配置 */
		}

		return out;
	}

	async function listSources() {
		const configured = settingsValues().sources;
		const index = readCatalog();
		const stats = new Map((index?.sourceStats ?? []).map((s) => [s.repo, s]));
		const effective = await resolveSources();
		const known = new Set(effective.map((r) => parseRepoSpec(r)).filter(Boolean).map((s) => `${s.owner}/${s.repo}`));
		const marketRepos = await readMarketCacheRepos({
			host,
			requestAccess: (dir, reason) => host.fs.requestAccess(dir, reason),
			asked: marketAsked,
		});
		const suggestions = [];
		for (const repo of marketRepos) {
			const spec = parseRepoSpec(repo);
			if (!spec) continue;
			const key = `${spec.owner}/${spec.repo}`;
			if (known.has(key) || suggestions.some((x) => x.repo === key)) continue;
			suggestions.push({ repo: key, from: "market" });
		}
		return {
			ok: true,
			configured,
			effective: effective.map((repo) => ({
				repo,
				count: stats.get(repo)?.count ?? null,
				error: stats.get(repo)?.error ?? null,
				added: stats.get(repo)?.added ?? null,
			})),
			suggestions,
			indexAt: index?.at ?? 0,
		};
	}

	async function addSource({ repo, rebuild = true } = {}) {
		const spec = parseRepoSpec(repo);
		if (!spec) return { ok: false, error: "需要 owner/repo 形式" };
		const clean = `${spec.owner}/${spec.repo}${spec.ref ? `#${spec.ref}` : ""}`;
		const list = settingsValues().sources.slice();
		if (list.includes(clean)) return { ok: true, unchanged: true, sources: list };
		list.push(clean);
		host.storage.set(SOURCES_KEY, list);
		catalog = null;
		if (rebuild) await ensureIndex({ force: true });
		return { ok: true, sources: await listSources() };
	}

	async function removeSource({ repo } = {}) {
		const clean = String(repo ?? "").trim();
		const list = settingsValues().sources.filter((r) => r !== clean);
		host.storage.set(SOURCES_KEY, list);
		catalog = null;
		return { ok: true, sources: await listSources() };
	}

	async function discover() {
		const candidates = await discoverSources({ http });
		const configured = new Set(settingsValues().sources.map((r) => parseRepoSpec(r)).filter(Boolean).map((s) => `${s.owner}/${s.repo}`));
		return {
			ok: true,
			candidates: candidates.map((c) => ({ ...c, added: configured.has(c.repo) })),
			cached: readCatalog()?.entries?.length ?? 0,
		};
	}

	async function ensureIndex({ force = false } = {}) {
		const stored = readCatalog();
		const sources = await resolveSources();
		const stale = !stored || Date.now() - (stored.at ?? 0) > CATALOG_TTL_MS;
		const sourcesChanged = stored && JSON.stringify(stored.sources ?? []) !== JSON.stringify(sources.filter(Boolean));
		const schemaStale = stored && stored.schema !== CATALOG_SCHEMA;
		if (!force && !stale && !sourcesChanged && !schemaStale) return stored;

		// 老结构（没有能力卡片）不能复用缓存
		const reusable = stored && stored.schema === CATALOG_SCHEMA ? stored : null;
		const token = String(host.getSettings()?.githubToken ?? "").trim();
		const built = await buildIndex({
			sources,
			http,
			previous: reusable,
			auth: token ? { Authorization: `Bearer ${token}` } : {},
		});
		// 全失败且已有旧索引 → 保留旧的，只更新错误
		if (built.entries.length === 0 && stored?.entries?.length) {
			catalog = { ...stored, errors: built.errors };
			host.storage.set(CATALOG_KEY, catalog);
			return catalog;
		}
		catalog = built;
		host.storage.set(CATALOG_KEY, built);
		return built;
	}

	async function gatherSignals() {
		let snap = null;
		try {
			snap = host.getActiveConversation?.() ?? null;
		} catch {
			snap = null;
		}
		const messages = Array.isArray(snap?.messages)
			? snap.messages
					.map((m) => ({ role: String(m?.role ?? "user"), text: messageText(m).slice(0, 1200) }))
					.filter((m) => m.text.trim())
			: [];
		const project = await readProjectSignals(host);
		return { messages, files: project.files, hints: project.hints, title: snap?.title ?? "" };
	}

	/** BM25 索引按 catalog.at 缓存，避免每次推荐重新分词 1000+ 条。 */
	function getBm25(index) {
		if (!bm25Cache || bm25Cache.at !== index.at) {
			bm25Cache = { at: index.at, index: buildBm25Index(index.entries ?? []) };
		}
		return bm25Cache.index;
	}

	/** LLM 查询扩展：把口语需求扩成技术检索词（按 query 缓存 10 分钟）。 */
	async function expandQuery(task) {
		const key = `${task.queryText}\n${task.projectSummary}`.slice(0, 2000);
		const cached = expandCache.get(key);
		if (cached && Date.now() - cached.at < EXPAND_TTL_MS) return cached.terms;
		try {
			const res = await host.llm?.complete?.({
				system: "你是检索查询扩展器，只输出 JSON。",
				prompt: [
					`任务：${task.task || "(空)"}`,
					`上下文：${task.queryText.slice(0, 600) || "(空)"}`,
					`项目：${task.projectSummary.slice(0, 400) || "(空)"}`,
					'把上面的需求扩成用于检索技能库的词（同义词、技术名词、库名、文件类型）。输出 {"terms":["PPO","reward","训练日志"]}，最多 12 个，只输出 JSON。',
				].join("\n"),
				maxChars: 400,
				timeoutMs: 15_000,
			});
			if (!res?.ok) return null;
			const m = /\{[\s\S]*\}/.exec(String(res.text ?? ""));
			if (!m) return null;
			const data = JSON.parse(m[0]);
			const terms = Array.isArray(data?.terms) ? data.terms.filter((x) => typeof x === "string") : [];
			if (!terms.length) return null;
			expandCache.set(key, { at: Date.now(), terms });
			return terms;
		} catch {
			return null;
		}
	}

	/** LLM 精排：判断「能不能补上已有能力」，允许一个都不推荐。 */
	async function rerankWithLlm({ task, candidates, installedBrief, count }) {
		if (!candidates.length) return { picks: [], error: "" };
		try {
			const res = await host.llm?.complete?.({
				system: "你是技能推荐器，只输出 JSON，不要解释。",
				prompt: [
					`当前任务：${task.task || "(未提供)"}`,
					`上下文：${task.queryText.slice(0, 500) || "(空)"}`,
					`项目：${task.projectSummary.slice(0, 300) || "(空)"}`,
					`已安装技能（判断是否已覆盖）：${installedBrief || "(无)"}`,
					"候选技能（只能从这里选）：",
					...candidates.map((c, i) => `${i + 1}. ${cardLine(c, 200)}`),
					`请判断每个候选能否帮用户完成当前任务、以及相对已装技能能新增什么能力。最多选 ${count} 个，可以一个都不选。`,
					'输出 JSON：{"picks":[{"name":"技能名","reason":"为什么适合当前任务","added_capability":"新增的能力","requirements":["需要提供训练日志"]}]}。',
					"name 必须来自候选列表；没有合适的返回 {\"picks\":[]}。",
				].join("\n"),
				maxChars: 1200,
				timeoutMs: 25_000,
			});
			if (!res?.ok) return { picks: null, error: res?.error ?? "模型调用失败" };
			const picks = parsePicks(res.text, candidates);
			if (picks === null) return { picks: null, error: "模型返回无法解析" };
			return { picks, error: "" };
		} catch (err) {
			return { picks: null, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async function recommend({ force = false, q = "" } = {}) {
		const cfg = settingsValues();
		// 首次没有索引时不要偷偷拉仓库：先告诉 UI「点一下建立索引」
		if (!force && !readCatalog()) {
			return { ok: true, needsIndex: true, items: [], indexCount: 0, indexAt: 0, keywords: [], installedCount: 0, task: null };
		}
		const index = await ensureIndex({ force });
		const installed = new Set();
		try {
			for (const scope of await getScopes()) {
				for (const s of scope.skills ?? []) installed.add(s);
				for (const s of scope.disabledSkills ?? []) installed.add(s);
			}
		} catch {
			/* 读不到落点就当没装过 */
		}

		const signals = await gatherSignals();
		// q 是调试/评测用的显式查询：有它就不看当前对话
		const query = String(q ?? "").trim();
		const task = buildTask({
			messages: query ? [{ role: "user", text: query }] : signals.messages,
			project: query ? {} : { files: signals.files, hints: signals.hints },
		});

		// ---- 混合检索：base BM25 + 扩展词 BM25，RRF 合并 ----
		const bm25 = getBm25(index);
		const listA = bm25Search(bm25, task.keywords, { limit: 30 });

		let expandedTerms = [];
		let expandError = "";
		if (cfg.llmRerank) {
			const terms = await expandQuery(task);
			if (terms?.length) expandedTerms = terms;
		}
		const listB = expandedTerms.length
			? bm25Search(bm25, mergeExpansion(task.keywords, expandedTerms), { limit: 30 })
			: [];

		const merged = rrf([listA, listB].filter((l) => l.length), { limit: 30 });
		const fb = readFeedback();
		const ignored = new Set(Object.keys(fb.ignored));

		// 覆盖率兜底：连一个查询词都撞不上（或撞得极少）→ 不当作候选。
		// 「没有合适的技能」在规则层先挡一道，剩下的交给模型精排。
		const baseCount = Math.max(1, task.keywords.length);
		const queryTokens = [...new Set([...task.keywords, ...expandedTerms.map((t) => String(t).toLowerCase())])];
		// 已装命中：不推荐，但明确告诉用户「直接用这个」
		const installedHits = [];
		for (const m of merged) {
			const entry = m.item?.card ?? m.item;
			if (!entry?.name || !installed.has(entry.name)) continue;
			const hay = `${entry.name} ${entry.description ?? ""} ${(entry.tasks ?? []).join(" ")}`.toLowerCase();
			const matched = queryTokens.filter((t) => hay.includes(t)).length;
			if (matched === 0) continue;
			installedHits.push({ name: entry.name, matched });
			if (installedHits.length >= 3) break;
		}
		const candidateEntries = dedupe(
			merged
				.map((m) => {
					const entry = m.item?.card ?? m.item;
					if (!entry?.name) return null;
					if (installed.has(entry.name) || ignored.has(entry.name)) return null;
					const hay = `${entry.name} ${entry.description ?? ""} ${(entry.tasks ?? []).join(" ")}`.toLowerCase();
					const matched = queryTokens.filter((t) => hay.includes(t)).length;
					const coverage = matched / baseCount;
					if (matched === 0 || coverage < MIN_COVERAGE) return null;
					return { ...entry, score: Number(m.score.toFixed(4)), coverage: Number(coverage.toFixed(2)), rrfRanks: m.ranks };
				})
				.filter(Boolean),
		).slice(0, 20);

		// 钉住：优先展示（已装/已忽略的不算），最多占 count 条
		const pinnedItems = [];
		for (const name of Object.keys(fb.pinned)) {
			if (installed.has(name) || ignored.has(name)) continue;
			const entry = (index.entries ?? []).find((e) => e.name === name);
			if (entry) pinnedItems.push({ ...entry, score: 999, why: ["钉住"], pinned: true });
			if (pinnedItems.length >= cfg.count) break;
		}
		const prependPinned = (list) => {
			const seen = new Set(pinnedItems.map((p) => p.name));
			return [...pinnedItems, ...list.filter((x) => !seen.has(x.name))].slice(0, cfg.count);
		};

		// ---- LLM 精排 ----
		let items = [];
		let usedLLM = false;
		let llmSaysNone = false;
		let llmError = expandError;
		if (candidateEntries.length > 0) {
			if (cfg.llmRerank) {
				const installedBrief = [...installed].slice(0, 12).join("、");
				const reranked = await rerankWithLlm({ task, candidates: candidateEntries, installedBrief, count: cfg.count });
				if (reranked.picks !== null) {
					// 注意：picks=[] 是模型的明确结论（库里没有合适的），不能回落
					usedLLM = true;
					items = reranked.picks.slice(0, cfg.count);
					if (items.length === 0) llmSaysNone = true;
				} else {
					llmError = reranked.error || llmError;
				}
			}
			if (items.length === 0 && !llmSaysNone) {
				// 回落：规则 top N（打上来源说明，UI 会区分）
				items = candidateEntries.slice(0, cfg.count).map((c) => ({ ...c, reason: "关键词匹配", fallback: true }));
			}
		}

		return {
			ok: true,
			items: prependPinned(items),
			feedback: feedbackView(fb),
			usedLLM,
			llmSaysNone,
			llmError,
			task: { text: task.task, capabilities: task.capabilities, keywords: task.keywords.slice(0, 10) },
			expandedTerms: expandedTerms.slice(0, 10),
			keywords: task.keywords.slice(0, 8).map((t) => ({ token: t, weight: 1 })),
			candidatesCount: candidateEntries.length,
			installedHits,
			debugCounts: { a: listA.length, b: listB.length, merged: merged.length, installed: installed.size },
			indexAt: index.at ?? 0,
			indexCount: (index.entries ?? []).length,
			indexErrors: index.errors ?? [],
			sourceStats: index.sourceStats ?? [],
			installedCount: installed.size,
			conversationTitle: signals.title,
		};
	}

	/** 一键安装：从索引条目还原来源 → 走 importService 的 preview/install（含冲突检查）。 */
	async function installRecommended({ name, scopeId, overwrite = false } = {}) {
		const index = readCatalog() ?? (await ensureIndex());
		const entry = (index.entries ?? []).find((e) => e.name === String(name ?? "").trim());
		if (!entry) return { ok: false, error: `索引里没有「${name}」` };
		const source = `${entry.repo}${entry.ref ? `#${entry.ref}` : ""}`;
		const preview = await importService.preview({ source, path: entry.path, scopeId });
		if (!preview.ok) return { ok: false, error: preview.error };
		if (preview.needsPick) return { ok: false, error: "这个来源需要指定技能路径" };
		if (!preview.inspection?.ok) {
			return {
				ok: false,
				error: "校验未通过，先看看问题",
				issues: (preview.inspection?.issues ?? []).filter((i) => i.level === "error"),
			};
		}
		const res = await importService.install({ token: preview.token, path: entry.path, scopeId, overwrite });
		if (res.ok) catalog = null; // 装完让下次推荐重新算 installed
		return res;
	}

	return {
		recommend,
		ensureIndex,
		installRecommended,
		listSources,
		addSource,
		removeSource,
		discover,
		setFeedback,
		listFeedback: () => ({ ok: true, feedback: feedbackView(readFeedback()) }),
		_reset: () => (catalog = null),
	};
}

module.exports = {
	createRecommendService,
	buildIndex,
	entriesFromTree,
	parseRepoSpec,
	sourceList,
	discoverSources,
	readMarketCacheRepos,
	DEFAULT_SOURCES,
};
