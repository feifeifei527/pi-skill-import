/**
 * zip-write —— 零依赖 zip 打包（下载技能用）。
 * 每个条目选 deflate 或 store 中更小的那个；文件名带 UTF-8 标记。
 */
const { deflateRawSync } = require("node:zlib");

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name:string, data:Buffer}> | Map<string,Buffer>} entries
 * @returns {Buffer}
 */
function writeZip(entries) {
	const list = entries instanceof Map ? [...entries].map(([name, data]) => ({ name, data })) : entries;
	const locals = [];
	const centrals = [];
	let offset = 0;

	for (const e of list) {
		const name = String(e.name ?? "").replace(/^\/+/, "");
		if (!name) continue;
		const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
		const nameBuf = Buffer.from(name, "utf8");
		const deflated = deflateRawSync(data);
		const useDeflate = deflated.length < data.length;
		const body = useDeflate ? deflated : data;
		const method = useDeflate ? 8 : 0;
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		locals.push(local, nameBuf, body);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x800, 8);
		cen.writeUInt16LE(method, 10);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(body.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt32LE(offset, 42);
		centrals.push(cen, nameBuf);

		offset += 30 + nameBuf.length + body.length;
	}

	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	const count = centrals.length / 2;
	eocd.writeUInt16LE(count, 8);
	eocd.writeUInt16LE(count, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { writeZip, crc32 };
