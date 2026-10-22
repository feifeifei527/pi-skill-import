/**
 * skill-import —— 客户端视图。
 *
 * 页面结构按「用户要做的事」分三个入口：
 *   推荐（默认）/ 已安装 / 导入
 * 落点、来源仓库、索引重建、健康检查这些实现概念收进「高级」。
 *
 * 交互要点：
 * - 「这次要做」是可编辑的输入框，改完点「按这个需求推荐」
 * - 「重新推荐」复用索引；「更新技能库」才会重新拉仓库（在高级里）
 * - 卡片上直接选安装落点（项目 / 全局），并显示目标项目名
 * - 装完/启停后显示「等待重新加载」+ 复制 /reload / 已重新加载
 * - 大仓库的候选技能有搜索与分页；粘贴 SKILL.md 用多行输入
 */
import { createProjectResolver } from "./project-dir.mjs";
import { defineView } from "./sdk/index.mjs";

const CSS = `
.si-wrap { display:flex; flex-direction:column; gap:14px; padding:16px 18px 28px; color:var(--text); font-size:13px; }
.si-head { display:flex; align-items:flex-start; gap:12px; }
.si-title { font-size:15px; font-weight:600; letter-spacing:.2px; }
.si-sub { color:var(--text-dim); font-size:12px; margin-top:3px; line-height:1.5; }
.si-grow { flex:1; }
.si-tabs { display:flex; gap:6px; flex-wrap:wrap; }
.si-tab { background:transparent; border:1px solid var(--border); color:var(--text-dim); border-radius:999px; padding:4px 12px; font-size:12px; cursor:pointer; }
.si-tab:hover { color:var(--text); }
.si-tab.on { background:var(--bg-elev2); border-color:var(--accent); color:var(--text); }
.si-sec { background:var(--bg-elev); border:1px solid var(--border); border-radius:10px; padding:12px 14px; display:flex; flex-direction:column; gap:10px; }
.si-sec-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.si-sec-title { font-size:12px; color:var(--text-faint); text-transform:uppercase; letter-spacing:.5px; }
.si-scopes { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px; }
.si-scope { background:var(--bg-elev2); border:1px solid var(--border-soft); border-radius:8px; padding:8px 10px; min-width:0; }
.si-scope.denied { border-color:var(--amber,var(--border)); }
.si-scope b { font-weight:600; font-size:12px; }
.si-path { font-family:var(--mono); font-size:11px; color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; }
.si-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.si-col { display:flex; flex-direction:column; gap:6px; }
.si-input { flex:1 1 320px; min-width:0; background:var(--inputbox-bg,var(--bg)); border:1px solid var(--border); border-radius:8px;
  color:var(--text); font-family:var(--mono); font-size:12px; padding:7px 10px; outline:none; }
.si-input:focus { border-color:var(--accent); }
.si-textarea { font-family:var(--mono); font-size:12px; line-height:1.5; resize:vertical; min-height:52px; }
.si-demand { min-height:44px; font-family:var(--font,inherit); font-size:13px; }
.si-badge { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--border); background:var(--chip-bg); color:var(--text-dim); }
.si-badge.ok { color:var(--green,var(--text)); border-color:var(--green,var(--border)); }
.si-badge.warn { color:var(--amber-text,var(--text)); border-color:var(--amber,var(--border)); }
.si-badge.err { color:var(--err-text,var(--text)); border-color:var(--err-text,var(--border)); }
.si-chip { font-family:var(--mono); font-size:11px; padding:1px 6px; border-radius:6px; background:var(--bg-elev2); color:var(--text-dim); cursor:pointer; }
.si-chip:hover { color:var(--accent); }
.si-chip.static { cursor:default; }
.si-chip.static:hover { color:var(--text-dim); }
.si-issues { display:flex; flex-direction:column; gap:4px; max-height:220px; overflow:auto; }
.si-issue { display:flex; gap:8px; font-size:12px; line-height:1.5; }
.si-issue .lv { flex:0 0 46px; font-size:10.5px; text-transform:uppercase; letter-spacing:.4px; opacity:.8; }
.si-issue.error .lv { color:var(--err-text); }
.si-issue.warn .lv { color:var(--amber-text); }
.si-issue.info .lv { color:var(--text-faint); }
.si-issue .hint { color:var(--text-faint); }
.si-desc { color:var(--text-dim); font-size:12px; line-height:1.55; }
.si-fm { font-family:var(--mono); font-size:11px; color:var(--text-faint); }
.si-diff { display:flex; flex-direction:column; gap:3px; border-left:2px solid var(--border); padding-left:8px; }
.si-diff-row { font-family:var(--mono); font-size:11px; color:var(--text-dim); word-break:break-word; }
.si-diff-row.add { color:var(--green,var(--text-dim)); }
.si-diff-row.chg { color:var(--amber-text,var(--text-dim)); }
.si-diff-row.del { color:var(--err-text,var(--text-dim)); }
.si-radio { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-dim); cursor:pointer; }
.si-result { font-size:12px; line-height:1.6; }
.si-result.ok { color:var(--green,var(--text)); }
.si-result.err { color:var(--err-text,var(--text)); }
.si-mono { font-family:var(--mono); font-size:11px; color:var(--text-dim); word-break:break-all; }
.si-empty { color:var(--text-faint); font-size:12px; }
.si-list { display:flex; flex-direction:column; gap:6px; }
.si-item { display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:var(--bg-elev2); border:1px solid var(--border-soft); border-radius:8px; padding:6px 10px; }
.si-item .nm { font-family:var(--mono); font-size:12px; }
.si-item.col { flex-direction:column; align-items:stretch; }
.si-foot { color:var(--text-faint); font-size:11.5px; line-height:1.6; }
.si-rec { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
.si-rec .si-desc { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.si-why { display:flex; gap:4px; flex-wrap:wrap; }
.si-select { background:var(--inputbox-bg,var(--bg)); border:1px solid var(--border); color:var(--text); border-radius:7px; font-size:12px; padding:3px 6px; max-width:230px; }
.si-reload { display:flex; align-items:center; gap:8px; flex-wrap:wrap; background:var(--bg-elev2); border:1px solid var(--amber,var(--border)); border-radius:8px; padding:7px 10px; font-size:12px; }
.si-split { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.si-adv { display:none; }
.si-adv.on { display:flex; }
.si-page { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--text-dim); }
.si-btn-mini { font-size:11px; padding:2px 8px; }
`;

function h(tag, cls, text) {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (text !== undefined) el.textContent = text;
	return el;
}

function btn(label, cls = "btn") {
	return h("button", cls, label);
}

function badge(text, kind = "") {
	return h("span", `si-badge${kind ? ` ${kind}` : ""}`, text);
}

function chip(text, title) {
	const el = h("span", "si-chip static", text);
	if (title) el.title = title;
	return el;
}

function diffBlock(diff, limit = 8) {
	const box = h("div", "si-diff");
	if (!diff) return box;
	const row = (label, list, cls) => {
		if (!list?.length) return;
		const el = h("div", `si-diff-row ${cls}`);
		el.textContent = `${label} ${list.length}：${list.slice(0, limit).join("、")}${list.length > limit ? " …" : ""}`;
		box.appendChild(el);
	};
	row("新增", diff.added, "add");
	row("修改", diff.changed, "chg");
	row("删除", diff.removed, "del");
	if (!diff.added.length && !diff.changed.length && !diff.removed.length) {
		box.appendChild(h("div", "si-diff-row", "内容完全一致"));
	} else if (diff.counts?.unchanged) {
		box.appendChild(h("div", "si-diff-row", `未变 ${diff.counts.unchanged} 个文件`));
	}
	return box;
}

function flash(el, text) {
	const old = el.textContent;
	el.textContent = text;
	setTimeout(() => {
		if (el.isConnected) el.textContent = old;
	}, 1600);
}

function copyText(text, el) {
	const done = () => flash(el, "已复制");
	try {
		if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(text).then(done, () => fallback());
			return;
		}
	} catch {
		/* 走 fallback */
	}
	fallback();

	function fallback() {
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			document.execCommand?.("copy");
			ta.remove();
			done();
		} catch {
			/* 复制不了就保持原样 */
		}
	}
}


/** 项目目录解析链（策略与降级都在 client/project-dir.mjs 里，可单测）。 */
const projectResolver = createProjectResolver();

const PICK_PAGE = 24;

export default defineView({
	mount(container, ctx) {
		const style = document.createElement("style");
		style.textContent = CSS;
		container.appendChild(style);

		const root = h("div", "si-wrap");

		// ---------- 顶部 ----------
		const head = h("div", "si-head");
		const titleBox = h("div");
		titleBox.appendChild(h("div", "si-title", "技能导入"));
		const subLine = h("div", "si-sub", "按当前任务推荐技能：先看能不能补上已有能力，再一键装到项目或全局。");
		titleBox.appendChild(subLine);
		const headRight = h("div", "si-row");
		const refresh = btn("刷新");
		const advToggle = btn("高级");
		headRight.append(refresh, advToggle);
		head.append(titleBox, h("div", "si-grow"), headRight);

		// 重载待办
		const reloadBox = h("div", "si-reload");
		reloadBox.style.display = "none";

		// ---------- 三个入口 ----------
		const tabs = h("div", "si-tabs");
		const TAB_DEFS = [
			{ id: "rec", label: "推荐" },
			{ id: "installed", label: "已安装" },
			{ id: "import", label: "导入" },
		];
		const tabButtons = new Map();
		for (const def of TAB_DEFS) {
			const b = h("button", "si-tab", def.label);
			b.addEventListener("click", () => setTab(def.id));
			tabButtons.set(def.id, b);
			tabs.appendChild(b);
		}

		// 最近一次操作
		const resultSec = h("div", "si-sec");
		resultSec.style.display = "none";
		const resultBody = h("div", "si-result");
		resultSec.append(h("div", "si-sec-title", "最近一次操作"), resultBody);

		// ---------- 推荐 ----------
		const recSec = h("div", "si-sec");

		const recHead = h("div", "si-sec-head");
		recHead.appendChild(h("div", "si-sec-title", "推荐"));
		const recStatus = badge("…");
		const recBtn = btn("重新推荐", "btn primary");
		recHead.append(recStatus, h("div", "si-grow"), recBtn);

		const demandRow = h("div", "si-col");
		const demandInput = h("textarea", "si-input si-textarea si-demand");
		demandInput.rows = 2;
		demandInput.placeholder = "这次要做的事（默认来自当前对话，可以直接改）";
		const demandBtns = h("div", "si-split");
		const demandGo = btn("按这个需求推荐", "btn primary");
		const demandReset = btn("用当前对话");
		demandBtns.append(demandGo, demandReset);

		const recBox = h("div", "si-list");
		recSec.append(recHead, demandInput, demandBtns, recBox);

		// ---------- 已安装 ----------
		const installedSec = h("div", "si-sec");
		const installedHead = h("div", "si-sec-head");
		installedHead.appendChild(h("div", "si-sec-title", "已安装"));
		const installedCount = badge("…");
		const checkBtn = btn("检查更新");
		installedHead.append(installedCount, h("div", "si-grow"), checkBtn);
		const updatesBox = h("div", "si-list");
		const installedBox = h("div", "si-list");
		installedSec.append(installedHead, updatesBox, installedBox);

		// ---------- 导入 ----------
		const importSec = h("div", "si-sec");
		importSec.appendChild(h("div", "si-sec-title", "导入"));
		const inputRow = h("div", "si-col");
		const input = h("textarea", "si-input si-textarea");
		input.rows = 2;
		input.placeholder = "owner/repo、GitHub 链接、zip 直链、/本地/目录；也可以直接粘贴 SKILL.md 全文";
		const importBtns = h("div", "si-split");
		const previewBtn = btn("预览", "btn primary");
		importBtns.appendChild(previewBtn);
		inputRow.append(input, importBtns);
		importSec.append(
			inputRow,
			h(
				"div",
				"si-foot",
				"GitHub 仓库会下载 zipball 后只取目标技能目录；不会跑任何脚本。停用 = 搬进技能目录的 .disabled/（Pi 不再扫描），随时可启用。",
			),
		);

		// 预览
		const previewSec = h("div", "si-sec");
		previewSec.style.display = "none";
		const previewBody = h("div", "si-sec");
		previewBody.style.cssText = "border:none;background:transparent;padding:0;gap:10px";
		previewSec.appendChild(previewBody);

		// ---------- 高级 ----------
		const advSec = h("div", "si-sec si-adv");
		const scopesHead = h("div", "si-sec-head");
		scopesHead.appendChild(h("div", "si-sec-title", "技能落点"));
		// 宿主不一定把本标签页的项目目录给插件（快照里没 cwd，会话清单也未必包含当前条），
		// 那就让用户直接指定，比猜一个目录安全。
		const projRow = h("div", "si-split");
		const projInput = h("input", "si-input");
		projInput.placeholder = "项目目录（绝对路径，如 /Users/you/code/app）";
		const projUse = btn("使用此目录");
		const projHint = h("div", "si-foot", "");
		projRow.append(projInput, projUse);
		const scopesBox = h("div", "si-scopes");
		const indexHead = h("div", "si-sec-head");
		indexHead.appendChild(h("div", "si-sec-title", "技能库索引"));
		const indexStatus = badge("…");
		const rebuildBtn = btn("更新技能库");
		indexHead.append(indexStatus, h("div", "si-grow"), rebuildBtn);
		const indexFoot = h("div", "si-foot", "重新推荐会复用索引；只有这里才会重新拉取来源仓库（24 小时缓存）。");
		const srcHead = h("div", "si-sec-head");
		srcHead.appendChild(h("div", "si-sec-title", "来源仓库"));
		const sourcesBtn = btn("管理来源");
		const discoverBtn = btn("发现更多");
		srcHead.append(h("div", "si-grow"), sourcesBtn, discoverBtn);
		const srcBox = h("div", "si-list");
		srcBox.style.display = "none";
		const healthHead = h("div", "si-sec-head");
		healthHead.appendChild(h("div", "si-sec-title", "健康检查"));
		const healthBtn = btn("检查全部技能");
		healthHead.append(h("div", "si-grow"), healthBtn);
		const healthBox = h("div", "si-list");
		healthBox.style.display = "none";
		advSec.append(scopesHead, projRow, projHint, scopesBox, indexHead, indexStatus, indexFoot, srcHead, srcBox, healthHead, healthBox);

		root.append(head, reloadBox, tabs, recSec, installedSec, importSec, previewSec, resultSec, advSec);
		container.appendChild(root);

		let disposed = false;
		// 每个发往插件的请求都带上已确认的项目目录（服务端会再验一遍绝对路径）。
		const send = (payload) => {
			if (disposed) return;
			if (!state.projectDirManual) {
				const found = projectResolver.resolve();
				if (found.path) {
					state.projectDir = found.path;
					state.projectSource = found.source;
					state.projectConfidence = found.confidence;
				} else if (state.cwd) {
					state.projectDir = state.cwd;
					state.projectSource = "服务端";
					state.projectConfidence = "low";
				}
			}
			const projectDir = state.projectDir;
			ctx.send(projectDir && payload && typeof payload === "object" && String(payload.action ?? "").startsWith("skill-import:")
				? { ...payload, projectDir }
				: payload);
		};

		const state = {
			tab: "rec",
			scopes: [],
			cwd: "",
			projectName: "",
			scopeId: "project",
			demand: "",
			demandEdited: false,
			pendingReload: [],
			recommend: null,
			list: null,
			updates: new Map(),
			preview: null,
			pickQuery: "",
			pickPage: 0,
			projectDir: "",
			projectDirManual: false,
			autoProbedFor: "",
			projectSource: "",
		};
		/** 进行中的推荐安装：技能名 → 收尾回调（失败/超时/上下文切换时把按钮恢复）。 */
		const installPending = new Map();

		// ---------- 小工具 ----------
		function scopeLabel(scope) {
			if (scope.id === "global") return "全局 · Pi";
			if (scope.id === "project") return `项目 · ${state.projectName || "当前项目"}`;
			return scope.label;
		}

		function scopeShort(id) {
			return id === "global" ? "全局" : "项目";
		}

		function writableScopes() {
			return state.scopes.filter((s) => s.writable);
		}

		function setTab(id) {
			state.tab = id;
			for (const [key, b] of tabButtons) b.classList.toggle("on", key === id);
			recSec.style.display = id === "rec" ? "" : "none";
			installedSec.style.display = id === "installed" ? "" : "none";
			importSec.style.display = id === "import" ? "" : "none";
			previewSec.style.display = id === "import" && state.preview ? "" : "none";
			if (id === "installed" && !state.list) send({ action: "skill-import:list" });
		}

		function setResult(kind, lines) {
			resultSec.style.display = "";
			resultBody.className = `si-result ${kind}`;
			resultBody.replaceChildren(...lines);
		}

		function applyReload(data) {
			if (!data || !Array.isArray(data.items)) return;
			state.pendingReload = data.items;
			renderReload();
		}

		function renderReload() {
			reloadBox.replaceChildren();
			const items = state.pendingReload ?? [];
			if (!items.length) {
				reloadBox.style.display = "none";
				return;
			}
			reloadBox.style.display = "";
			const names = items.slice(0, 6).map((x) => x.name).join("、");
			reloadBox.appendChild(badge("等待重新加载", "warn"));
			reloadBox.appendChild(h("span", "", `${names}${items.length > 6 ? ` 等 ${items.length} 个` : ""}`));
			const copy = btn("复制 /reload", "btn si-btn-mini");
			copy.addEventListener("click", () => copyText("/reload", copy));
			const done = btn("已重新加载", "btn si-btn-mini");
			done.addEventListener("click", () => {
				done.disabled = true;
				send({ action: "skill-import:ack-reload" });
			});
			reloadBox.append(copy, done, h("div", "si-foot", "现在到对话里发送 /reload 让 Pi 重新扫描技能目录。"));
		}

		function demandValue() {
			return demandInput.value.trim();
		}

		function requestRecommend({ force = false } = {}) {
			const payload = { action: "skill-import:recommend" };
			const q = state.demandEdited ? demandValue() : "";
			if (q) payload.q = q;
			// 首次没有索引时才强制建；已有索引时「重新推荐」复用缓存
			if (force || state.recommend?.needsIndex) payload.force = true;
			send(payload);
		}

		function installScopeSelect(defaultId = state.scopeId) {
			const select = document.createElement("select");
			select.className = "si-select";
			for (const scope of writableScopes()) {
				const opt = document.createElement("option");
				opt.value = scope.id;
				opt.textContent = scopeLabel(scope);
				opt.title = scope.path;
				if (scope.id === defaultId) opt.selected = true;
				select.appendChild(opt);
			}
			select.title = "安装到哪个技能目录";
			select.addEventListener("change", () => {
				state.scopeId = select.value;
			});
			return select;
		}

		// ---------- 落点 ----------
		function renderScopes(scopes) {
			scopesBox.replaceChildren();
			for (const scope of scopes) {
				const card = h("div", scope.authorized ? "si-scope" : "si-scope denied");
				const top = h("div", "si-row");
				top.appendChild(h("b", "", scope.label));
				if (!scope.authorized) top.appendChild(badge("未授权", "warn"));
				else top.appendChild(badge(`${scope.count} 个`, scope.count > 0 ? "ok" : ""));
				if (!scope.writable) top.appendChild(badge("只读兼容位"));
				card.appendChild(top);
				const label = h("div", "si-foot", scopeLabel(scope));
				card.appendChild(label);
				const p = h("div", "si-path", scope.path);
				p.title = scope.path;
				card.appendChild(p);
				if (!scope.authorized) {
					const grant = btn("授权访问", "btn primary");
					grant.addEventListener("click", () => {
						grant.disabled = true;
						grant.textContent = "等待确认…";
						send({ action: "skill-import:grant", path: scope.path });
					});
					card.appendChild(grant);
				}
				scopesBox.appendChild(card);
			}
		}

		// ---------- 预览 ----------
		function issueLine(issue) {
			const row = h("div", `si-issue ${issue.level}`);
			row.appendChild(h("span", "lv", issue.level === "error" ? "错误" : issue.level === "warn" ? "警告" : "提示"));
			row.appendChild(h("span", "", issue.message));
			if (issue.hint) row.appendChild(h("span", "hint", `（${issue.hint}）`));
			return row;
		}

		function filteredCandidates(p) {
			const all = p.candidates ?? [];
			const q = state.pickQuery.trim().toLowerCase();
			if (!q) return all;
			return all.filter((c) => `${c.label ?? ""} ${c.path ?? ""}`.toLowerCase().includes(q));
		}

		function renderPreview(p) {
			previewSec.style.display = state.tab === "import" ? "" : "none";
			state.preview = p;
			previewBody.replaceChildren();
			if (p.scopeId) state.scopeId = p.scopeId;

			const srcRow = h("div", "si-row");
			srcRow.appendChild(badge(p.source?.label ?? "来源"));
			if (p.source?.skipped?.length) srcRow.appendChild(badge(`跳过 ${p.source.skipped.length} 个文件`, "warn"));
			if (p.needsPick) srcRow.appendChild(badge(`仓库里有 ${p.candidates.length} 个技能，选一个`, "warn"));
			previewBody.appendChild(srcRow);

			if (p.needsPick) {
				const search = h("input", "si-input");
				search.placeholder = `搜索 ${p.candidates.length} 个候选技能（名字或路径）`;
				search.value = state.pickQuery;
				const chipsBox = h("div", "si-row");
				const pageInfo = h("div", "si-page");
				const prev = btn("上一页", "btn si-btn-mini");
				const next = btn("下一页", "btn si-btn-mini");

				const renderChips = () => {
					const list = filteredCandidates(p);
					const pages = Math.max(1, Math.ceil(list.length / PICK_PAGE));
					if (state.pickPage >= pages) state.pickPage = pages - 1;
					const start = state.pickPage * PICK_PAGE;
					chipsBox.replaceChildren();
					for (const c of list.slice(start, start + PICK_PAGE)) {
						const el = h("span", "si-chip", c.label);
						el.title = c.path || "(根目录)";
						el.addEventListener("click", () => {
							send({ action: "skill-import:preview", token: p.token, path: c.path, scopeId: state.scopeId });
						});
						chipsBox.appendChild(el);
					}
					if (!list.length) chipsBox.appendChild(h("div", "si-empty", "没有匹配的候选"));
					pageInfo.replaceChildren();
					pageInfo.append(
						h("span", "", `${list.length ? start + 1 : 0}–${Math.min(start + PICK_PAGE, list.length)} / ${list.length}`),
						prev,
						next,
					);
					prev.disabled = state.pickPage <= 0;
					next.disabled = state.pickPage >= pages - 1;
				};

				search.addEventListener("input", () => {
					state.pickQuery = search.value;
					state.pickPage = 0;
					renderChips();
				});
				prev.addEventListener("click", () => {
					state.pickPage = Math.max(0, state.pickPage - 1);
					renderChips();
				});
				next.addEventListener("click", () => {
					state.pickPage += 1;
					renderChips();
				});
				previewBody.append(search, chipsBox, pageInfo);
				renderChips();
			}

			const inspection = p.inspection;
			if (!inspection) return;
			const skill = inspection.skill;
			const nameRow = h("div", "si-row");
			nameRow.appendChild(h("b", "", skill.name || "(未命名)"));
			nameRow.appendChild(badge(inspection.summary, inspection.ok ? "ok" : "err"));
			if (skill.frontmatter?.license) nameRow.appendChild(badge(`license: ${skill.frontmatter.license}`));
			if (skill.frontmatter?.["disable-model-invocation"] === true) nameRow.appendChild(badge("仅手动触发"));
			previewBody.appendChild(nameRow);

			if (skill.description) previewBody.appendChild(h("div", "si-desc", skill.description));

			const meta = h("div", "si-fm");
			meta.textContent = [
				`${skill.totals.files} 个文件`,
				`${(skill.totals.bytes / 1024).toFixed(1)}KB`,
				skill.references.length ? `${skill.references.length} 处引用` : null,
				skill.files.some((f) => f.exec) ? "含脚本" : null,
			]
				.filter(Boolean)
				.join(" · ");
			previewBody.appendChild(meta);

			const issuesBox = h("div", "si-issues");
			for (const issue of inspection.issues.slice(0, 20)) issuesBox.appendChild(issueLine(issue));
			if (inspection.issues.length === 0) issuesBox.appendChild(h("div", "si-empty", "没有发现问题"));
			if (inspection.issues.length > 20) issuesBox.appendChild(h("div", "si-empty", `还有 ${inspection.issues.length - 20} 条…`));
			previewBody.appendChild(issuesBox);

			const scopeRow = h("div", "si-row");
			scopeRow.appendChild(h("span", "si-foot", "安装到："));
			for (const scope of writableScopes()) {
				const label = h("label", "si-radio");
				const radio = document.createElement("input");
				radio.type = "radio";
				radio.name = "si-scope";
				radio.value = scope.id;
				radio.checked = scope.id === state.scopeId;
				radio.addEventListener("change", () => {
					state.scopeId = scope.id;
					send({ action: "skill-import:preview", token: p.token, path: p.path ?? "", scopeId: state.scopeId });
				});
				label.append(radio, document.createTextNode(`${scope.label}（${scope.count}）`));
				label.title = scope.path;
				scopeRow.appendChild(label);
			}
			previewBody.appendChild(scopeRow);

			if (p.conflictHint) previewBody.appendChild(h("div", "si-foot", p.conflictHint));
			if (p.diff) previewBody.appendChild(diffBlock(p.diff));

			const actionRow = h("div", "si-row");
			const installBtn = btn("安装到这里", "btn primary");
			installBtn.disabled = !inspection.ok;
			installBtn.addEventListener("click", () => {
				installBtn.disabled = true;
				installBtn.textContent = "安装中…";
				send({
					action: "skill-import:install",
					token: p.token,
					path: p.path ?? "",
					scopeId: state.scopeId,
					overwrite: false,
				});
			});
			const cancel = btn("清空");
			cancel.addEventListener("click", () => {
				previewSec.style.display = "none";
				state.preview = null;
			});
			actionRow.append(installBtn, cancel);
			if (!inspection.ok) actionRow.appendChild(h("span", "si-foot", "有错误项，装不了"));
			previewBody.appendChild(actionRow);
		}

		// ---------- 安装结果 ----------
		function renderInstall(data) {
			if (data.ok) {
				const lines = [h("div", "", `已安装「${data.name}」→ ${data.files} 个文件`)];
				if (data.diffSummary) lines.push(h("div", "si-foot", `本次变化：${data.diffSummary}`));
				lines.push(h("div", "si-mono", data.target));
				lines.push(h("div", "", "已安装，等待重新加载。"));
				setResult("ok", lines);
				previewSec.style.display = "none";
				state.preview = null;
				send({ action: "skill-import:list" });
				send({ action: "skill-import:probe" });
				return;
			}
			const lines = [h("div", "", data.error ?? "安装失败")];
			if (data.conflictHint) {
				lines.push(h("div", "si-foot", data.conflictHint));
				if (data.diff) lines.push(diffBlock(data.diff));
				const force = btn("仍然覆盖安装", "btn primary");
				force.addEventListener("click", () => {
					force.disabled = true;
					force.textContent = "安装中…";
					send({
						action: "skill-import:install",
						token: state.preview?.token,
						path: state.preview?.path ?? "",
						scopeId: state.scopeId,
						overwrite: true,
					});
				});
				lines.push(force);
			}
			for (const issue of data.issues ?? []) lines.push(h("div", "si-mono", `· ${issue.message}`));
			setResult("err", lines);
		}

		// ---------- 已安装 ----------
		function isPendingReload(name) {
			return (state.pendingReload ?? []).some((x) => x.name === name);
		}

		function renderList(data) {
			state.list = data;
			installedBox.replaceChildren();
			let total = 0;
			let enabledCount = 0;
			// 项目落点常被「没技能/没授权」隐藏，导致看不出项目到底有没有读对：
			// 这里固定先给一张项目卡片，说明路径、来源、数量和授权状态。
			const projectScope = (data.scopes ?? []).find((s) => s.id === "project");
			const projectCard = h("div", "si-scope");
			const title = h("div", "si-row");
			title.appendChild(badge(projectScope ? `项目 · ${state.projectName || "当前项目"}` : "项目 · 未识别", projectScope?.authorized ? "ok" : "warn"));
			projectCard.appendChild(title);
			projectCard.appendChild(h("div", "si-path", projectScope?.path || "（宿主/页面桥都没给出项目目录）"));
			if (projectScope) {
				projectCard.appendChild(h("div", "si-foot", `已读 ${projectScope.skills?.length ?? 0} 个技能${projectScope.error ? ` · ${String(projectScope.error).slice(0, 80)}` : ""}`));
				if (!projectScope.authorized) {
					const grant = btn("授权访问", "btn primary");
					grant.addEventListener("click", () => {
						grant.disabled = true;
						state.awaitingGrant = true;
						send({ action: "skill-import:grant", path: projectScope.path });
					});
					projectCard.appendChild(grant);
				} else {
					const rescan = btn("重新扫描", "btn si-btn-mini");
					rescan.addEventListener("click", () => {
						send({ action: "skill-import:probe" });
						send({ action: "skill-import:list" });
					});
					projectCard.appendChild(rescan);
				}
			}
			installedBox.appendChild(projectCard);
			for (const scope of data.scopes ?? []) {
				const writable = scope.writable !== false;
				const items = scope.skills ?? [];
				if (!items.length) continue;
				const enabled = items.filter((x) => x.enabled !== false);
				const parked = items.filter((x) => x.enabled === false);
				enabledCount += enabled.length;
				const head = h("div", "si-row");
				head.appendChild(badge(`${scope.label} · ${enabled.length}${parked.length ? ` / 停用 ${parked.length}` : ""}`));
				installedBox.appendChild(head);

				for (const skill of items) {
					total++;
					const item = h("div", "si-item");
					item.appendChild(h("span", "nm", skill.name));
					if (skill.enabled === false) item.appendChild(badge("已停用", "warn"));
					else if (isPendingReload(skill.name)) item.appendChild(badge("等待重新加载", "warn"));
					if (skill.managed) item.appendChild(badge("导入的", "ok"));
					if (skill.source) item.appendChild(chip(String(skill.source).slice(0, 32), skill.source));

					const upd = state.updates.get(`${scope.id}:${skill.name}`);
					if (skill.enabled !== false && upd?.status === "update-available") {
						item.appendChild(badge(`可更新：${upd.summary}`, "warn"));
						const up = btn("更新", "btn primary");
						up.addEventListener("click", () => {
							up.disabled = true;
							up.textContent = "更新中…";
							send({ action: "skill-import:update", name: skill.name, scopeId: scope.id });
						});
						item.appendChild(up);
					}
					if (skill.backup && skill.enabled !== false) {
						const rb = btn("回滚");
						rb.addEventListener("click", () => {
							rb.disabled = true;
							send({ action: "skill-import:rollback", id: skill.installId });
						});
						item.appendChild(rb);
					}

					if (writable) {
						const toggle = btn(skill.enabled === false ? "启用" : "停用");
						toggle.title = skill.enabled === false ? "从 .disabled/ 搬回技能目录" : "搬进 .disabled/，Pi 不再扫描";
						toggle.addEventListener("click", () => {
							toggle.disabled = true;
							send({
								action: "skill-import:set-enabled",
								name: skill.name,
								scopeId: scope.id,
								enabled: skill.enabled === false,
							});
						});
						item.appendChild(toggle);
					}

					const dl = document.createElement("a");
					dl.className = "btn";
					dl.textContent = "下载";
					if (state.downloadContext) dl.href = `/plugins-api/skill-import/download?name=${encodeURIComponent(skill.name)}&scopeId=${encodeURIComponent(scope.id)}&context=${encodeURIComponent(state.downloadContext)}`;
					else dl.title = "等待项目上下文确认；请点刷新后下载";
					dl.setAttribute("download", `${skill.name}.zip`);
					item.appendChild(dl);

					if (writable) {
						const del = btn("删除");
						let armed = false;
						let timer = null;
						del.addEventListener("click", () => {
							if (!armed) {
								armed = true;
								del.textContent = "确认删除";
								del.style.color = "var(--err-text, var(--text))";
								timer = setTimeout(() => {
									armed = false;
									del.textContent = "删除";
									del.style.color = "";
								}, 3000);
								return;
							}
							clearTimeout(timer);
							del.disabled = true;
							del.textContent = "删除中…";
							send({ action: "skill-import:remove", name: skill.name, scopeId: scope.id });
						});
						item.appendChild(del);
					}

					installedBox.appendChild(item);
				}
			}
			installedCount.className = "si-badge";
			installedCount.textContent = `${enabledCount} 个启用${total > enabledCount ? ` · ${total - enabledCount} 个停用` : ""}`;
			if (total === 0) installedBox.appendChild(h("div", "si-empty", "还没有技能，去「导入」或「推荐」里装一个。"));
		}

		function renderUpdates(data) {
			state.updates = new Map();
			for (const item of data.items ?? []) state.updates.set(`${item.scopeId}:${item.name}`, item);
			updatesBox.replaceChildren();
			if (!data.items?.length) {
				updatesBox.appendChild(h("div", "si-empty", "没有由本插件导入的技能，没有可检查的来源。"));
				return;
			}
			const summary = h("div", "si-row");
			summary.appendChild(badge(`检查 ${data.checked} 个 · 可更新 ${data.updates}`, data.updates > 0 ? "warn" : "ok"));
			updatesBox.appendChild(summary);
			for (const item of data.items) {
				if (item.status === "up-to-date") continue;
				const row = h("div", "si-item");
				row.appendChild(h("span", "nm", item.name));
				if (item.status === "update-available") row.appendChild(badge(item.summary, "warn"));
				else if (item.status === "no-source") row.appendChild(badge("无来源信息"));
				else row.appendChild(badge(`检查失败：${item.error}`, "err"));
				updatesBox.appendChild(row);
			}
			if (state.list) renderList(state.list);
		}

		// ---------- 推荐 ----------
		function recCard(item, { pinned = false } = {}) {
			let targetScope = state.scopeId;
			const card = h("div", "si-item si-rec");
			const top = h("div", "si-row");
			top.appendChild(h("span", "nm", item.name));
			if (item.license) top.appendChild(badge(item.license));
			if (item.installed) {
				const s = item.installed;
				top.appendChild(badge(s.status === "disabled" ? "已停用" : s.status === "reloading" ? "等待重新加载" : "已启用", s.status === "enabled" ? "ok" : "warn"));
			}
			card.appendChild(top);

			if (item.reason) card.appendChild(h("div", "si-foot", item.reason));
			else if (item.why?.length) {
				const why = h("div", "si-why");
				for (const w of item.why.slice(0, 4)) why.appendChild(chip(w));
				card.appendChild(why);
			}
			if (item.addedCapability) card.appendChild(h("div", "si-foot", `新增能力：${item.addedCapability}`));
			if (item.requirements?.length) card.appendChild(h("div", "si-foot", `需要：${item.requirements.join("、")}`));
			if (item.fallback) card.appendChild(badge("规则匹配"));
			if (item.description) card.appendChild(h("div", "si-desc", item.description));
			card.appendChild(h("div", "si-foot", `文档限制：${item.limits?.join("；") || "未声明"}`));
			card.appendChild(h("div", "si-foot", `文档依赖（未验证）：${item.deps?.join("、") || "未声明，不代表无依赖"}`));
			const proof = h("details", "si-foot");
			proof.appendChild(h("summary", "", "原文依据（规则提取，非能力验证）"));
			const evidence = item.evidence?.length ? item.evidence : item.description ? [{ section: "frontmatter.description", quote: item.description }] : [];
			for (const e of evidence) proof.appendChild(h("div", "", `${e.section}：${String(e.quote).slice(0, 500)}${String(e.quote).length > 500 ? "…" : ""}`));
			proof.appendChild(h("div", "si-mono", `${item.repo ?? ""}@${item.ref || "HEAD"}/${item.path ? `${item.path}/` : ""}SKILL.md（未锁定 commit）`));
			card.appendChild(proof);
			if (item.variants?.length) {
				const variants = h("div", "si-foot");
				variants.appendChild(h("div", "", `另有 ${item.variants.length} 个近似/同名来源；先预览该来源，不能沿用本卡片的能力判断：`));
				for (const variant of item.variants) {
					const preview = btn(`预览 ${variant.repo}#${variant.ref || "HEAD"}/${variant.path}`, "btn si-btn-mini");
					preview.addEventListener("click", () => {
						setTab("import");
						send({ action: "skill-import:preview", source: `${variant.repo}${variant.ref ? `#${variant.ref}` : ""}`, path: variant.path, scopeId: targetScope });
					});
					variants.appendChild(preview);
				}
				card.appendChild(variants);
			}

			const row = h("div", "si-row");
			if (item.installed) {
				// 已装的不给安装按钮，给「启用 / 去对话里用」的入口
				if (item.installed.status === "disabled" && item.installed.scopeId) {
					const enable = btn("启用", "btn primary");
					enable.addEventListener("click", () => {
						enable.disabled = true;
						send({
							action: "skill-import:set-enabled",
							name: item.name,
							scopeId: item.installed.scopeId,
							enabled: true,
						});
					});
					row.appendChild(enable);
				}
				row.appendChild(chip(item.installed.note ?? "已安装"));
			} else {
				const scopeSel = installScopeSelect();
				targetScope = scopeSel.value;
				const install = btn("安装", "btn primary");
				const idleText = () => `安装到${scopeShort(scopeSel.value)}`;
				const note = h("div", "si-foot", "");
				install.textContent = idleText();
				// 安装要下载仓库（首次 20 秒上下），所以给进度、给超时、失败后一定把按钮恢复。
				const timer = { watchdog: null, tick: null };
				let pendingRid = "";
				const cancelBtn = btn("取消", "btn si-btn-mini");
				const clearTimers = () => {
					for (const key of ["watchdog", "tick"]) if (timer[key]) { clearTimeout(timer[key]); timer[key] = null; }
				};
				/** rid：只收本次请求的回包，避免取消后重试时旧回包把新状态改掉。 */
				const settle = (message, isError, rid = "") => {
					if (rid && rid !== pendingRid) return;
					clearTimers();
					install.disabled = false;
					install.textContent = idleText();
					cancelBtn.remove();
					note.textContent = message;
					note.style.color = isError ? "var(--red, #d9534f)" : "";
				};
				cancelBtn.addEventListener("click", () => {
					settle("已取消等待（后台可能仍在下载，不会重复写入已存在的技能）。", false);
					pendingRid = ""; // 取消后迟到的回包不再改写这张卡片
				});
				installPending.set(item.name, { settle });
				scopeSel.addEventListener("change", () => {
					targetScope = scopeSel.value;
					if (!install.disabled) install.textContent = idleText();
				});
				install.addEventListener("click", () => {
					install.disabled = true;
					install.textContent = "安装中…";
					note.style.color = "";
					pendingRid = `${item.name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
					const remoteRid = pendingRid;
					const startedAt = Date.now();
					note.textContent = "正在下载仓库（首次最慢）… 0s";
					if (typeof row.insertBefore === "function") row.insertBefore(cancelBtn, install);
					else row.appendChild(cancelBtn);
					timer.tick = setInterval(() => {
						const secs = Math.round((Date.now() - startedAt) / 1000);
						note.textContent = secs >= 45
							? `比预期慢（已 ${secs}s）：GitHub 访问慢或 API 限流，可以取消后重试，或在设置里填 githubToken。`
							: `正在下载仓库：已等待 ${secs}s（大仓库可达 1-2 分钟）`;
					}, 1000);
					timer.watchdog = setTimeout(() => {
						settle("安装超时（5 分钟）：可以重试，或换个技能；失败不会留下半装目录。", true);
					}, 300_000);
					send({
						action: "skill-import:recommend-install",
						name: item.name,
						id: item.id,
						scopeId: scopeSel.value,
						requestId: remoteRid,
					});
				});
				row.append(scopeSel, install);
				card.appendChild(note);
			}

			const src = chip(String(item.repo ?? ""), `${item.repo}${item.path ? ` / ${item.path}` : ""}`);
			if (item.repo) row.appendChild(src);

			if (item.installed) {
				// 已装条目只看状态，不再提供钉住
			} else if (pinned) {
				const unpin = btn("取消钉住");
				unpin.addEventListener("click", () => {
					unpin.disabled = true;
					send({ action: "skill-import:feedback", op: "unpin", name: item.name });
				});
				row.appendChild(unpin);
			} else {
				const pin = btn("钉住");
				pin.title = "放进收藏区，不占任务推荐名额";
				pin.addEventListener("click", () => {
					pin.disabled = true;
					send({ action: "skill-import:feedback", op: "pin", name: item.name });
				});
				row.appendChild(pin);
			}
			if (!item.installed) {
				const ignore = btn("不感兴趣");
				ignore.addEventListener("click", () => {
					ignore.disabled = true;
					send({ action: "skill-import:feedback", op: "ignore", name: item.name });
				});
				row.appendChild(ignore);
			}
			card.appendChild(row);
			return card;
		}

		function renderRecommend(data) {
			state.recommend = data;
			applyReload(data.reload);
			recBox.replaceChildren();
			recBtn.disabled = false;
			if (data.indexNeedsUpdate) recBox.appendChild(h("div", "si-foot", "正在复用旧索引；需要同步时到高级设置点「更新技能库」。"));

			if (data.needsIndex) {
				recStatus.className = "si-badge";
				recStatus.textContent = "还没有索引";
				recBtn.textContent = "建立索引并推荐";
				recBox.appendChild(
					h(
						"div",
						"si-foot",
						"推荐需要先建立技能索引：会从高级里的来源各拉一次 zipball（只读 SKILL.md 的名字和描述），之后 24 小时内走缓存。",
					),
				);
				return;
			}

			recBtn.textContent = "重新推荐";
			// 需求框：用户没改过、也没在输入时，跟随识别出的任务
			if (!state.demandEdited && document.activeElement !== demandInput) {
				demandInput.value = data.task?.text ?? "";
			}

			recStatus.className = `si-badge ${data.items?.length || data.pinned?.length ? "ok" : ""}`;
			const bits = [`${data.indexCount} 个候选`];
			if (data.sourceStats?.length) bits.push(`${data.sourceStats.length} 个源`);
			if (data.indexAt) bits.push(new Date(data.indexAt).toLocaleDateString());
			if (data.usedLLM) bits.push("模型精排");
			recStatus.textContent = bits.join(" · ");

			const meta = h("div", "si-foot");
			const modeText =
				data.task?.edited
					? "按你改的需求推荐"
					: data.task?.mode === "inherited"
						? "最近几条是短回复，沿用上一次的任务"
						: "按当前对话推荐";
			meta.textContent = data.task?.text ? `${modeText}：${data.task.text}` : modeText;
			recBox.appendChild(meta);
			if (data.llmError) recBox.appendChild(h("div", "si-foot", `精排没生效：${data.llmError}`));
			if (data.indexErrors?.length) {
				recBox.appendChild(h("div", "si-foot", `索引部分失败：${data.indexErrors.slice(0, 2).join("；")}`));
			}

			// 收藏（钉住）独立成区
			if (data.pinned?.length) {
				recBox.appendChild(h("div", "si-sec-title", `收藏（${data.pinned.length}）`));
				for (const item of data.pinned) recBox.appendChild(recCard(item, { pinned: true }));
			}

			// 任务推荐
			recBox.appendChild(h("div", "si-sec-title", data.items?.length ? "按任务推荐" : "按任务推荐（无）"));
			if (data.items?.length) {
				for (const item of data.items) recBox.appendChild(recCard(item));
			} else if (data.llmSaysNone) {
				recBox.appendChild(h("div", "si-empty", "当前库中没有能补上已有能力的技能（模型判断不值得装）。"));
			} else if (data.candidatesCount === 0) {
				recBox.appendChild(h("div", "si-empty", "没有匹配到候选：改一下上面的需求，或到高级里更新技能库。"));
			} else {
				recBox.appendChild(h("div", "si-empty", "没有匹配到还没装的技能。"));
			}

			// 已装可用（区分启用 / 停用 / 等待重新加载）
			if (data.installedHits?.length) {
				recBox.appendChild(h("div", "si-sec-title", "已装的技能"));
				const row = h("div", "si-row");
				for (const hit of data.installedHits) {
					const kind = hit.status === "enabled" ? "ok" : "warn";
					const label = hit.status === "enabled" ? "磁盘已启用" : hit.status === "disabled" ? "已停用" : hit.status === "reloading" ? "等待重新加载" : "状态未验证";
					const item = h("div", "si-item");
					item.appendChild(h("span", "nm", hit.name));
					item.appendChild(badge(label, kind));
					item.appendChild(h("span", "si-foot", hit.note));
					if (hit.status === "disabled" && hit.scopeId) {
						const enable = btn("启用", "btn primary");
						enable.addEventListener("click", () => {
							enable.disabled = true;
							send({ action: "skill-import:set-enabled", name: hit.name, scopeId: hit.scopeId, enabled: true });
						});
						item.appendChild(enable);
					}
					row.appendChild(item);
				}
				recBox.appendChild(row);
			}

			// 忽略清单
			const ignoredList = data.feedback?.ignored ?? [];
			if (ignoredList.length) {
				const row = h("div", "si-row");
				row.appendChild(badge(`已忽略 ${ignoredList.length} 个`));
				for (const name of ignoredList.slice(0, 8)) {
					const c = h("span", "si-chip", `${name} ↩`);
					c.title = "点击恢复推荐";
					c.addEventListener("click", () => send({ action: "skill-import:feedback", op: "unignore", name }));
					row.appendChild(c);
				}
				recBox.appendChild(row);
			}
		}

		// ---------- 来源 / 发现 / 健康 ----------
		function renderSources(data) {
			srcBox.style.display = "";
			srcBox.replaceChildren();
			const head = h("div", "si-row");
			head.appendChild(badge(`${(data.effective ?? []).length} 个源`));
			head.appendChild(h("span", "si-foot", "已装技能的来源与市场缓存会自动纳入"));
			srcBox.appendChild(head);

			const addRow = h("div", "si-row");
			const addInput = h("input", "si-input");
			addInput.placeholder = "owner/repo（可带 #分支）";
			const addBtn = btn("加入并重建");
			addBtn.addEventListener("click", () => {
				const repo = addInput.value.trim();
				if (!repo) return;
				addBtn.disabled = true;
				addBtn.textContent = "重建中…";
				send({ action: "skill-import:source-add", repo });
			});
			addRow.append(addInput, addBtn);
			srcBox.appendChild(addRow);

			for (const sug of data.suggestions ?? []) {
				const row = h("div", "si-item");
				row.appendChild(badge("市场里见过"));
				row.appendChild(h("span", "nm", sug.repo));
				const add = btn("加入");
				add.addEventListener("click", () => {
					add.disabled = true;
					add.textContent = "重建中…";
					send({ action: "skill-import:source-add", repo: sug.repo });
				});
				row.appendChild(add);
				srcBox.appendChild(row);
			}

			for (const s of data.effective ?? []) {
				const row = h("div", "si-item");
				row.appendChild(h("span", "nm", s.repo));
				if (s.count != null) row.appendChild(badge(`${s.count} 个`, "ok"));
				if (s.error) row.appendChild(badge(s.error.slice(0, 40), "err"));
				if (!s.count && !s.error) row.appendChild(badge("未建索引"));
				const rm = btn("移除");
				rm.addEventListener("click", () => {
					rm.disabled = true;
					send({ action: "skill-import:source-remove", repo: s.repo });
				});
				row.appendChild(rm);
				srcBox.appendChild(row);
			}
		}

		function renderDiscover(data) {
			srcBox.style.display = "";
			srcBox.replaceChildren();
			srcBox.appendChild(h("div", "si-foot", "GitHub 搜索（topic:agent-skills / claude-skills），点「加入」会拉一次 zipball 统计产量。"));
			if (!data.candidates?.length) {
				srcBox.appendChild(h("div", "si-empty", "没搜到候选（可能是网络或限流）"));
				return;
			}
			for (const c of data.candidates) {
				const row = h("div", "si-item");
				row.appendChild(h("span", "nm", c.repo));
				row.appendChild(badge(`${c.stars}★`));
				if (c.description) {
					const d = h("span", "si-foot", c.description);
					d.style.maxWidth = "100%";
					row.appendChild(d);
				}
				const add = btn(c.added ? "已加入" : "加入", c.added ? "btn" : "btn primary");
				add.disabled = c.added;
				add.addEventListener("click", () => {
					add.disabled = true;
					add.textContent = "重建中…";
					send({ action: "skill-import:source-add", repo: c.repo });
				});
				row.appendChild(add);
				srcBox.appendChild(row);
			}
		}

		function renderHealth(data) {
			healthBox.style.display = "";
			healthBox.replaceChildren();
			const t = data.totals ?? {};
			const summary = h("div", "si-row");
			summary.appendChild(
				badge(
					`${t.skills ?? 0} 个技能 · ${t.errors ?? 0} 错误 · ${t.warns ?? 0} 警告 · ${t.duplicates ?? 0} 重名`,
					t.errors ? "err" : t.warns || t.duplicates ? "warn" : "ok",
				),
			);
			healthBox.appendChild(summary);

			for (const dup of data.duplicates ?? []) {
				const row = h("div", "si-item");
				row.appendChild(badge("重名", "warn"));
				row.appendChild(h("span", "nm", dup.name));
				row.appendChild(h("span", "si-foot", `同时出现在 ${dup.scopes.join("、")}，Pi 只加载先发现的那份`));
				healthBox.appendChild(row);
			}

			for (const item of data.items ?? []) {
				if (!item.issues?.length) continue;
				const row = h("div", "si-item");
				row.appendChild(h("span", "nm", item.name));
				row.appendChild(badge(item.scopeId));
				const list = h("div", "si-issues");
				for (const issue of item.issues.slice(0, 6)) list.appendChild(issueLine(issue));
				if (item.issues.length > 6) list.appendChild(h("div", "si-empty", `还有 ${item.issues.length - 6} 条…`));
				row.appendChild(list);
				healthBox.appendChild(row);
			}
			if ((data.items ?? []).every((i) => !i.issues?.length) && !(data.duplicates ?? []).length) {
				healthBox.appendChild(h("div", "si-empty", "所有技能都没发现问题。"));
			}
		}

		// ---------- 上行数据 ----------
		const unsub = ctx.onData((payload) => {
			const type = String(payload?.type ?? "");
			if (type === "error") {
				// 失败时别把按钮永久锁住
				recBtn.disabled = false;
				recBtn.textContent = state.recommend?.needsIndex ? "建立索引并推荐" : "重新推荐";
				const message = String(payload?.message ?? "出错了");
				for (const [name, entry] of installPending) entry.settle(`${name} 安装失败：${message}`, true);
				installPending.clear();
				setResult("err", [h("div", "", message)]);
				return;
			}
			if (type === "context-changed") {
				send({ action: "skill-import:probe" });
				return;
			}
			if (type === "probe") {
				const data = payload.data ?? {};
				const usedGrant = state.awaitingGrant === true;
				state.awaitingGrant = false;
				const changed = state.cwd !== undefined && (state.cwd !== (data.cwd ?? "") || state.conversationId !== data.conversationId);
				if (changed) {
					state.demandEdited = false;
					demandInput.value = "";
					state.recommend = null;
					state.pendingReload = [];
					renderReload();
					previewSec.style.display = "none";
					resultSec.style.display = "none";
					recBox.replaceChildren(h("div", "si-foot", "对话或项目已切换，点击重新推荐。"));
					recBtn.disabled = false;
					// 切走之后旧安装的回包可能永远到不了当前卡片：先把按钮释放。
					for (const [, entry] of installPending) entry.settle("对话或项目已切换，安装状态已重置。", true);
					installPending.clear();
					send({ action: "skill-import:list" });
				}
				state.conversationId = data.conversationId;
				state.downloadContext = data.downloadContext;
				state.cwd = data.cwd ?? "";
				state.projectName = String(state.cwd).split("/").filter(Boolean).pop() ?? "";
				state.scopes = data.scopes ?? [];
				const writable = writableScopes();
				if (writable.length && !writable.some((s) => s.id === state.scopeId)) state.scopeId = writable[0].id;
				subLine.textContent = state.projectName
					? `当前项目：${state.projectName} · 装到项目就是 ${state.cwd}/.pi/skills`
					: "宿主没给插件本标签页的项目目录：到「高级」里填项目路径（或先用全局）；不会猜目录。";
				const found = projectResolver.resolve();
				const detected = found.path;
				if (!state.projectDirManual) {
					state.projectDir = detected || state.cwd;
					state.projectSource = detected ? found.source : state.cwd ? "服务端" : "";
					state.projectConfidence = detected ? found.confidence : state.cwd ? "low" : "none";
				}
				// 页面桥知道项目、但服务端这次没按它算落点 → 带上桥值再问一次（同一个值只补一次）
				if (detected && detected !== state.cwd && state.autoProbedFor !== detected && !state.projectDirManual) {
					state.autoProbedFor = detected;
					send({ action: "skill-import:probe" });
					return;
				}
				projInput.value = state.projectDir || projInput.value;
				projHint.textContent = state.projectName
					? `已识别项目：${state.cwd}${state.projectSource ? `（来源：${state.projectSource}）` : ""}`
					: state.projectDir
						? `当前工作区：${state.projectDir}（来源：${state.projectSource || "?"}；父目录需授权一次才能读写 .pi/skills）`
						: `没拿到项目目录。诊断：${projectResolver.diagnose().map((d) => `${d.label}=${d.value ? "有值" : "无"}`).join(" / ")}。也可以直接填绝对路径并点「使用此目录」。`;
				renderScopes(state.scopes);
				if (usedGrant) send({ action: "skill-import:list" });
				else if (state.list) renderList(state.list);
				return;
			}
			if (type === "preview") {
				const data = payload.data ?? {};
				if (!data.ok) {
					setResult("err", [h("div", "", data.error ?? "预览失败")]);
					return;
				}
				state.pickQuery = "";
				state.pickPage = 0;
				renderPreview(data);
				return;
			}
			if (type === "install") {
				renderInstall(payload.data ?? {});
				applyReload(payload.data?.reload);
				return;
			}
			if (type === "rollback") {
				const data = payload.data ?? {};
				if (data.ok) {
					setResult("ok", [h("div", "", `已回滚「${data.name}」，等待 /reload 加载还原版本`)]);
					applyReload(data.reload);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:probe" });
				} else {
					setResult("err", [h("div", "", data.error ?? "回滚失败")]);
				}
				return;
			}
			if (type === "list") {
				renderList(payload.data ?? {});
				return;
			}
			if (type === "updates") {
				renderUpdates(payload.data ?? {});
				return;
			}
			if (type === "health") {
				renderHealth(payload.data ?? {});
				return;
			}
			if (type === "recommend") {
				renderRecommend(payload.data ?? {});
				return;
			}
			if (type === "feedback") {
				const data = payload.data ?? {};
				if (!data.ok) setResult("err", [h("div", "", data.error ?? "操作失败")]);
				else requestRecommend();
				return;
			}
			if (type === "sources") {
				renderSources(payload.data ?? {});
				return;
			}
			if (type === "source-change") {
				const data = payload.data ?? {};
				if (!data.ok) {
					setResult("err", [h("div", "", data.error ?? "操作失败")]);
					return;
				}
				if (data.sources) renderSources(data.sources);
				requestRecommend();
				return;
			}
			if (type === "discover") {
				renderDiscover(payload.data ?? {});
				return;
			}
			if (type === "ack-reload") {
				const data = payload.data ?? {};
				applyReload(data.reload);
				if (data.cleared?.length) setResult("ok", [h("div", "", `已确认发送 /reload：${data.cleared.join("、")}（未自动验证加载结果）`)]);
				send({ action: "skill-import:list" });
				requestRecommend();
				return;
			}
			if (type === "recommend-install") {
				const data = payload.data ?? {};
				const entry = installPending.get(data.name) ?? installPending.get(String(data.error ?? "").match(/「(.+?)」/)?.[1] ?? "");
				const rid = String(payload?.requestId ?? payload?.data?.requestId ?? "");
				if (data.ok) {
					installPending.delete(data.name);
					entry?.settle("已安装，等待重新加载。", false, rid);
					setResult("ok", [
						h("div", "", `已安装推荐技能「${data.name}」`),
						h("div", "", "已安装，等待重新加载。"),
					]);
					applyReload(data.reload);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:probe" });
					requestRecommend();
				} else if (data.code === "conflict") {
					for (const [, e] of installPending) e.settle(`安装失败：${data.error ?? "已存在同名技能"}`, true);
					installPending.clear();
					setResult("err", [h("div", "", data.error ?? "已存在同名技能"), h("div", "si-foot", data.conflictHint ?? "")]);
				} else {
					for (const [, e] of installPending) e.settle(`安装失败：${data.error ?? "安装失败"}`, true);
					installPending.clear();
					setResult("err", [h("div", "", data.error ?? "安装失败")]);
				}
				return;
			}
			if (type === "toggle") {
				const data = payload.data ?? {};
				if (data.ok) {
					setResult("ok", [
						h("div", "", `已${data.enabled ? "启用" : "停用"}「${data.name}」`),
						h("div", "", "等待重新加载后生效（停用的技能在技能目录的 .disabled/ 里）。"),
					]);
					applyReload(data.reload);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:probe" });
					requestRecommend();
				} else {
					setResult("err", [h("div", "", data.error ?? "操作失败")]);
				}
				return;
			}
			if (type === "remove") {
				const data = payload.data ?? {};
				if (data.ok) {
					setResult("ok", [h("div", "", `已删除「${data.name}」，等待 /reload 从会话中卸载`)]);
					applyReload(data.reload);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:probe" });
					requestRecommend();
				} else {
					setResult("err", [h("div", "", data.error ?? "删除失败")]);
				}
				return;
			}
			if (type === "update") {
				const data = payload.data ?? {};
				if (data.ok) {
					const lines = [h("div", "", `已更新「${data.name}」${data.diffSummary ? `：${data.diffSummary}` : ""}`)];
					if (data.backup) lines.push(h("div", "si-mono", `备份：${data.backup}`));
					lines.push(h("div", "", "已更新，等待重新加载。"));
					applyReload(data.reload);
					setResult("ok", lines);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:check-updates" });
				} else {
					setResult("err", [h("div", "", data.error ?? "更新失败")]);
				}
			}
		});

		// ---------- 事件 ----------
		demandInput.addEventListener("input", () => {
			state.demandEdited = demandInput.value.trim() !== "";
		});
		demandInput.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
				e.preventDefault();
				demandGo.click();
			}
		});
		demandGo.addEventListener("click", () => {
			const q = demandValue();
			if (!q) {
				setResult("err", [h("div", "", "先写一句这次要做的事")]);
				return;
			}
			state.demandEdited = true;
			demandGo.disabled = true;
			send({ action: "skill-import:recommend", q });
			setTimeout(() => {
				demandGo.disabled = false;
			}, 800);
		});
		demandReset.addEventListener("click", () => {
			state.demandEdited = false;
			demandInput.value = "";
			requestRecommend();
		});

		const previewSource = () => {
			const raw = input.value.trim();
			if (!raw) return "";
			if (/^text:/i.test(raw)) return raw;
			// 多行粘贴 = SKILL.md 全文
			if (raw.includes("\n")) return `text:\n${raw}`;
			return raw;
		};
		previewBtn.addEventListener("click", () => {
			const source = previewSource();
			if (!source) {
				setResult("err", [h("div", "", "先填一个来源，或粘贴 SKILL.md")]);
				return;
			}
			state.pickQuery = "";
			state.pickPage = 0;
			previewBtn.disabled = true;
			send({ action: "skill-import:preview", source, scopeId: state.scopeId });
			setTimeout(() => {
				previewBtn.disabled = false;
			}, 800);
		});
		input.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
				e.preventDefault();
				previewBtn.click();
			}
		});

		refresh.addEventListener("click", () => {
			send({ action: "skill-import:probe" });
			send({ action: "skill-import:list" });
			requestRecommend();
		});
		advToggle.addEventListener("click", () => {
			const on = !advSec.classList.contains("on");
			advSec.classList.toggle("on", on);
			advToggle.classList.toggle("on", on);
			if (on) send({ action: "skill-import:sources" });
		});
		recBtn.addEventListener("click", () => {
			recBtn.disabled = true;
			recBtn.textContent = state.recommend?.needsIndex ? "索引中…" : "推荐中…";
			requestRecommend();
		});
		rebuildBtn.addEventListener("click", () => {
			rebuildBtn.disabled = true;
			rebuildBtn.textContent = "更新中…";
			send({ action: "skill-import:recommend", force: true, ...(state.demandEdited && demandValue() ? { q: demandValue() } : {}) });
			setTimeout(() => {
				rebuildBtn.disabled = false;
				rebuildBtn.textContent = "更新技能库";
			}, 3000);
		});
		checkBtn.addEventListener("click", () => {
			checkBtn.disabled = true;
			checkBtn.textContent = "检查中…";
			send({ action: "skill-import:check-updates" });
			setTimeout(() => {
				checkBtn.disabled = false;
				checkBtn.textContent = "检查更新";
			}, 1500);
		});
		sourcesBtn.addEventListener("click", () => {
			if (srcBox.style.display !== "none") {
				srcBox.style.display = "none";
				return;
			}
			send({ action: "skill-import:sources" });
		});
		discoverBtn.addEventListener("click", () => {
			discoverBtn.disabled = true;
			discoverBtn.textContent = "搜索中…";
			send({ action: "skill-import:discover" });
			setTimeout(() => {
				discoverBtn.disabled = false;
				discoverBtn.textContent = "发现更多";
			}, 4000);
		});
		projUse.addEventListener("click", () => {
			const value = String(projInput.value ?? "").trim();
			if (!value.startsWith("/")) {
				projHint.textContent = "要填绝对路径（以 / 开头）。";
				return;
			}
			state.projectDir = value.replace(/\/+$/, "");
			state.projectDirManual = true;
			projHint.textContent = `已使用：${state.projectDir}`;
			send({ action: "skill-import:probe" });
			send({ action: "skill-import:list" });
		});
		healthBtn.addEventListener("click", () => {
			healthBtn.disabled = true;
			healthBtn.textContent = "检查中…";
			send({ action: "skill-import:health" });
			setTimeout(() => {
				healthBtn.disabled = false;
				healthBtn.textContent = "检查全部技能";
			}, 1500);
		});

		setTab("rec");
		send({ action: "skill-import:probe" });
		send({ action: "skill-import:list" });
		send({ action: "skill-import:recommend" });

		return () => {
			disposed = true;
			unsub?.();
			style.remove();
			root.remove();
		};
	},
});
