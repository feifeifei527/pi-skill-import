/**
 * zip —— 零依赖 zip 读取（中央目录法），够装技能包用。
 *
 * 支持：store(0) / deflate(8)、UTF-8 文件名、目录项。
 * 不支持：加密、zip64（>4GB）、分卷——遇到直接给明确错误。
 * 安全：拒绝绝对路径与 `..`（zip-slip），限制条目数与总解压体积。
 */
const { inflateRawSync } = require("node:zlib");

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const MAX_ENTRIES = 4000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;


function fail(error, filtered = 0) {
	return { ok: false, files: new Map(), skipped: [], filtered, error };
}

function findEocd(buf) {
	const min = Math.max(0, buf.length - 0xffff - 22);
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) return i;
	}
	return -1;
}

/** 归一化并校验包内路径；非法返回 null。 */
function safeEntryPath(name) {
	const p = String(name ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "");
	if (!p || p.endsWith("/")) return null;
	if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
	const segs = p.split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
	if (segs[0] === "__MACOSX") return null;
	if (p === ".DS_Store" || p.endsWith("/.DS_Store")) return null;
	return p;
}

/**
 * @param {Buffer} buf
 * @param {{filter?:(name:string)=>boolean, maxEntries?:number, maxTotalBytes?:number}} [opts]
 *   filter 在解压**之前**按文件名过滤：只 inflate 命中的条目，
 *   大仓库（几百 MB）也能只取几个 SKILL.md 而不炸内存。
 * @returns {{ok:true, files:Map<string,Buffer>, skipped:string[], filtered:number} | {ok:false, files:Map, skipped:string[], filtered:number, error:string}}
 */
function readZip(buf, opts = {}) {
	const filter = typeof opts.filter === "function" ? opts.filter : null;
	const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
	const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_BYTES;
	let filtered = 0;

	if (!Buffer.isBuffer(buf) || buf.length < 22) return fail("不是有效的 zip：文件太小");
	const eocd = findEocd(buf);
	if (eocd < 0) return fail("不是有效的 zip：找不到中央目录（EOCD）");

	const entryCount = buf.readUInt16LE(eocd + 10);
	const cdSize = buf.readUInt32LE(eocd + 12);
	const cdOffset = buf.readUInt32LE(eocd + 16);
	if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		return fail("暂不支持 zip64（>4GB 的包）");
	}
	if (entryCount > maxEntries) return fail(`包内条目过多（${entryCount} > ${maxEntries}）`);
	if (cdOffset + cdSize > buf.length) return fail("zip 结构损坏：中央目录越界");

	const files = new Map();
	const skipped = [];
	let total = 0;
	let p = cdOffset;

	for (let n = 0; n < entryCount; n++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
			return fail(`zip 结构损坏：第 ${n + 1} 个中央目录项签名不对`);
		}
		const flags = buf.readUInt16LE(p + 8);
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const uncompSize = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const extAttr = buf.readUInt32LE(p + 38);
		const localOffset = buf.readUInt32LE(p + 42);
		const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
		const name = nameBuf.toString(flags & 0x800 ? "utf8" : "utf8");
		p += 46 + nameLen + extraLen + commentLen;

		if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
			return fail("暂不支持 zip64 条目");
		}
		if (flags & 0x1) {
			skipped.push(`${name}（加密条目，跳过）`);
			continue;
		}

		const unixMode = extAttr >>> 16;
		const isDir = name.endsWith("/") || (unixMode & 0o170000) === 0o040000;
		if (isDir) continue;
		if (filter && !filter(name)) {
			filtered++;
			continue;
		}

		const safe = safeEntryPath(name);
		if (!safe) {
			skipped.push(`${name}（非法路径，跳过）`);
			continue;
		}
		if (uncompSize > MAX_ENTRY_BYTES) {
			skipped.push(`${name}（单文件 ${(uncompSize / 1048576).toFixed(1)}MB 超限，跳过）`);
			continue;
		}
		total += uncompSize;
		if (total > maxTotalBytes) return fail(`解压后体积超限（>${maxTotalBytes / 1048576}MB）`, filtered);

		if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) {
			return fail(`zip 结构损坏：${name} 的本地头无效`);
		}
		const locNameLen = buf.readUInt16LE(localOffset + 26);
		const locExtraLen = buf.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + locNameLen + locExtraLen;
		const dataEnd = dataStart + compSize;
		if (dataEnd > buf.length) return fail(`zip 结构损坏：${name} 数据越界`);
		const comp = buf.subarray(dataStart, dataEnd);

		let data;
		try {
			if (method === 0) data = Buffer.from(comp);
			else if (method === 8) data = inflateRawSync(comp);
			else {
				skipped.push(`${name}（压缩方式 ${method} 不支持，跳过）`);
				continue;
			}
		} catch {
			return fail(`解压失败：${name}`);
		}
		files.set(safe, data);
	}

	if (files.size === 0) return fail(filter ? "包内没有匹配的文件" : "包内没有可用文件", filtered);
	return { ok: true, files, skipped, filtered };
}

/** 包里只有一个顶层目录时剥掉它（GitHub zipball 就是这种形状）。 */
function stripCommonRoot(files) {
	const paths = [...files.keys()];
	if (paths.length === 0) return files;
	const roots = new Set(paths.map((p) => p.split("/")[0]));
	if (roots.size !== 1) return files;
	const root = [...roots][0];
	if (paths.every((p) => !p.includes("/"))) return files; // 全是顶层文件，不剥
	if (paths.some((p) => p === root)) return files; // 顶层还有个同名文件，不剥
	const out = new Map();
	for (const [p, v] of files) out.set(p.slice(root.length + 1), v);
	return out;
}

module.exports = { safeEntryPath, readZip, stripCommonRoot };
