/**
 * install —— 把技能包原子地落到磁盘。
 *
 * 写操作全部经过注入的 ops（宿主侧走 host.fs，测试侧走 node:fs），
 * 步骤：staging 写入 → 旧版本改名备份 → staging 改名为正式目录。
 * 任一步失败都尽量把现场还原（见 rollbackInstall）。
 */
const { joinPosix } = require("./util.cjs");

const META_FILE = ".skill-import.json";

function adapterError(err) {
	return err instanceof Error ? err.message : String(err);
}

/**
 * @param {object} args
 * @param {Map<string,Buffer>} args.files 包内全部文件（POSIX 相对路径）
 * @param {string} args.skillRoot 技能根（"" 表示根目录就是技能）
 * @param {string} args.target 目标目录（绝对路径）
 * @param {{mkdirp:(p:string)=>Promise<void>, writeFile:(p:string,data:Buffer)=>Promise<void>,
 *          removeTree:(p:string)=>Promise<void>, exists:(p:string)=>Promise<boolean>,
 *          rename:(a:string,b:string)=>Promise<void>}} args.ops
 * @param {object} [args.meta] 写入 .skill-import.json 的来源信息
 * @param {number} [args.now]
 */
async function installSkill({ files, skillRoot, target, ops, meta, now = Date.now() }) {
	// 用点开头的同级隐藏目录：Pi 的 skill 扫描会跳过 "." 开头的条目，
	// 备份/暂存目录因此不会变成幽灵技能。
	const parent = target.slice(0, target.lastIndexOf("/")) || "/";
	const base = target.slice(parent.length + 1);
	const staging = `${parent}/.${base}.__staging-${now}`;
	const backup = `${parent}/.${base}.__backup-${now}`;
	const written = [];
	let backedUp = false;

	try {
		await ops.mkdirp(staging);
		for (const [path, data] of files) {
			const rel = skillRoot && path.startsWith(`${skillRoot}/`) ? path.slice(skillRoot.length + 1) : path;
			if (!rel || rel === META_FILE) continue;
			const dest = joinPosix(staging, rel);
			const dir = dest.slice(0, dest.lastIndexOf("/"));
			if (dir) await ops.mkdirp(dir);
			await ops.writeFile(dest, data);
			written.push(rel);
		}
		if (written.length === 0) throw new Error("没有可写入的文件（技能包为空）");
		if (meta) {
			await ops.writeFile(joinPosix(staging, META_FILE), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8"));
		}

		if (await ops.exists(target)) {
			await ops.rename(target, backup);
			backedUp = true;
		}
		await ops.rename(staging, target);
		return { ok: true, target, backup: backedUp ? backup : null, files: written.length };
	} catch (err) {
		// 尽力还原：staging 清掉；若已把旧版挪走，再挪回来
		try {
			await ops.removeTree(staging);
		} catch {
			/* ignore */
		}
		if (backedUp) {
			try {
				await ops.rename(backup, target);
			} catch {
				/* ignore */
			}
		}
		return { ok: false, error: adapterError(err), target, files: written.length };
	}
}

/** 撤销一次安装：删掉当前目录，把备份还原回去。 */
async function rollbackInstall({ target, backup, ops }) {
	try {
		if (await ops.exists(target)) await ops.removeTree(target);
		if (backup && (await ops.exists(backup))) await ops.rename(backup, target);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: adapterError(err) };
	}
}

/** 清理 staging/备份残留（安装成功后可留备份，由调用方决定）。 */
async function cleanupLeftovers({ target, ops }) {
	const removed = [];
	try {
		const parent = target.slice(0, target.lastIndexOf("/"));
		const prefix = target.slice(parent + 1);
		const n = await ops.listDir(parent);
		for (const name of n) {
			if (!name.startsWith(`.${prefix}.__staging-`) && !name.startsWith(`.${prefix}.__backup-`)) continue;
			await ops.removeTree(joinPosix(parent, name));
			removed.push(name);
		}
	} catch {
		/* 目录不存在/无权限都不影响主流程 */
	}
	return removed;
}

module.exports = { installSkill, rollbackInstall, cleanupLeftovers };
