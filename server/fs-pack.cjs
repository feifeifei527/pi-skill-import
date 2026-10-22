/**
 * fs-pack —— 从磁盘目录读成内存文件包（用于 diff / 健康检查 / 更新对比）。
 * 跳过点开头条目（.git / .skill-import.json / 备份目录）与常见噪音目录。
 */
const DEFAULT_LIMITS = { maxFiles: 1200, maxDepth: 8, maxFileBytes: 4 * 1024 * 1024 };

async function readDirPack(fs, dir, limits = {}) {
	const lim = { ...DEFAULT_LIMITS, ...limits };
	const files = new Map();
	let count = 0;

	const walk = async (abs, rel, depth) => {
		if (depth > lim.maxDepth) return;
		const entries = await fs.listPath(abs);
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			if (e.name === "node_modules") continue;
			const childAbs = `${abs}/${e.name}`;
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.type === "dir") {
				await walk(childAbs, childRel, depth + 1);
				continue;
			}
			if (++count > lim.maxFiles) throw new Error(`文件太多（>${lim.maxFiles}）`);
			let st;
			try {
				st = await fs.statPath(childAbs);
			} catch {
				continue;
			}
			if (st.size > lim.maxFileBytes) continue;
			files.set(childRel, await fs.readPath(childAbs));
		}
	};

	await walk(String(dir).replace(/\/+$/, ""), "", 0);
	return files;
}

module.exports = { readDirPack };
