/** POSIX 路径小工具（zip 包内路径一律用 /，与宿主 OS 无关）。 */

function joinPosix(...parts) {
	return parts
		.filter((p) => p !== undefined && p !== null && p !== "")
		.join("/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "");
}

function dirnamePosix(p) {
	const i = String(p ?? "").lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

function baseName(p) {
	const s = String(p ?? "").replace(/\/+$/, "");
	const i = s.lastIndexOf("/");
	return i < 0 ? s : s.slice(i + 1);
}

/** 是否落在某个目录内（POSIX、已归一化）。 */
function isInside(parent, child) {
	const p = String(parent ?? "").replace(/\/+$/, "");
	const c = String(child ?? "");
	if (!p) return !c.startsWith("/") && !c.split("/").includes("..");
	return c === p || c.startsWith(`${p}/`);
}

module.exports = { joinPosix, dirnamePosix, baseName, isInside };
