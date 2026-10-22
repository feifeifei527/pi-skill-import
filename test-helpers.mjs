/** 测试共用：zip 构造器 + Map 包构造。 */
import { readdir, readFile, stat, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

export function crc32(buf) {
	let c = -1;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

/** entries: [{name, data, method?:0|8}] */
export function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const e of entries) {
		const nameBuf = Buffer.from(e.name, "utf8");
		const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
		const method = e.method ?? 8;
		const comp = method === 8 ? deflateRawSync(data) : data;
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(comp.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, comp);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x800, 8);
		cen.writeUInt16LE(method, 10);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(comp.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt32LE(offset, 42);
		centrals.push(cen, nameBuf);

		offset += 30 + nameBuf.length + comp.length;
	}
	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, eocd]);
}

export function packFrom(entries) {
	return new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8")]));
}

export const SKILL_MD = `---
name: pdf-tools
description: 从 PDF 提取文本与表格，当用户需要读取、转换或检查 PDF 时使用。
---

# PDF tools

先读 \`references/formats.md\`，再跑 \`scripts/extract.sh\`。
`;


// ---------- 假宿主（node:fs 支撑，storage 用 Map） ----------

export function createFakeHost(root) {
	const storage = new Map();
	return {
		root,
		storage: {
			get: (k, d) => (storage.has(k) ? storage.get(k) : d),
			set: (k, v) => storage.set(k, v),
			delete: (k) => storage.delete(k),
			all: () => Object.fromEntries(storage),
		},
		fs: {
			listPath: async (abs) =>
				readdir(abs, { withFileTypes: true }).then((es) =>
					es.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
				),
			readPath: async (abs) => readFile(abs),
			readTextPath: async (abs) => readFile(abs, "utf8"),
			statPath: async (abs) => {
				const st = await stat(abs);
				return { name: abs.split("/").pop(), type: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs };
			},
			mkdirPath: async (abs) => mkdir(abs, { recursive: true }),
			writePath: async (abs, data) => writeFile(abs, data),
			removePath: async (abs) => rm(abs, { recursive: true, force: true }),
			requestAccess: async () => true,
			authorizedDirs: () => [root],
		},
	};
}

export async function listScope(host, id, label, dir) {
	let skills = [];
	let skillFiles = [];
	let disabledSkills = [];
	let disabledFiles = [];
	try {
		const entries = await host.fs.listPath(dir);
		skills = entries.filter((e) => e.type === "dir" && !e.name.startsWith(".")).map((e) => e.name).sort();
		skillFiles = entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name);
	} catch {
		/* 目录不存在 = 空 */
	}
	try {
		const parked = await host.fs.listPath(join(dir, ".disabled"));
		disabledSkills = parked.filter((e) => e.type === "dir").map((e) => e.name).sort();
		disabledFiles = parked.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name);
	} catch {
		/* 没有停用区 */
	}
	return {
		id,
		label,
		path: dir,
		writable: true,
		authorized: true,
		skills,
		skillFiles,
		disabledSkills,
		disabledFiles,
		count: skills.length,
	};
}

export async function makeScopes(host, skillsDir, globalDir) {
	return [await listScope(host, "project", "项目", skillsDir), await listScope(host, "global", "全局", globalDir)];
}

export function fakeHttp(zipBuffer) {
	const calls = [];
	let current = zipBuffer;
	return {
		calls,
		set(buffer) {
			current = buffer;
		},
		get: async (url, opts) => {
			calls.push({ url, opts });
			return { ok: true, status: 200, buffer: current, contentType: "application/zip", url };
		},
	};
}

