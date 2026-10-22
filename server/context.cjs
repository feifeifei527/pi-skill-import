/** 请求级上下文：不能用全局 last-active 对话替代发起请求的标签页。 */
const { AsyncLocalStorage } = require("node:async_hooks");
const { isAbsolute } = require("node:path");

function createRequestContext(host) {
	const requests = new AsyncLocalStorage();
	const scopedHost = new Proxy(host, {
		get(target, key) {
			const current = requests.getStore();
			if (key === "cwd" && current) return current.cwd;
			if (key === "getActiveConversation" && current) return () => current.snapshot;
			return Reflect.get(target, key, target);
		},
	});

	async function run(clientId, fn, options = {}) {
		// 页面可以显式指定项目目录：宿主没暴露本标签页的 cwd 时，这比猜一个目录可靠。
		const explicit = typeof options.projectDir === "string" && isAbsolute(options.projectDir.trim()) ? options.projectDir.trim() : "";
		if (!clientId) return fn(); // CLI/HTTP 兼容入口，使用明确的宿主工作区。
		let snapshot = host.getActiveConversation?.({ clientId }) ?? null;
		// 老宿主可能把不存在的 clientId 回落到其它客户端；宁可没有上下文。
		if (snapshot?.clientId && snapshot.clientId !== clientId) snapshot = null;
		let cwd = explicit || (typeof snapshot?.cwd === "string" && isAbsolute(snapshot.cwd) ? snapshot.cwd : "");
		if (!cwd && snapshot?.conversationId) {
			try {
				const list = await host.conversations?.list?.();
				const entries = Array.isArray(list) ? list : [];
				const conversation = entries.find((c) => c.id === snapshot.conversationId);
				if (typeof conversation?.cwd === "string" && isAbsolute(conversation.cwd)) cwd = conversation.cwd;
				if (!cwd) {
					// 宿主不同版本给的项目字段不一样：只记链路形状，不记路径内容。
					host.log?.("debug", "项目目录未解析", {
						conversationId: snapshot.conversationId,
						snapshotKeys: Object.keys(snapshot).join(","),
						listCount: entries.length,
						matched: Boolean(conversation),
						cwdType: conversation ? typeof conversation.cwd : "none",
					});
				}
			} catch (err) {
				// SDK 可能只提供 id/title；无法确认时不暴露项目落点。
				host.log?.("debug", "会话清单不可用", { error: err instanceof Error ? err.message : String(err) });
			}
		}
		return requests.run({ clientId, snapshot, cwd }, fn);
	}

	function isCurrent() {
		const current = requests.getStore();
		if (!current) return true;
		const latest = host.getActiveConversation?.({ clientId: current.clientId }) ?? null;
		return latest?.conversationId === current.snapshot?.conversationId
			&& (!latest?.clientId || latest.clientId === current.clientId);
	}

	return {
		host: scopedHost, run, isCurrent,
		capture: () => {
			const current = requests.getStore() ?? { cwd: host.cwd, snapshot: host.getActiveConversation?.() ?? null };
			// 下载只需要项目和会话身份，不把整段对话留在短期句柄缓存里。
			return { cwd: current.cwd, clientId: current.clientId, snapshot: current.snapshot ? { conversationId: current.snapshot.conversationId, clientId: current.snapshot.clientId } : null };
		},
		withContext: (context, fn) => requests.run(context, fn),
		/** HTTP 路由没有 clientId：允许通过查询参数显式指定项目目录。 */
		withProjectDir: (projectDir, fn) => {
			const current = requests.getStore();
			const explicit = typeof projectDir === "string" && isAbsolute(projectDir.trim()) ? projectDir.trim() : "";
			const dir = explicit || current?.cwd || host.cwd || "";
			return requests.run({ clientId: current?.clientId, snapshot: current?.snapshot ?? null, cwd: dir }, fn);
		},
	};
}

module.exports = { createRequestContext };
