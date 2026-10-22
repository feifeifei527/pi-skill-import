/**
 * skill-import —— 客户端视图。
 * 区块：技能落点 / 导入（来源 → 校验 → 安装）/ 已装与更新 / 健康检查。
 */
import { defineView } from "./sdk/index.mjs";

const CSS = `
.si-wrap { display:flex; flex-direction:column; gap:14px; padding:16px 18px 28px; color:var(--text); font-size:13px; }
.si-head { display:flex; align-items:flex-start; gap:12px; }
.si-title { font-size:15px; font-weight:600; letter-spacing:.2px; }
.si-sub { color:var(--text-dim); font-size:12px; margin-top:3px; line-height:1.5; }
.si-grow { flex:1; }
.si-sec { background:var(--bg-elev); border:1px solid var(--border); border-radius:10px; padding:12px 14px; display:flex; flex-direction:column; gap:10px; }
.si-sec-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.si-sec-title { font-size:12px; color:var(--text-faint); text-transform:uppercase; letter-spacing:.5px; }
.si-scopes { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:8px; }
.si-scope { background:var(--bg-elev2); border:1px solid var(--border-soft); border-radius:8px; padding:8px 10px; min-width:0; }
.si-scope.denied { border-color:var(--amber,var(--border)); }
.si-scope b { font-weight:600; font-size:12px; }
.si-path { font-family:var(--mono); font-size:11px; color:var(--text-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; }
.si-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.si-input { flex:1 1 320px; min-width:0; background:var(--inputbox-bg,var(--bg)); border:1px solid var(--border); border-radius:8px;
  color:var(--text); font-family:var(--mono); font-size:12px; padding:7px 10px; outline:none; }
.si-input:focus { border-color:var(--accent); }
.si-badge { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--border); background:var(--chip-bg); color:var(--text-dim); }
.si-badge.ok { color:var(--green,var(--text)); border-color:var(--green,var(--border)); }
.si-badge.warn { color:var(--amber-text,var(--text)); border-color:var(--amber,var(--border)); }
.si-badge.err { color:var(--err-text,var(--text)); border-color:var(--err-text,var(--border)); }
.si-chip { font-family:var(--mono); font-size:11px; padding:1px 6px; border-radius:6px; background:var(--bg-elev2); color:var(--text-dim); cursor:pointer; }
.si-chip:hover { color:var(--accent); }
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
.si-foot { color:var(--text-faint); font-size:11.5px; line-height:1.6; }
.si-rec { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
.si-rec .si-desc { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.si-why { display:flex; gap:4px; flex-wrap:wrap; }
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

export default defineView({
	mount(container, ctx) {
		const style = document.createElement("style");
		style.textContent = CSS;
		container.appendChild(style);

		const root = h("div", "si-wrap");
		const head = h("div", "si-head");
		const titleBox = h("div");
		titleBox.appendChild(h("div", "si-title", "技能导入"));
		titleBox.appendChild(h("div", "si-sub", "整目录安装 Agent Skills：先校验，再落盘；同名给 diff 并留备份。"));
		const refresh = btn("刷新");
		head.append(titleBox, h("div", "si-grow"), refresh);

		// 落点
		const scopesSec = h("div", "si-sec");
		scopesSec.appendChild(h("div", "si-sec-title", "技能落点"));
		const scopesBox = h("div", "si-scopes");
		scopesSec.appendChild(scopesBox);

		// 导入
		const importSec = h("div", "si-sec");
		importSec.appendChild(h("div", "si-sec-title", "导入"));
		const inputRow = h("div", "si-row");
		const input = h("input", "si-input");
		input.placeholder = "owner/repo、GitHub 链接、zip 直链、/本地/目录、text:粘贴内容";
		const previewBtn = btn("预览", "btn primary");
		inputRow.append(input, previewBtn);
		importSec.append(
			inputRow,
			h("div", "si-foot", "GitHub 仓库会下载 zipball 后只取目标技能目录；不会跑任何脚本。停用 = 搬进技能目录的 .disabled/（Pi 不再扫描），随时可启用。"),
		);

		// 预览
		const previewSec = h("div", "si-sec");
		previewSec.style.display = "none";
		const previewBody = h("div", "si-sec");
		previewBody.style.cssText = "border:none;background:transparent;padding:0;gap:10px";
		previewSec.appendChild(previewBody);

		// 结果
		const resultSec = h("div", "si-sec");
		resultSec.style.display = "none";
		const resultBody = h("div", "si-result");
		resultSec.append(h("div", "si-sec-title", "最近一次操作"), resultBody);

		// 已装 + 更新
		const installedSec = h("div", "si-sec");
		const installedHead = h("div", "si-sec-head");
		installedHead.appendChild(h("div", "si-sec-title", "已安装"));
		installedHead.appendChild(h("div", "si-grow"));
		const checkBtn = btn("检查更新");
		const healthBtn = btn("健康检查");
		installedHead.append(checkBtn, healthBtn);
		const updatesBox = h("div", "si-list");
		const installedBox = h("div", "si-list");
		installedSec.append(installedHead, updatesBox, installedBox);

		// 健康检查
		const healthSec = h("div", "si-sec");
		healthSec.style.display = "none";
		healthSec.appendChild(h("div", "si-sec-title", "健康检查"));
		const healthBox = h("div", "si-list");
		healthSec.appendChild(healthBox);

		// 推荐
		const recSec = h("div", "si-sec");
		const recHead = h("div", "si-sec-head");
		recHead.appendChild(h("div", "si-sec-title", "推荐"));
		const recStatus = h("span", "si-badge", "…");
		const sourcesBtn = btn("源");
		const discoverBtn = btn("发现更多");
		const recBtn = btn("重建索引");
		recHead.append(recStatus, h("div", "si-grow"), sourcesBtn, discoverBtn, recBtn);
		const recBox = h("div", "si-list");
		const srcBox = h("div", "si-list");
		srcBox.style.display = "none";
		recSec.append(recHead, srcBox, recBox);

		root.append(head, recSec, scopesSec, importSec, previewSec, resultSec, installedSec, healthSec);
		container.appendChild(root);

		let disposed = false;
		const send = (payload) => {
			if (!disposed) ctx.send(payload);
		};

		const state = {
			scopes: [],
			preview: null,
			token: "",
			path: "",
			scopeId: "project",
			conflictOk: false,
			list: null,
			updates: new Map(),
			recommend: null,
		};

		function setResult(kind, lines) {
			resultSec.style.display = "";
			resultBody.className = `si-result ${kind}`;
			resultBody.replaceChildren(...lines);
		}

		function renderScopes(scopes) {
			scopesBox.replaceChildren();
			for (const scope of scopes) {
				const card = h("div", scope.authorized ? "si-scope" : "si-scope denied");
				const top = h("div", "si-row");
				top.appendChild(h("b", "", scope.label));
				if (!scope.authorized) top.appendChild(h("span", "si-badge warn", "未授权"));
				else top.appendChild(h("span", scope.count > 0 ? "si-badge ok" : "si-badge", `${scope.count} 个`));
				if (!scope.writable) top.appendChild(h("span", "si-badge", "只读兼容位"));
				card.appendChild(top);
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

		function issueLine(issue) {
			const row = h("div", `si-issue ${issue.level}`);
			row.appendChild(h("span", "lv", issue.level === "error" ? "错误" : issue.level === "warn" ? "警告" : "提示"));
			row.appendChild(h("span", "", issue.message));
			if (issue.hint) row.appendChild(h("span", "hint", `（${issue.hint}）`));
			return row;
		}

		function renderPreview(p) {
			previewSec.style.display = "";
			previewBody.replaceChildren();
			state.preview = p;
			state.token = p.token ?? state.token;
			state.path = p.path ?? "";
			if (p.scopeId) state.scopeId = p.scopeId;

			const srcRow = h("div", "si-row");
			srcRow.appendChild(h("span", "si-badge", p.source?.label ?? "来源"));
			if (p.source?.skipped?.length) srcRow.appendChild(h("span", "si-badge warn", `跳过 ${p.source.skipped.length} 个文件`));
			if (p.needsPick) srcRow.appendChild(h("span", "si-badge warn", `仓库里有 ${p.candidates.length} 个技能，选一个`));
			previewBody.appendChild(srcRow);

			if (p.needsPick) {
				const chips = h("div", "si-row");
				for (const c of p.candidates.slice(0, 40)) {
					const chip = h("span", "si-chip", c.label);
					chip.title = c.path || "(根目录)";
					chip.addEventListener("click", () => {
						state.conflictOk = false;
						send({ action: "skill-import:preview", token: state.token, path: c.path, scopeId: state.scopeId });
					});
					chips.appendChild(chip);
				}
				previewBody.appendChild(chips);
			}

			const inspection = p.inspection;
			if (!inspection) return;
			const skill = inspection.skill;
			const nameRow = h("div", "si-row");
			nameRow.appendChild(h("b", "", skill.name || "(未命名)"));
			nameRow.appendChild(h("span", `si-badge ${inspection.ok ? "ok" : "err"}`, inspection.summary));
			if (skill.frontmatter?.license) nameRow.appendChild(h("span", "si-badge", `license: ${skill.frontmatter.license}`));
			if (skill.frontmatter?.["disable-model-invocation"] === true) nameRow.appendChild(h("span", "si-badge", "仅手动触发"));
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
			for (const scope of (p.scopes ?? []).filter((s) => s.writable)) {
				const label = h("label", "si-radio");
				const radio = document.createElement("input");
				radio.type = "radio";
				radio.name = "si-scope";
				radio.value = scope.id;
				radio.checked = scope.id === state.scopeId;
				radio.addEventListener("change", () => {
					state.scopeId = scope.id;
					state.conflictOk = false;
					send({ action: "skill-import:preview", token: state.token, path: state.path, scopeId: state.scopeId });
				});
				label.append(radio, document.createTextNode(`${scope.label}（${scope.count}）`));
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
					token: state.token,
					path: state.path,
					scopeId: state.scopeId,
					overwrite: state.conflictOk,
				});
			});
			const cancel = btn("清空");
			cancel.addEventListener("click", () => {
				previewSec.style.display = "none";
				state.preview = null;
				state.token = "";
				state.path = "";
				state.conflictOk = false;
			});
			actionRow.append(installBtn, cancel);
			if (!inspection.ok) actionRow.appendChild(h("span", "si-foot", "有错误项，装不了"));
			previewBody.appendChild(actionRow);
		}

		function renderInstall(data) {
			if (data.ok) {
				state.conflictOk = false;
				const lines = [h("div", "", `已安装「${data.name}」→ ${data.files} 个文件`)];
				if (data.diffSummary) lines.push(h("div", "si-foot", `本次变化：${data.diffSummary}`));
				lines.push(h("div", "si-mono", data.target));
				lines.push(h("div", "", "在对话里发送 /reload，让 Pi 重新扫描技能目录。"));
				setResult("ok", lines);
				previewSec.style.display = "none";
				state.preview = null;
				state.token = "";
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
					state.conflictOk = true;
					force.disabled = true;
					force.textContent = "安装中…";
					send({
						action: "skill-import:install",
						token: state.token,
						path: state.path,
						scopeId: state.scopeId,
						overwrite: true,
					});
				});
				lines.push(force);
			}
			for (const issue of data.issues ?? []) lines.push(h("div", "si-mono", `· ${issue.message}`));
			setResult("err", lines);
		}

		function renderList(data) {
			state.list = data;
			installedBox.replaceChildren();
			let total = 0;
			for (const scope of data.scopes ?? []) {
				const writable = scope.writable !== false;
				const items = scope.skills ?? [];
				if (!items.length) continue;
				const enabled = items.filter((x) => x.enabled !== false);
				const parked = items.filter((x) => x.enabled === false);
				const head = h("div", "si-row");
				head.appendChild(h("span", "si-badge", `${scope.label} · ${enabled.length}${parked.length ? ` / 停用 ${parked.length}` : ""}`));
				installedBox.appendChild(head);

				for (const skill of items) {
					total++;
					const item = h("div", "si-item");
					item.appendChild(h("span", "nm", skill.name));
					if (skill.enabled === false) item.appendChild(h("span", "si-badge warn", "已停用"));
					if (skill.managed) item.appendChild(h("span", "si-badge ok", "导入的"));
					if (skill.source) {
						const src = h("span", "si-chip", String(skill.source).slice(0, 32));
						src.title = skill.source;
						src.style.cursor = "default";
						item.appendChild(src);
					}

					const upd = state.updates.get(`${scope.id}:${skill.name}`);
					if (skill.enabled !== false && upd?.status === "update-available") {
						item.appendChild(h("span", "si-badge warn", `可更新：${upd.summary}`));
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

					// 启停（只读落点不给按钮）
					if (writable) {
					const toggle = btn(skill.enabled === false ? "启用" : "停用");
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

					// 下载
					const dl = document.createElement("a");
					dl.className = "btn";
					dl.textContent = "下载";
					dl.href = `/plugins-api/skill-import/download?name=${encodeURIComponent(skill.name)}&scopeId=${encodeURIComponent(scope.id)}`;
					dl.setAttribute("download", `${skill.name}.zip`);
					item.appendChild(dl);

					// 删除（两次点击确认）
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
			if (total === 0) installedBox.appendChild(h("div", "si-empty", "还没有技能"));
		}

		function renderUpdates(data) {
			state.updates = new Map();
			for (const item of data.items ?? []) state.updates.set(`${item.scopeId}:${item.name}`, item);
			updatesBox.replaceChildren();
			const ignoredList = data.feedback?.ignored ?? [];
			if (ignoredList.length) {
				const row = h("div", "si-row");
				row.appendChild(h("span", "si-badge", `已忽略 ${ignoredList.length} 个`));
				for (const name of ignoredList.slice(0, 8)) {
					const chip = h("span", "si-chip", `${name} ↩`);
					chip.title = "点击恢复推荐";
					chip.addEventListener("click", () => send({ action: "skill-import:feedback", op: "unignore", name }));
					row.appendChild(chip);
				}
				recBox.appendChild(row);
			}

			if (!data.items?.length) {
				updatesBox.appendChild(h("div", "si-empty", "没有由本插件导入的技能，没有可检查的来源。"));
				return;
			}
			const summary = h("div", "si-row");
			summary.appendChild(h("span", `si-badge ${data.updates > 0 ? "warn" : "ok"}`, `检查 ${data.checked} 个 · 可更新 ${data.updates}`));
			updatesBox.appendChild(summary);
			for (const item of data.items) {
				if (item.status === "up-to-date") continue;
				const row = h("div", "si-item");
				row.appendChild(h("span", "nm", item.name));
				if (item.status === "update-available") {
					row.appendChild(h("span", "si-badge warn", item.summary));
				} else if (item.status === "no-source") {
					row.appendChild(h("span", "si-badge", "无来源信息"));
				} else {
					row.appendChild(h("span", "si-badge err", `检查失败：${item.error}`));
				}
				updatesBox.appendChild(row);
			}
			if (state.list) renderList(state.list);
		}

		function renderRecommend(data) {
			state.recommend = data;
			recBox.replaceChildren();
			recBtn.textContent = data.needsIndex ? "建立索引并推荐" : "重建索引";
			recBtn.disabled = false;
			if (data.needsIndex) {
				recStatus.className = "si-badge";
				recStatus.textContent = "还没有索引";
				recBox.appendChild(
					h("div", "si-foot", "推荐需要先建立技能索引：会从设置里的仓库各拉一次 zipball（只读 SKILL.md 的名字和描述），之后 24 小时内走缓存。"),
				);
				return;
			}
			recStatus.className = `si-badge ${data.items?.length ? "ok" : ""}`;
			recStatus.textContent = `${data.indexCount} 个候选${data.sourceStats?.length ? ` · ${data.sourceStats.length} 个源` : ""} · ${new Date(data.indexAt).toLocaleDateString()}`;
			if (data.usedLLM) recStatus.textContent += " · 模型精排";
			if (data.task?.text) recBox.appendChild(h("div", "si-foot", `这次要做：${data.task.text}`));
			if (data.llmError) recBox.appendChild(h("div", "si-foot", `精排没生效：${data.llmError}`));
			if (data.indexErrors?.length) {
				recBox.appendChild(h("div", "si-foot", `索引部分失败：${data.indexErrors.slice(0, 2).join("；")}`));
			}
			const ignoredList = data.feedback?.ignored ?? [];
			if (ignoredList.length) {
				const row = h("div", "si-row");
				row.appendChild(h("span", "si-badge", `已忽略 ${ignoredList.length} 个`));
				for (const name of ignoredList.slice(0, 8)) {
					const chip = h("span", "si-chip", `${name} ↩`);
					chip.title = "点击恢复推荐";
					chip.addEventListener("click", () => send({ action: "skill-import:feedback", op: "unignore", name }));
					row.appendChild(chip);
				}
				recBox.appendChild(row);
			}

			if (!data.items?.length) {
				if (data.installedHits?.length) {
					const row = h("div", "si-row");
					row.appendChild(h("span", "si-badge ok", "已装可直接用"));
					for (const hit of data.installedHits) row.appendChild(h("span", "si-chip", hit.name));
					recBox.appendChild(row);
				}
				const msg =
					data.usedLLM && data.candidatesCount > 0
						? "当前库中没有能补上已有能力的技能（模型判断不值得装）。"
						: data.candidatesCount === 0
							? "没有匹配到候选：先聊两句或打开相关项目，再点「重建索引」。"
							: "没有匹配到还没装的技能。";
				recBox.appendChild(h("div", "si-empty", msg));
				return;
			}
			for (const item of data.items) {
				const card = h("div", "si-item si-rec");
				const top = h("div", "si-row");
				top.appendChild(h("span", "nm", item.name));
				if (item.license) top.appendChild(h("span", "si-badge", item.license));
				card.appendChild(top);
				if (item.reason) {
					card.appendChild(h("div", "si-foot", item.reason));
				} else if (item.why?.length) {
					const why = h("div", "si-why");
					for (const w of item.why.slice(0, 4)) why.appendChild(h("span", "si-chip", w));
					card.appendChild(why);
				}
				if (item.addedCapability) {
					card.appendChild(h("div", "si-foot", `新增能力：${item.addedCapability}`));
				}
				if (item.requirements?.length) {
					card.appendChild(h("div", "si-foot", `需要：${item.requirements.join("、")}`));
				}
				if (item.fallback) card.appendChild(h("span", "si-badge", "规则匹配"));
				if (item.description) card.appendChild(h("div", "si-desc", item.description));
				const row = h("div", "si-row");
				const install = btn("安装", "btn primary");
				install.addEventListener("click", () => {
					install.disabled = true;
					install.textContent = "安装中…";
					send({ action: "skill-import:recommend-install", name: item.name, scopeId: state.scopeId });
				});
				const src = h("span", "si-chip", String(item.repo ?? ""));
				src.style.cursor = "default";
				src.title = `${item.repo}${item.path ? ` / ${item.path}` : ""}`;
				row.append(install, src);

				if (item.pinned) {
					card.insertBefore(h("span", "si-badge ok", "已钉住"), card.firstChild);
					const unpin = btn("取消钉住");
					unpin.addEventListener("click", () => {
						unpin.disabled = true;
						send({ action: "skill-import:feedback", op: "unpin", name: item.name });
					});
					row.appendChild(unpin);
				} else {
					const pin = btn("钉住");
					pin.addEventListener("click", () => {
						pin.disabled = true;
						send({ action: "skill-import:feedback", op: "pin", name: item.name });
					});
					row.appendChild(pin);
				}
				const ignore = btn("不感兴趣");
				ignore.addEventListener("click", () => {
					ignore.disabled = true;
					send({ action: "skill-import:feedback", op: "ignore", name: item.name });
				});
				row.appendChild(ignore);
				card.appendChild(row);
				recBox.appendChild(card);
			}
		}

		function renderSources(data) {
			srcBox.style.display = "";
			srcBox.replaceChildren();
			const head = h("div", "si-row");
			head.appendChild(h("span", "si-badge", `${(data.effective ?? []).length} 个源`));
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
				row.appendChild(h("span", "si-badge", "市场里见过"));
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
				if (s.count != null) row.appendChild(h("span", "si-badge ok", `${s.count} 个`));
				if (s.error) row.appendChild(h("span", "si-badge err", s.error.slice(0, 40)));
				if (!s.count && !s.error) row.appendChild(h("span", "si-badge", "未建索引"));
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
				row.appendChild(h("span", "si-badge", `${c.stars}★`));
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
			healthSec.style.display = "";
			healthBox.replaceChildren();
			const t = data.totals ?? {};
			const summary = h("div", "si-row");
			summary.appendChild(
				h("span", `si-badge ${t.errors ? "err" : t.warns || t.duplicates ? "warn" : "ok"}`,
					`${t.skills ?? 0} 个技能 · ${t.errors ?? 0} 错误 · ${t.warns ?? 0} 警告 · ${t.duplicates ?? 0} 重名`),
			);
			healthBox.appendChild(summary);

			for (const dup of data.duplicates ?? []) {
				const row = h("div", "si-item");
				row.appendChild(h("span", "si-badge warn", "重名"));
				row.appendChild(h("span", "nm", dup.name));
				row.appendChild(h("span", "si-foot", `同时出现在 ${dup.scopes.join("、")}，Pi 只加载先发现的那份`));
				healthBox.appendChild(row);
			}

			for (const item of data.items ?? []) {
				if (!item.issues?.length) continue;
				const row = h("div", "si-item");
				row.appendChild(h("span", "nm", item.name));
				row.appendChild(h("span", "si-badge", item.scopeId));
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

		const unsub = ctx.onData((payload) => {
			const type = String(payload?.type ?? "");
			if (type === "error") {
				setResult("err", [h("div", "", String(payload?.message ?? "出错了"))]);
				return;
			}
			if (type === "probe") {
				const data = payload.data ?? {};
				state.scopes = data.scopes ?? [];
				renderScopes(state.scopes);
				return;
			}
			if (type === "preview") {
				const data = payload.data ?? {};
				if (!data.ok) {
					setResult("err", [h("div", "", data.error ?? "预览失败")]);
					return;
				}
				renderPreview(data);
				return;
			}
			if (type === "install") {
				renderInstall(payload.data ?? {});
				return;
			}
			if (type === "rollback") {
				const data = payload.data ?? {};
				if (data.ok) {
					setResult("ok", [h("div", "", `已回滚「${data.name}」，旧版本已还原`)]);
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
				else send({ action: "skill-import:recommend" });
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
				// 源变了 → 重新推荐（addSource 已重建索引）
				send({ action: "skill-import:recommend" });
				return;
			}
			if (type === "discover") {
				renderDiscover(payload.data ?? {});
				return;
			}
			if (type === "recommend-install") {
				const data = payload.data ?? {};
				if (data.ok) {
					setResult("ok", [h("div", "", `已安装推荐技能「${data.name}」`), h("div", "", "在对话里发送 /reload 生效。")]);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:probe" });
					send({ action: "skill-import:recommend" });
				} else if (data.code === "conflict") {
					setResult("err", [h("div", "", data.error ?? "已存在同名技能"), h("div", "si-foot", data.conflictHint ?? "")]);
				} else {
					setResult("err", [h("div", "", data.error ?? "安装失败")]);
				}
				return;
			}
			if (type === "toggle") {
				const data = payload.data ?? {};
				if (data.ok) {
					setResult("ok", [
						h("div", "", `已${data.enabled ? "启用" : "停用"}「${data.name}」`),
						h("div", "", "在对话里发送 /reload 生效（停用的技能会搬到技能目录下的 .disabled/）。"),
					]);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:probe" });
				} else {
					setResult("err", [h("div", "", data.error ?? "操作失败")]);
				}
				return;
			}
			if (type === "remove") {
				const data = payload.data ?? {};
				if (data.ok) {
					setResult("ok", [h("div", "", `已删除「${data.name}」`)]);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:probe" });
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
					lines.push(h("div", "", "在对话里发送 /reload 生效。"));
					setResult("ok", lines);
					send({ action: "skill-import:list" });
					send({ action: "skill-import:check-updates" });
				} else {
					setResult("err", [h("div", "", data.error ?? "更新失败")]);
				}
			}
		});

		previewBtn.addEventListener("click", () => {
			const source = input.value.trim();
			if (!source) {
				setResult("err", [h("div", "", "先填一个来源")]);
				return;
			}
			state.conflictOk = false;
			previewBtn.disabled = true;
			send({ action: "skill-import:preview", source, scopeId: state.scopeId });
			setTimeout(() => {
				previewBtn.disabled = false;
			}, 800);
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") previewBtn.click();
		});
		refresh.addEventListener("click", () => {
			send({ action: "skill-import:probe" });
			send({ action: "skill-import:list" });
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
		recBtn.addEventListener("click", () => {
			recBtn.disabled = true;
			recBtn.textContent = "索引中…";
			// 没有索引 → 建；已有索引 → 重建（都会走网络，响应回来再恢复按钮）
			send({ action: "skill-import:recommend", force: Boolean(state.recommend) });
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
		healthBtn.addEventListener("click", () => {
			healthBtn.disabled = true;
			healthBtn.textContent = "检查中…";
			send({ action: "skill-import:health" });
			setTimeout(() => {
				healthBtn.disabled = false;
				healthBtn.textContent = "健康检查";
			}, 1500);
		});

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
