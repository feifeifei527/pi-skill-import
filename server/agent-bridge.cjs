/**
 * agent-bridge —— 把导入能力接到 Pi 的对话侧。
 *
 *   import_skill   agent tool：模型可以自己在对话里装技能
 *   /skill-import  斜杠命令：用户手动触发（支持 list）
 *
 * 两条入口共用 runImportFlow，和页面走的是同一个 service。
 */

/** 命令行参数：source + --global/--project/--path X/--overwrite */
function parseCommandArgs(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return { error: "用法：/skill-import <owner/repo | URL | 本地路径 | text:...> [--global|--project] [--path <dir>] [--overwrite]" };
	if (/^list\b/i.test(text)) return { list: true };
	if (/^check\b/i.test(text)) return { check: true };
	if (/^health\b/i.test(text)) return { health: true };
	const upd = /^update\s+(\S+)/i.exec(text);
	if (upd) {
		const scopeId = /--global\b/.test(text) ? "global" : /--project\b/.test(text) ? "project" : "";
		return { update: upd[1], scopeId };
	}

	// text: 后面可能是带空格的多行内容——整段当 source，只剥掉尾部开关
	if (text.startsWith("text:")) {
		const m = /\s--(global|project|overwrite)\s*$/.exec(text);
		const overwrite = Boolean(m && m[1] === "overwrite");
		const scopeId = m && m[1] !== "overwrite" ? m[1] : "";
		const source = m ? text.slice(0, m.index).trimEnd() : text;
		return { source, scopeId, overwrite };
	}

	const tokens = text.split(/\s+/);
	let source = "";
	let scopeId = "";
	let path = "";
	let overwrite = false;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--global") scopeId = "global";
		else if (t === "--project") scopeId = "project";
		else if (t === "--overwrite") overwrite = true;
		else if (t === "--path") path = tokens[++i] ?? "";
		else if (!source) source = t;
	}
	if (!source) return { error: "缺少来源" };
	return { source, scopeId, path, overwrite };
}

/**
 * 预览 → 校验 → 安装。返回结构化状态，格式化交给调用方。
 * @returns {Promise<{status:"installed"|"pick"|"conflict"|"invalid"|"error", ...}>}
 */
async function runImportFlow(service, { source, path, scopeId, overwrite } = {}) {
	const preview = await service.preview({ source, path, scopeId });
	if (!preview.ok) {
		return { status: "error", message: preview.error, hint: preview.hint, code: preview.code };
	}
	if (preview.needsPick && !path) {
		return {
			status: "pick",
			token: preview.token,
			candidates: (preview.candidates ?? []).map((c) => c.path || "(根目录)"),
			label: preview.source?.label ?? "",
		};
	}
	const inspection = preview.inspection;
	if (!inspection?.ok) {
		return {
			status: "invalid",
			token: preview.token,
			name: inspection?.skill?.name ?? "",
			issues: (inspection?.issues ?? []).filter((i) => i.level === "error"),
		};
	}

	const res = await service.install({ token: preview.token, path, scopeId, overwrite });
	if (!res.ok) {
		if (res.code === "conflict") {
			return {
				status: "conflict",
				token: preview.token,
				name: inspection.skill.name,
				hint: res.conflictHint,
				diffSummary: res.diffSummary ?? "",
			};
		}
		return { status: "error", message: res.error, issues: res.issues ?? [] };
	}
	return { status: "installed", name: res.name, target: res.target, backup: res.backup, files: res.files };
}

function formatResult(result) {
	switch (result.status) {
		case "installed": {
			const lines = [`已安装技能「${result.name}」（${result.files} 个文件）→ ${result.target}`];
			if (result.backup) lines.push(`旧版本已备份到 ${result.backup}，可用 /skill-import list 查看并回滚。`);
			lines.push("下一步：让用户发送 /reload，Pi 才会重新扫描技能目录（之后可用 /skill:<name>）。");
			return lines.join("\n");
		}
		case "pick": {
			const list = result.candidates.slice(0, 40).map((p) => `- ${p}`).join("\n");
			const more = result.candidates.length > 40 ? `\n…还有 ${result.candidates.length - 40} 个` : "";
			return [
				`${result.label} 里有 ${result.candidates.length} 个技能，需要指定装哪一个：`,
				list + more,
				"请带 path 参数再调用一次 import_skill（或让用户用页面里的候选列表点选）。",
			].join("\n");
		}
		case "conflict":
			return [
				`「${result.name}」已经存在：${result.hint ?? ""}${result.diffSummary ? `（${result.diffSummary}）` : ""}`,
				"如果确实要覆盖，请带 overwrite: true 再调一次；否则换个技能名/作用域。",
			].join("\n");
		case "invalid":
			return [
				`技能「${result.name || "?"}」校验未通过，没有安装：`,
				...result.issues.map((i) => `- [${i.level}] ${i.message}${i.hint ? `（${i.hint}）` : ""}`),
				"修好 SKILL.md 后重试。",
			].join("\n");
		default:
			return `导入失败：${result.message ?? "未知错误"}${result.hint ? `（${result.hint}）` : ""}${
				result.issues?.length ? `\n${result.issues.map((i) => `- ${i.message}`).join("\n")}` : ""
			}`;
	}
}

function formatList(data) {
	const lines = [];
	for (const scope of data.scopes ?? []) {
		if (!scope.skills?.length) continue;
		const names = scope.skills.map((s) => `${s.name}${s.managed ? "*" : ""}${s.backup ? " (可回滚)" : ""}`);
		lines.push(`${scope.label}: ${names.join("、")}`);
	}
	return lines.length ? `已安装技能（* = 本插件导入）：\n${lines.join("\n")}` : "还没有装任何技能。";
}

function formatUpdates(data) {
	const items = data?.items ?? [];
	if (items.length === 0) return "没有由本插件导入的技能，没有可检查的来源。";
	const lines = items.map((i) => {
		if (i.status === "up-to-date") return `- ${i.name}：已是最新`;
		if (i.status === "update-available") return `- ${i.name}：可更新（${i.summary}）`;
		if (i.status === "no-source") return `- ${i.name}：没有来源信息，无法检查`;
		return `- ${i.name}：检查失败（${i.error}）`;
	});
	return [`检查了 ${data.checked} 个技能，${data.updates} 个可更新：`, ...lines, "用 /skill-import update <name> 更新（会先备份）。"].join("\n");
}

function formatHealth(data) {
	const t = data?.totals ?? {};
	const head = `健康检查：${t.skills ?? 0} 个技能，${t.errors ?? 0} 个错误，${t.warns ?? 0} 个警告`;
	const lines = [head];
	for (const item of (data?.items ?? []).filter((i) => i.issues?.length)) {
		lines.push(`- ${item.name}（${item.scopeId}）：`);
		for (const issue of item.issues.slice(0, 6)) lines.push(`  · [${issue.level}] ${issue.message}`);
		if (item.issues.length > 6) lines.push(`  · …还有 ${item.issues.length - 6} 条`);
	}
	for (const dup of data?.duplicates ?? []) {
		lines.push(`- 重名 shadow：「${dup.name}」同时出现在 ${dup.scopes.join("、")}，Pi 只会加载先发现的那份`);
	}
	if (lines.length === 1) lines.push("没有发现问题。");
	return lines.join("\n");
}

function formatUpdateResult(res) {
	if (res.ok) {
		const lines = [`已更新技能「${res.name}」${res.diffSummary ? `：${res.diffSummary}` : ""}`];
		if (res.backup) lines.push(`旧版本备份：${res.backup}`);
		lines.push("下一步：让用户发送 /reload。");
		return lines.join("\n");
	}
	return formatResult({ status: "error", message: res.error, issues: res.issues ?? [] });
}

function registerAgentSurface({ host, service }) {
	const offTool = host.registerAgentTool({
		name: "import_skill",
		label: "导入技能",
		description:
			"Install an Agent Skill (SKILL.md + bundled scripts/references) into ~/.pi/agent/skills (global) or <project>/.pi/skills (project). " +
			"Accepts a GitHub repo/tree/raw URL, a zip URL, a local directory, or inline SKILL.md text prefixed with 'text:'. " +
			"Validates the skill and checks for name conflicts before writing; refuses to overwrite unless overwrite=true. " +
			"After a successful install the user must send /reload for Pi to pick the skill up.",
		promptSnippet: "import_skill: install an Agent Skill from GitHub/zip/URL/local dir",
		promptGuidelines: [
			"Use import_skill when the user asks to install/pull in/add a skill (技能).",
			"If it returns a candidate list (multiple skills in one repo), call it again with the chosen path.",
			"Never set overwrite=true without the user explicitly agreeing to replace the existing skill.",
		],
		parameters: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					enum: ["install", "list", "check", "update", "health"],
					description: "install (default) | list | check | update | health",
				},
				name: { type: "string", description: "Skill name, required when mode=update" },
				source: {
					type: "string",
					description:
						"owner/repo, GitHub URL (repo/tree/blob/raw), zip URL, local path, or 'text:<SKILL.md content>'",
				},
				scope: {
					type: "string",
					enum: ["global", "project"],
					description: "Where to install. global = ~/.pi/agent/skills, project = <cwd>/.pi/skills (default: project)",
				},
				path: {
					type: "string",
					description: "Sub-directory inside the repo when it contains several skills (e.g. skills/pdf-tools)",
				},
				overwrite: {
					type: "boolean",
					description: "Replace an existing skill with the same name (keeps a backup). Only with explicit user consent.",
				},
			},
			required: [],
		},
		execute: async (_toolCallId, params) => {
			const p = params && typeof params === "object" ? params : {};
			const mode = String(p.mode ?? "install");
			if (mode === "list") return formatList(await service.listInstalled());
			if (mode === "check") return formatUpdates(await service.checkUpdates());
			if (mode === "health") return formatHealth(await service.health());
			if (mode === "update") {
				const res = await service.update({ name: p.name, scopeId: p.scope === "global" ? "global" : undefined });
				if (res.ok) host.notify("info", `已更新技能「${res.name}」`, `Updated skill "${res.name}"`);
				return formatUpdateResult(res);
			}
			if (!p.source) return "缺少 source：给 owner/repo、GitHub/zip 链接、本地路径或 text:<SKILL.md>。";
			const result = await runImportFlow(service, {
				source: p.source,
				path: p.path,
				scopeId: p.scope === "global" ? "global" : "project",
				overwrite: p.overwrite === true,
			});
			if (result.status === "installed") {
				host.notify("info", `已导入技能「${result.name}」`, `Imported skill "${result.name}"`);
			}
			return formatResult(result);
		},
	});

	const offCommand = host.registerCommand({
		name: "skill-import",
		description: "导入 Agent Skills（预览、校验、安装；list 查看已装）",
		descriptionEn: "Import an Agent Skill (preview, validate, install; 'list' to inspect)",
		argumentHint: "<owner/repo|URL|路径|text:...> [--global|--project] [--path <dir>] [--overwrite] | list",
		run: async (rawArgs) => {
			const parsed = parseCommandArgs(rawArgs);
			if (parsed.error) return parsed.error;
			if (parsed.list) return formatList(await service.listInstalled());
			if (parsed.check) return formatUpdates(await service.checkUpdates());
			if (parsed.health) return formatHealth(await service.health());
			if (parsed.update) {
				const res = await service.update({ name: parsed.update, scopeId: parsed.scopeId || undefined });
				return formatUpdateResult(res);
			}
			const result = await runImportFlow(service, parsed);
			return formatResult(result);
		},
	});

	return () => {
		try {
			offTool();
		} catch {
			/* ignore */
		}
		try {
			offCommand();
		} catch {
			/* ignore */
		}
	};
}

module.exports = {
	registerAgentSurface,
	runImportFlow,
	formatResult,
	formatList,
	formatUpdates,
	formatHealth,
	formatUpdateResult,
	parseCommandArgs,
};
