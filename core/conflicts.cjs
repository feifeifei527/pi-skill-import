/**
 * conflicts —— 装之前先看「同名技能已经在哪出现过」。
 *
 * Pi 的发现顺序是「先到先得」：全局先于项目，目录型与单文件型都参与。
 * 同名已存在时不拦你，但必须告诉你哪一份会生效、哪一份会被 shadow。
 */
const { joinPosix } = require("./util.cjs");

/**
 * @param {{name:string, scopes:Array<{id:string,label:string,path:string,writable?:boolean,skills?:string[],skillFiles?:string[]}>}} args
 * @returns {{name:string, found:Array<object>, winner:object|null, shadowed:Array<object>}}
 */
function checkConflicts({ name, scopes }) {
	const clean = String(name ?? "").trim();
	const found = [];
	for (const [index, scope] of (scopes ?? []).entries()) {
		const skills = Array.isArray(scope.skills) ? scope.skills : [];
		const files = Array.isArray(scope.skillFiles) ? scope.skillFiles : [];
		const hasDir = skills.includes(clean);
		const hasFile = files.includes(`${clean}.md`) || files.includes(clean);
		if (!hasDir && !hasFile) continue;
		found.push({
			scopeId: scope.id,
			label: scope.label,
			path: joinPosix(String(scope.path ?? ""), hasDir ? clean : `${clean}.md`),
			kind: hasDir ? "dir" : "file",
			writable: Boolean(scope.writable),
			order: index,
		});
	}
	found.sort((a, b) => a.order - b.order);
	return {
		name: clean,
		found,
		winner: found[0] ?? null,
		shadowed: found.slice(1),
	};
}

/** 装进哪个作用域时的建议文案。 */
function describeConflict(conflict, targetScopeId) {
	if (!conflict || conflict.found.length === 0) return null;
	const same = conflict.found.find((f) => f.scopeId === targetScopeId);
	const others = conflict.found.filter((f) => f.scopeId !== targetScopeId);
	if (same && others.length > 0) {
		return `目标位置已有一份同名的（会被覆盖）；${others.map((o) => o.label).join("、")} 还有一份，装完可能被 shadow`;
	}
	if (same) return "目标位置已有一份同名技能，继续会覆盖（旧版自动备份）";
	if (others.length > 0) {
		return `${others.map((o) => o.label).join("、")} 已有一份同名技能；现在这份会先被 Pi 发现（或反过来被 shadow）`;
	}
	return null;
}

module.exports = { checkConflicts, describeConflict };
