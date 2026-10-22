/**
 * import-service —— 预览 / 安装 / 回滚 / 已装列表 / 更新检查 / 健康检查。
 * 状态：内存里缓存「已下载但还没装」的文件包（token），registry 落在 host.storage。
 */
const { randomUUID } = require("node:crypto");
const { checkConflicts, describeConflict } = require("../core/conflicts.cjs");
const { inspectPack, summarize } = require("../core/inspect.cjs");
const { installSkill, rollbackInstall } = require("../core/install.cjs");
const { diffPacks, describeDiff } = require("../core/diff.cjs");
const { baseName, joinPosix } = require("../core/util.cjs");
const { narrowToSkill, resolvePack } = require("./fetch.cjs");
const { parseSource } = require("../core/source.cjs");
const { readDirPack } = require("./fs-pack.cjs");

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 6;
const REGISTRY_KEY = "installs";
const REGISTRY_MAX = 50;
const META_FILE = ".skill-import.json";
/** 停用的技能搬进这里：Pi 的扫描跳过点开头目录。 */
const DISABLED_DIR = ".disabled";
const MAX_CHECK = 40;

function slimInspection(inspection) {
	const { skill, issues } = inspection;
	return {
		ok: inspection.ok,
		issues,
		skill: {
			root: skill.root,
			name: skill.name,
			dirName: skill.dirName,
			description: skill.description,
			frontmatter: skill.frontmatter,
			references: skill.references,
			totals: skill.totals,
			files: skill.files.slice(0, 80),
			truncatedFiles: Math.max(0, skill.files.length - 80),
		},
		summary: summarize(inspection),
	};
}

/** .skill-import.json 里记的来源 → 可重新拉取的来源对象。 */
function sourceFromMeta(meta) {
	const sm = meta?.sourceMeta ?? {};
	if (sm.kind === "github" && sm.repo) {
		const [owner, repo] = String(sm.repo).split("/");
		if (!owner || !repo) return null;
		return { ok: true, kind: "github", owner, repo, ref: sm.ref ?? "", path: sm.path ?? "" };
	}
	if (sm.kind === "zip" && sm.url) return { ok: true, kind: "url-zip", url: sm.url, repo: sm.repo };
	if ((sm.kind === "local-dir" || sm.kind === "local-file") && sm.path) return { ok: true, kind: "local", path: sm.path };
	return null;
}

function createImportService({ host, http, ops, getScopes }) {
	/** @type {Map<string, {full:Map<string,Buffer>, label:string, meta:object, at:number, skipped:string[]}>} */
	const cache = new Map();
	/** 仓库级缓存：同一个 repos@ref 的整仓包复用，避免每装一个技能重下 20s+。 */
	const repoCache = new Map();
	const REPO_CACHE_TTL_MS = 10 * 60 * 1000;
	const REPO_CACHE_MAX_BYTES = 96 * 1024 * 1024;

	function repoCacheKey(src) {
		if (src?.kind !== "github") return "";
		return `gh:${String(src.owner).toLowerCase()}/${String(src.repo).toLowerCase()}@${src.ref ?? ""}`;
	}

	function pruneRepoCache() {
		const now = Date.now();
		let total = 0;
		for (const [key, value] of [...repoCache.entries()].sort((a, b) => b[1].at - a[1].at)) {
			total += value.bytes ?? 0;
			if (now - value.at > REPO_CACHE_TTL_MS || total > REPO_CACHE_MAX_BYTES) repoCache.delete(key);
		}
	}

	/**
	 * 拉取来源并保留仓库级缓存。
	 * 关键：把目标 path 传给下载层，大仓库才能走「只拉子目录」通道，而不是整包下载后超限。
	 */
	async function resolveRepo(src, wantedPath = "") {
		const key = repoCacheKey(src);
		const hit = key ? repoCache.get(key) : null;
		if (hit && Date.now() - hit.at < REPO_CACHE_TTL_MS) {
			const narrowed = narrowToSkill(hit.files, wantedPath);
			if (narrowed.ok) {
				return { ...narrowed, full: hit.files, label: hit.label, meta: hit.meta, skipped: [], cached: true };
			}
		} else if (hit) {
			repoCache.delete(key);
		}

		const resolved = await resolvePack({
			src: { ...src, path: wantedPath },
			http,
			fs: host.fs,
			requestAccess: (dir, reason) => host.fs.requestAccess(dir, reason),
		});
		// 只缓存整仓 zip：子树结果不是整仓，缓存了反而会让后续安装选错范围
		if (resolved.ok && key && resolved.meta?.zip && resolved.full) {
			const bytes = [...resolved.full.values()].reduce((n, buf) => n + buf.length, 0);
			if (bytes <= REPO_CACHE_MAX_BYTES) {
				repoCache.set(key, { at: Date.now(), files: resolved.full, label: resolved.label, meta: resolved.meta, bytes });
				pruneRepoCache();
			}
		}
		return resolved;
	}

	function pruneCache() {
		const now = Date.now();
		for (const [k, v] of cache) if (now - v.at > CACHE_TTL_MS) cache.delete(k);
		while (cache.size > CACHE_MAX) {
			const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (!oldest) break;
			cache.delete(oldest[0]);
		}
	}

	function readRegistry() {
		const raw = host.storage.get(REGISTRY_KEY, []);
		return Array.isArray(raw) ? raw : [];
	}
	function writeRegistry(list) {
		host.storage.set(REGISTRY_KEY, list.slice(0, REGISTRY_MAX));
	}

	/** 磁盘上已经不存在的记录顺手清掉（用户手动删了技能目录）。 */
	async function prunedRegistry() {
		const list = readRegistry();
		const alive = [];
		for (const r of list) {
			if (r?.target && (await ops.exists(r.target))) alive.push(r);
		}
		if (alive.length !== list.length) writeRegistry(alive);
		return alive;
	}

	function pickScope(scopes, scopeId) {
		return scopeId ? scopes.find((s) => s.id === scopeId) ?? null : scopes.find((s) => s.writable) ?? null;
	}

	async function readMetaAt(dir) {
		try {
			const raw = await host.fs.readTextPath(joinPosix(dir, META_FILE), 64 * 1024);
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	async function readMeta(scope, name) {
		return readMetaAt(joinPosix(scope.path, name));
	}

	/** 启用中的位置（目录或单文件）。 */
	async function findActive(scope, name) {
		const dir = joinPosix(scope.path, name);
		if ((scope.skills ?? []).includes(name) && (await ops.exists(dir))) return { kind: "dir", path: dir };
		const file = joinPosix(scope.path, `${name}.md`);
		if ((scope.skillFiles ?? []).includes(`${name}.md`) && (await ops.exists(file))) return { kind: "file", path: file };
		return null;
	}

	/** 停用区的位置。 */
	async function findParked(scope, name) {
		const dir = joinPosix(scope.path, DISABLED_DIR, name);
		if ((scope.disabledSkills ?? []).includes(name) && (await ops.exists(dir))) return { kind: "dir", path: dir };
		const file = joinPosix(scope.path, DISABLED_DIR, `${name}.md`);
		if ((scope.disabledFiles ?? []).includes(`${name}.md`) && (await ops.exists(file))) return { kind: "file", path: file };
		return null;
	}

	/** 在作用域里定位技能：启用中的目录 / 单文件 / 停用区。 */
	async function locateSkill(scope, name) {
		const activeDir = joinPosix(scope.path, name);
		const activeFile = joinPosix(scope.path, `${name}.md`);
		const disabledDir = joinPosix(scope.path, DISABLED_DIR, name);
		const disabledFile = joinPosix(scope.path, DISABLED_DIR, `${name}.md`);
		if ((scope.skills ?? []).includes(name) && (await ops.exists(activeDir))) {
			return { kind: "dir", path: activeDir, enabled: true };
		}
		if ((scope.skillFiles ?? []).includes(`${name}.md`) && (await ops.exists(activeFile))) {
			return { kind: "file", path: activeFile, enabled: true };
		}
		if ((scope.disabledSkills ?? []).includes(name) && (await ops.exists(disabledDir))) {
			return { kind: "dir", path: disabledDir, enabled: false };
		}
		if ((scope.disabledFiles ?? []).includes(`${name}.md`) && (await ops.exists(disabledFile))) {
			return { kind: "file", path: disabledFile, enabled: false };
		}
		return null;
	}

	async function fetchFull(src) {
		const resolved = await resolveRepo(src, "");
		if (!resolved.ok) throw new Error(resolved.error);
		return resolved.full ?? resolved.files;
	}

	/** 预览：source 或 token（+path）→ 校验结果、候选、冲突、与已装版本的 diff。 */
	async function preview({ source, token, path, scopeId } = {}) {
		pruneCache();
		let entry = token ? cache.get(token) : null;
		if (token && !entry) return { ok: false, error: "预览已过期，请重新拉取来源" };

		if (!entry) {
			const src = parseSource(source);
			if (!src.ok) return { ok: false, error: src.error, hint: src.hint };
			const resolved = await resolveRepo(src, String(path ?? src.path ?? ""));
			if (!resolved.ok) return { ok: false, error: resolved.error, code: resolved.code };
			const id = randomUUID();
			entry = {
				full: resolved.full ?? resolved.files,
				label: resolved.label,
				meta: resolved.meta,
				at: Date.now(),
				skipped: resolved.skipped ?? [],
			};
			cache.set(id, entry);
			token = id;
		}

		const wantedPath = String(path ?? entry.meta?.path ?? "");
		const narrowed = narrowToSkill(entry.full, wantedPath);
		if (!narrowed.ok) return { ok: false, error: narrowed.error, code: narrowed.code };
		// 记住这次选中的技能路径：后续 install 不带 path 也能落到同一个技能
		if (!narrowed.needsPick && wantedPath) {
			entry.meta = { ...(entry.meta ?? {}), path: wantedPath };
		}

		const scopes = await getScopes();
		const scope = pickScope(scopes, scopeId);
		const dirNameHint = wantedPath ? baseName(wantedPath) : "";
		const inspection = inspectPack({ files: narrowed.files, label: entry.label, dirNameHint });
		const skillName = inspection.skill.name || inspection.skill.dirName;
		// 声明名与目录名可能不一致：两个都查一遍，避免漏掉历史目录
		const names = [...new Set([skillName, inspection.skill.dirName].filter(Boolean))];
		const merged = { name: skillName, found: [], winner: null, shadowed: [] };
		for (const n of names) {
			const c = checkConflicts({ name: n, scopes });
			for (const f of c.found) if (!merged.found.some((x) => x.path === f.path)) merged.found.push(f);
		}
		merged.winner = merged.found[0] ?? null;
		merged.shadowed = merged.found.slice(1);
		const conflicts = merged;

		// 目标位置已有同名 → 给出内容 diff（覆盖前先看清楚）
		let diff = null;
		let diffSummary = "";
		const collidesHere = conflicts.found.some((f) => f.scopeId === scope?.id);
		if (collidesHere && skillName) {
			try {
				const current = await readDirPack(host.fs, joinPosix(scope.path, skillName));
				diff = diffPacks(current, narrowed.files);
				diffSummary = describeDiff(diff);
			} catch {
				diff = null;
			}
		}

		return {
			ok: true,
			token,
			source: { label: entry.label, meta: entry.meta, skipped: entry.skipped },
			needsPick: Boolean(narrowed.needsPick),
			candidates: narrowed.candidates ?? [],
			path: wantedPath,
			scopeId: scope?.id ?? null,
			scopes: scopes.map((s) => ({
				id: s.id,
				label: s.label,
				path: s.path,
				writable: s.writable,
				authorized: s.authorized,
				count: s.count,
			})),
			inspection: slimInspection(inspection),
			conflicts,
			diff,
			diffSummary,
			conflictHint: describeConflict(conflicts, scope?.id),
		};
	}

	/** 真正的落盘：install 与 update 共用。 */
	async function writeInstall({ files, inspection, scope, sourceLabel, sourceMeta, overwrite }) {
		if (!inspection.ok) {
			return {
				ok: false,
				error: "校验未通过，先修好再装",
				issues: inspection.issues.filter((i) => i.level === "error"),
			};
		}
		if (!scope.writable) return { ok: false, error: `${scope.label} 不是可写入的落点` };

		const name = inspection.skill.name || inspection.skill.dirName;
		if (!name) return { ok: false, error: "技能没有名字" };

		const target = joinPosix(scope.path, name);
		const exists = await ops.exists(target);
		let diff = null;
		if (exists) {
			try {
				diff = diffPacks(await readDirPack(host.fs, target), files);
			} catch {
				diff = null;
			}
			if (!overwrite) {
				return {
					ok: false,
					code: "conflict",
					error: "目标位置已有同名技能",
					conflictHint: `${name} 已存在于 ${target}${diff ? `；${describeDiff(diff)}` : ""}`,
					diff,
				};
			}
		}

		if (!(await ops.ensureAccess(scope.path))) return { ok: false, error: `没有写入权限：${scope.path}` };

		const now = Date.now();
		const result = await installSkill({
			files,
			skillRoot: "",
			target,
			ops,
			now,
			meta: {
				version: 1,
				name,
				scope: scope.id,
				source: sourceLabel,
				sourceMeta,
				installedAt: now,
				tool: "skill-import",
			},
		});
		if (!result.ok) return { ok: false, error: result.error };

		await pruneBackups(scope.path, name);
		const record = {
			id: randomUUID(),
			name,
			scopeId: scope.id,
			scopePath: scope.path,
			target,
			backup: result.backup,
			source: sourceLabel,
			at: now,
		};
		writeRegistry([record, ...readRegistry()]);

		return {
			ok: true,
			name,
			scopeId: scope.id,
			target,
			backup: result.backup,
			files: result.files,
			installId: record.id,
			diff,
			diffSummary: diff ? describeDiff(diff) : "",
			needsReload: true,
		};
	}

	async function install({ token, path, scopeId, overwrite = false } = {}) {
		const entry = token ? cache.get(token) : null;
		if (!entry) return { ok: false, error: "预览已过期，请重新预览" };

		const wantedPath = String(path ?? entry.meta?.path ?? "");
		const narrowed = narrowToSkill(entry.full, wantedPath);
		if (!narrowed.ok) return { ok: false, error: narrowed.error };

		const dirNameHint = wantedPath ? baseName(wantedPath) : "";
		const inspection = inspectPack({ files: narrowed.files, label: entry.label, dirNameHint });
		const scopes = await getScopes();
		const scope = pickScope(scopes, scopeId);
		if (!scope) return { ok: false, error: "没有可写入的技能落点" };

		const res = await writeInstall({
			files: narrowed.files,
			inspection,
			scope,
			sourceLabel: entry.label,
			sourceMeta: entry.meta,
			overwrite,
		});
		if (res.ok) cache.delete(token);
		return res;
	}

	async function rollback({ id } = {}) {
		const list = readRegistry();
		const record = list.find((r) => r.id === id);
		if (!record) return { ok: false, error: "找不到这条安装记录" };
		if (!record.backup) return { ok: false, error: "这次安装没有备份（首次安装无法回滚）" };
		if (!(await getScopes()).some((scope) => scope.path === record.scopePath && scope.writable)) {
			return { ok: false, error: "这条安装记录不属于当前项目的可写落点" };
		}
		if (!(await ops.exists(record.backup))) return { ok: false, error: `备份已被清理：${record.backup}` };

		const res = await rollbackInstall({ target: record.target, backup: record.backup, ops });
		if (!res.ok) return { ok: false, error: res.error };
		writeRegistry(list.filter((r) => r.id !== id));
		return { ok: true, name: record.name, scopeId: record.scopeId, target: record.target, needsReload: true };
	}

	/** 每个技能只留最近 2 份备份，其余删掉。 */
	async function pruneBackups(scopePath, name) {
		try {
			const entries = await ops.listDir(scopePath);
			const prefix = `.${name}.__backup-`;
			const mine = entries
				.filter((n) => n.startsWith(prefix))
				.sort()
				.reverse();
			for (const old of mine.slice(2)) await ops.removeTree(joinPosix(scopePath, old));
		} catch {
			/* 清理失败不影响安装结果 */
		}
	}

	/** 停用 = 搬进 <scope>/.disabled/；启用 = 搬回来。 */
	async function setEnabled({ name, scopeId, enabled } = {}) {
		const cleanName = String(name ?? "").trim();
		if (!cleanName) return { ok: false, error: "缺少技能名" };
		const scopes = await getScopes();
		const scope = pickScope(scopes, scopeId);
		if (!scope) return { ok: false, error: "找不到技能落点" };
		if (!scope.writable) return { ok: false, error: `${scope.label} 不可写` };
		const wantEnabled = Boolean(enabled);

		const active = await findActive(scope, cleanName);
		const parked = await findParked(scope, cleanName);

		if (wantEnabled) {
			if (!parked) {
				if (active) return { ok: true, name: cleanName, scopeId: scope.id, enabled: true, unchanged: true };
				return { ok: false, error: `找不到技能「${cleanName}」` };
			}
			if (active) {
				return { ok: false, error: `已有一份启用的「${cleanName}」，先改个名字再启用` };
			}
			const dest = joinPosix(scope.path, parked.kind === "file" ? `${cleanName}.md` : cleanName);
			try {
				await ops.rename(parked.path, dest);
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
			return { ok: true, name: cleanName, scopeId: scope.id, enabled: true, path: dest, needsReload: true };
		}

		if (!active) {
			if (parked) return { ok: true, name: cleanName, scopeId: scope.id, enabled: false, unchanged: true };
			return { ok: false, error: `找不到技能「${cleanName}」` };
		}
		const disabledRoot = joinPosix(scope.path, DISABLED_DIR);
		const dest = joinPosix(disabledRoot, active.kind === "file" ? `${cleanName}.md` : cleanName);
		try {
			await ops.mkdirp(disabledRoot);
			await ops.rename(active.path, dest);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		return { ok: true, name: cleanName, scopeId: scope.id, enabled: false, path: dest, needsReload: true };
	}

	/** 删除技能（目录或单文件）。只允许删作用域里列出来的技能，不接受任意路径。 */
	async function removeSkill({ name, scopeId } = {}) {
		const cleanName = String(name ?? "").trim();
		if (!cleanName) return { ok: false, error: "缺少技能名" };
		const scopes = await getScopes();
		const scope = pickScope(scopes, scopeId);
		if (!scope) return { ok: false, error: "找不到技能落点" };
		if (!scope.writable) return { ok: false, error: `${scope.label} 不可写` };
		const found = await locateSkill(scope, cleanName);
		if (!found) return { ok: false, error: `找不到技能「${cleanName}」` };
		try {
			await ops.removeTree(found.path);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		writeRegistry(readRegistry().filter((r) => !(r.scopePath === scope.path && r.name === cleanName)));
		return { ok: true, name: cleanName, scopeId: scope.id, wasEnabled: found.enabled, needsReload: true };
	}

	/** 读一个技能的完整内容（下载用）。 */
	async function readSkill({ name, scopeId } = {}) {
		const cleanName = String(name ?? "").trim();
		if (!cleanName) return { ok: false, error: "缺少技能名" };
		const scopes = await getScopes();
		const scope = pickScope(scopes, scopeId);
		if (!scope) return { ok: false, error: "找不到技能落点" };
		const found = await locateSkill(scope, cleanName);
		if (!found) return { ok: false, error: `找不到技能「${cleanName}」` };
		try {
			if (found.kind === "file") {
				const buf = await host.fs.readPath(found.path);
				return { ok: true, name: cleanName, files: new Map([[`${cleanName}.md`, buf]]) };
			}
			const files = await readDirPack(host.fs, found.path);
			return { ok: true, name: cleanName, files };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	async function listInstalled() {
		const scopes = await getScopes();
		const registry = await prunedRegistry();
		const out = [];
		for (const scope of scopes) {
			const skills = [];
			for (const name of scope.skills ?? []) {
				const dir = joinPosix(scope.path, name);
				const meta = await readMeta(scope, name);
				const record = registry.find((r) => r.target === dir);
				skills.push({
					name,
					path: dir,
					enabled: true,
					managed: Boolean(meta),
					source: meta?.source ?? null,
					sourceMeta: meta?.sourceMeta ?? null,
					installedAt: meta?.installedAt ?? null,
					installId: record?.id ?? null,
					backup: record?.backup ?? null,
				});
			}
			for (const name of scope.disabledSkills ?? []) {
				const dir = joinPosix(scope.path, DISABLED_DIR, name);
				const meta = await readMetaAt(dir);
				skills.push({
					name,
					path: dir,
					enabled: false,
					managed: Boolean(meta),
					source: meta?.source ?? null,
					sourceMeta: meta?.sourceMeta ?? null,
					installedAt: meta?.installedAt ?? null,
					installId: null,
					backup: null,
				});
			}
			out.push({
				id: scope.id,
				label: scope.label,
				path: scope.path,
				writable: scope.writable,
				authorized: scope.authorized,
				skills,
			});
		}
		return { ok: true, scopes: out };
	}

	/**
	 * 检查更新：按 .skill-import.json 记的来源重新拉一次，跟磁盘内容做哈希对比。
	 * 同一仓库只下载一次；最多检查 MAX_CHECK 个。
	 */
	async function checkUpdates() {
		repoCache.clear();
		const scopes = await getScopes();
		const items = [];
		for (const scope of scopes) {
			if (!scope.writable) continue;
			for (const name of scope.skills ?? []) {
				if (items.length >= MAX_CHECK) break;
				const meta = await readMeta(scope, name);
				if (!meta) continue;
				const src = sourceFromMeta(meta);
				if (!src) {
					items.push({ name, scopeId: scope.id, source: meta.source, status: "no-source" });
					continue;
				}
				try {
					const full = await fetchFull(src);
					const narrowed = narrowToSkill(full, src.path ?? "");
					if (!narrowed.ok) throw new Error(narrowed.error);
					const current = await readDirPack(host.fs, joinPosix(scope.path, name));
					const diff = diffPacks(current, narrowed.files);
					items.push({
						name,
						scopeId: scope.id,
						source: meta.source,
						status: diff.identical ? "up-to-date" : "update-available",
						diff,
						summary: describeDiff(diff),
					});
				} catch (err) {
					items.push({
						name,
						scopeId: scope.id,
						source: meta.source,
						status: "error",
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}
		return {
			ok: true,
			checked: items.length,
			items,
			updates: items.filter((i) => i.status === "update-available").length,
			checkedAt: Date.now(),
		};
	}

	/** 按记录的来源更新某个已装技能（保留备份）。 */
	async function update({ name, scopeId } = {}) {
		const cleanName = String(name ?? "").trim();
		if (!cleanName) return { ok: false, error: "缺少技能名" };
		const scopes = await getScopes();
		let scope = null;
		let meta = null;
		for (const s of scopes) {
			if (scopeId && s.id !== scopeId) continue;
			const m = await readMeta(s, cleanName);
			if (m) {
				scope = s;
				meta = m;
				break;
			}
		}
		if (!scope || !meta) return { ok: false, error: `找不到「${cleanName}」的安装记录（不是本插件装的？）` };
		const src = sourceFromMeta(meta);
		if (!src) return { ok: false, error: "这条技能没有可追溯的来源，无法自动更新" };

		const full = await fetchFull(src);
		const narrowed = narrowToSkill(full, src.path ?? "");
		if (!narrowed.ok) return { ok: false, error: narrowed.error };
		const inspection = inspectPack({ files: narrowed.files, label: meta.source ?? cleanName, dirNameHint: cleanName });
		const res = await writeInstall({
			files: narrowed.files,
			inspection,
			scope,
			sourceLabel: meta.source ?? cleanName,
			sourceMeta: meta.sourceMeta ?? {},
			overwrite: true,
		});
		return res.ok ? { ...res, updated: true } : res;
	}

	/** 健康检查：所有可读落点里的技能，校验规范 / 引用 / 重名 shadow。 */
	async function health() {
		const scopes = await getScopes();
		const items = [];
		for (const scope of scopes) {
			for (const name of scope.skills ?? []) {
				const dir = joinPosix(scope.path, name);
				let pack;
				try {
					pack = await readDirPack(host.fs, dir);
				} catch (err) {
					items.push({
						name,
						scopeId: scope.id,
						path: dir,
						ok: false,
						issues: [{ level: "error", code: "unreadable", message: err instanceof Error ? err.message : String(err) }],
					});
					continue;
				}
				if (pack.size === 0) continue;
				const inspection = inspectPack({ files: pack, label: name, dirNameHint: name });
				const meta = await readMeta(scope, name);
				items.push({
					name,
					scopeId: scope.id,
					path: dir,
					managed: Boolean(meta),
					ok: inspection.ok,
					summary: summarize(inspection),
					issues: inspection.issues.filter((i) => i.level !== "info"),
				});
			}
			for (const file of scope.skillFiles ?? []) {
				items.push({
					name: file.replace(/\.md$/i, ""),
					scopeId: scope.id,
					path: joinPosix(scope.path, file),
					ok: true,
					singleFile: true,
					summary: "单文件技能",
					issues: [],
				});
			}
		}

		const byName = new Map();
		for (const item of items) {
			if (!byName.has(item.name)) byName.set(item.name, []);
			byName.get(item.name).push(item);
		}
		const duplicates = [...byName.entries()]
			.filter(([, list]) => list.length > 1)
			.map(([name, list]) => ({ name, scopes: list.map((i) => i.scopeId) }));

		const errors = items.reduce((n, i) => n + i.issues.filter((x) => x.level === "error").length, 0);
		const warns = items.reduce((n, i) => n + i.issues.filter((x) => x.level === "warn").length, 0);
		return { ok: true, items, duplicates, totals: { skills: items.length, errors, warns, duplicates: duplicates.length } };
	}

	return {
		preview,
		install,
		rollback,
		listInstalled,
		checkUpdates,
		update,
		health,
		setEnabled,
		removeSkill,
		readSkill,
		_cache: cache,
	};
}

module.exports = { createImportService, sourceFromMeta };
