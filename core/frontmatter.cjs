/**
 * frontmatter —— SKILL.md 头部解析 + Agent Skills 规范校验。
 *
 * 只实现 YAML 的一个保守子集（够 SKILL.md 用）：
 *   key: value / "quoted" / 'quoted' / [a, b] / 块标量 > | / 一层嵌套 map / 块数组
 * 不认识的行一律跳过，不抛错——坏 frontmatter 之后由 validate 报 issue。
 */

const KEY_RE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

function parseScalar(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null" || s === "~") return null;
	if (s.startsWith("[") && s.endsWith("]")) {
		const inner = s.slice(1, -1).trim();
		if (!inner) return [];
		return inner
			.split(",")
			.map((x) => parseScalar(x))
			.filter((x) => x !== "");
	}
	return s;
}

/** 极简 YAML：只认 key: value 这一层 + 一层嵌套。 */
function parseYamlLite(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	const root = {};
	const stack = [{ indent: -1, obj: root }];
	let i = 0;
	const indentOf = (l) => (l.match(/^[ \t]*/) ?? [""])[0].replace(/\t/g, "  ").length;

	while (i < lines.length) {
		const raw = lines[i];
		const line = raw.trim();
		if (!line || line.startsWith("#")) {
			i++;
			continue;
		}
		const indent = indentOf(raw);
		const kv = KEY_RE.exec(line);
		if (!kv) {
			i++;
			continue;
		}
		const key = kv[1];
		const val = kv[2];

		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
		const parent = stack[stack.length - 1].obj;

		// 块标量：key: > 或 key: |
		if (/^[>|][+-]?$/.test(val.trim())) {
			const fold = val.trim().startsWith(">");
			const buf = [];
			let blockIndent = null;
			i++;
			while (i < lines.length) {
				const l = lines[i];
				if (!l.trim()) {
					buf.push("");
					i++;
					continue;
				}
				const ind = indentOf(l);
				if (ind <= indent) break;
				if (blockIndent === null) blockIndent = ind;
				buf.push(l.slice(Math.min(blockIndent, ind)));
				i++;
			}
			parent[key] = (fold ? buf.join(" ") : buf.join("\n")).trim();
			continue;
		}

		// 空值：可能是嵌套 map，也可能是块数组
		if (!val.trim()) {
			let j = i + 1;
			while (j < lines.length && !lines[j].trim()) j++;
			const nextLine = lines[j];
			const nextIsItem = nextLine && nextLine.trim().startsWith("- ") && indentOf(nextLine) > indent;
			if (nextIsItem) {
				const items = [];
				i = j;
				const itemIndent = indentOf(lines[i]);
				while (i < lines.length) {
					const cur = lines[i];
					if (!cur.trim()) {
						i++;
						continue;
					}
					if (indentOf(cur) < itemIndent || !cur.trim().startsWith("- ")) break;
					items.push(parseScalar(cur.trim().slice(2)));
					i++;
				}
				parent[key] = items;
				continue;
			}
			const nested = {};
			parent[key] = nested;
			stack.push({ indent, obj: nested });
			i++;
			continue;
		}

		parent[key] = parseScalar(val);
		i++;
	}
	return root;
}

/**
 * 拆出 frontmatter 与正文。
 * @returns {{present:boolean, data:object, body:string, raw:string, error:string|null}}
 */
function splitFrontmatter(markdown) {
	const src = String(markdown ?? "").replace(/^\uFEFF/, "");
	if (!/^---[ \t]*\r?\n/.test(src)) {
		return { present: false, data: {}, body: src, raw: "", error: null };
	}
	const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
	if (!close) {
		return { present: true, data: {}, body: src, raw: "", error: "frontmatter 未闭合：缺少结尾的 ---" };
	}
	const raw = src.slice(src.indexOf("\n") + 1, close.index);
	const body = src.slice(close.index + close[0].length);
	return { present: true, data: parseYamlLite(raw), body, raw, error: null };
}

/** Agent Skills 规范：小写字母/数字，单连字符分隔，≤64。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/** 单条：{level:'error'|'warn'|'info', code, message, hint?} */
function issue(level, code, message, hint) {
	return hint ? { level, code, message, hint } : { level, code, message };
}

/**
 * 校验 frontmatter 里的规范字段。
 * @param {object} data
 * @param {{dirName?:string, lang?:"zh"|"en"}} [opts]
 */
function validateFrontmatter(data, opts = {}) {
	const issues = [];
	const name = typeof data?.name === "string" ? data.name.trim() : "";
	const description = typeof data?.description === "string" ? data.description.trim() : "";

	if (!name) {
		issues.push(issue("error", "name-missing", "缺少 name 字段", "frontmatter 里写 name: my-skill"));
	} else {
		if (!SKILL_NAME_RE.test(name)) {
			issues.push(
				issue(
					"error",
					"name-invalid",
					`name「${name}」不符合规范`,
					"只允许小写字母、数字与单个连字符，例如 pdf-tools",
				),
			);
		}
		if (name.length > MAX_NAME) {
			issues.push(issue("error", "name-too-long", `name 超长（${name.length} > ${MAX_NAME}）`));
		}
		if (opts.dirName && opts.dirName !== name) {
			issues.push(
				issue(
					"warn",
					"name-dir-mismatch",
					`name「${name}」与目录名「${opts.dirName}」不一致`,
					"其他 Agent Skills 实现可能强制二者相同，建议改成一致",
				),
			);
		}
	}

	if (!description) {
		issues.push(
			issue("error", "description-missing", "缺少 description 字段", "description 决定模型何时加载这个技能"),
		);
	} else {
		if (description.length > MAX_DESCRIPTION) {
			issues.push(
				issue("error", "description-too-long", `description 超长（${description.length} > ${MAX_DESCRIPTION}）`),
			);
		}
		if (description.length < 20) {
			issues.push(
				issue("warn", "description-too-short", "description 太短，模型很难判断何时该用它", "写清「做什么 + 什么时候用」"),
			);
		} else if (!/(使用|用于|适用|当|需要|use when|when to|for |whenever)/i.test(description)) {
			issues.push(
				issue("info", "description-no-trigger", "description 没写触发场景", "补一句「当……时使用」能提高命中率"),
			);
		}
	}

	if (data?.["disable-model-invocation"] !== undefined && typeof data["disable-model-invocation"] !== "boolean") {
		issues.push(issue("warn", "disable-flag-type", "disable-model-invocation 应该是 true/false"));
	}
	if (data?.license !== undefined && typeof data.license !== "string") {
		issues.push(issue("warn", "license-type", "license 应该是字符串"));
	}

	return issues;
}

module.exports = { parseYamlLite, splitFrontmatter, SKILL_NAME_RE, MAX_NAME, MAX_DESCRIPTION, validateFrontmatter };
