/**
 * ops —— 把 host.fs 适配成 core/install 需要的写操作接口。
 *
 * host.fs 没有 rename，所以「改名」用「递归拷贝 + 删源」实现：
 * 技能包很小（几十个文件），代价可接受；失败由 install 的 catch 兜底还原。
 * 所有写入口都会先过 requestAccess（工作区内直接放行）。
 */
function createOps(host) {
	const granted = new Set();

	const ensureAccess = async (dir) => {
		const abs = String(dir ?? "").replace(/\/+$/, "");
		if (!abs) return true;
		if (granted.has(abs)) return true;
		const ok = await host.fs.requestAccess(abs, "技能导入需要写入这个技能目录");
		if (ok) granted.add(abs);
		return Boolean(ok);
	};

	const exists = async (p) => {
		try {
			await host.fs.statPath(p);
			return true;
		} catch {
			return false;
		}
	};

	const copyTree = async (from, to) => {
		await host.fs.mkdirPath(to);
		const entries = await host.fs.listPath(from);
		for (const e of entries) {
			const src = `${from}/${e.name}`;
			const dst = `${to}/${e.name}`;
			if (e.type === "dir") {
				await copyTree(src, dst);
			} else {
				await host.fs.writePath(dst, await host.fs.readPath(src));
			}
		}
	};

	return {
		ensureAccess,
		exists,
		mkdirp: async (p) => {
			if (!(await ensureAccess(p))) throw new Error(`没有写入权限：${p}`);
			await host.fs.mkdirPath(p);
		},
		writeFile: async (p, data) => {
			const parent = p.slice(0, p.lastIndexOf("/")) || "/";
			if (!(await ensureAccess(parent))) throw new Error(`没有写入权限：${parent}`);
			await host.fs.writePath(p, data);
		},
		removeTree: async (p) => {
			if (!(await ensureAccess(p.slice(0, p.lastIndexOf("/")) || "/"))) return;
			await host.fs.removePath(p);
		},
		listDir: async (p) => (await host.fs.listPath(p)).map((e) => e.name),
		rename: async (from, to) => {
			if (!(await ensureAccess(to.slice(0, to.lastIndexOf("/")) || "/"))) throw new Error(`没有写入权限：${to}`);
			await copyTree(from, to);
			await host.fs.removePath(from);
		},
	};
}

module.exports = { createOps };
