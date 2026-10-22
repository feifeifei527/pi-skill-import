/**
 * http —— 插件侧出站下载。
 *
 * 为什么不用 host.net.fetch：它只回前 512KB 文本，装不下 GitHub zipball。
 * 所以这里走进程内 fetch，但**先过一遍与宿主同口径的白名单**：
 *   - manifest.netAllowlist 里的主机（本插件默认 github 系）
 *   - 其余主机交给 host.requestPermission({family:"net"})，用户点过才放行
 * 体积与超时都是硬上限，逐跳重定向重新校验主机（防 SSRF 跳转）。
 */
const { Buffer } = require("node:buffer");

const MAX_REDIRECTS = 4;

function hostAllowedByList(hostname, allowlist) {
	const h = String(hostname ?? "").toLowerCase();
	return allowlist.some((entry) => h === entry || h.endsWith(`.${entry}`));
}

async function readCapped(res, maxBytes) {
	if (!res.body?.getReader) {
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > maxBytes) throw new Error(`响应超过上限（${(buf.length / 1048576).toFixed(1)}MB）`);
		return buf;
	}
	const reader = res.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(`响应超过上限（>${(maxBytes / 1048576).toFixed(1)}MB）`);
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}

/**
 * @param {{host:{requestPermission?:Function}, allowlist?:string[]}} deps
 */
function createHttp(deps) {
	const allowlist = (deps.allowlist ?? []).map((s) => String(s).toLowerCase());

	async function ensureHost(hostname) {
		const h = String(hostname ?? "").toLowerCase();
		if (!h) return false;
		if (hostAllowedByList(h, allowlist)) return true;
		if (typeof deps.host?.requestPermission !== "function") return false;
		return Boolean(await deps.host.requestPermission({ family: "net", hosts: [h] }));
	}

	return {
		allowlist,
		/** 只探大小：codeload 的 zipball 动辄几百 MB，先 HEAD 一下再决定要不要下。 */
		async head(url, opts = {}) {
			let current = String(url ?? "");
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				let u;
				try {
					u = new URL(current);
				} catch {
					return { ok: false, error: `无效 URL：${current}` };
				}
				if (!(await ensureHost(u.hostname))) return { ok: false, error: `主机 ${u.hostname} 未授权` };
				let res;
				try {
					res = await fetch(current, {
						method: "HEAD",
						redirect: "manual",
						signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
					});
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
				if (res.status >= 300 && res.status < 400) {
					const loc = res.headers.get("location");
					if (!loc) return { ok: false, error: `HTTP ${res.status} 但没有 Location` };
					try {
						current = new URL(loc, u).toString();
					} catch {
						return { ok: false, error: `重定向目标无效：${loc}` };
					}
					continue;
				}
				if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
				const len = Number(res.headers.get("content-length") ?? 0);
				return { ok: true, status: res.status, contentLength: Number.isFinite(len) ? len : 0, url: current };
			}
			return { ok: false, error: "重定向过多" };
		},
		/**
		 * @param {string} url
		 * @param {{headers?:Record<string,string>, maxBytes?:number, timeoutMs?:number}} [opts]
		 * @returns {Promise<{ok:true, status:number, buffer:Buffer, contentType:string, url:string} | {ok:false, error:string}>}
		 */
		async get(url, opts = {}) {
			const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
			const timeoutMs = opts.timeoutMs ?? 30_000;
			let current = String(url ?? "");
			let headers = { ...(opts.headers ?? {}) };

			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				let u;
				try {
					u = new URL(current);
				} catch {
					return { ok: false, error: `无效 URL：${current}` };
				}
				if (u.protocol !== "https:" && u.protocol !== "http:") {
					return { ok: false, error: `不支持的协议：${u.protocol}` };
				}
				if (!(await ensureHost(u.hostname))) {
					return { ok: false, error: `主机 ${u.hostname} 未授权（netAllowlist 或用户授权）` };
				}

				let res;
				try {
					res = await fetch(current, {
						headers,
						redirect: "manual",
						signal: AbortSignal.timeout(timeoutMs),
					});
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}

				if (res.status >= 300 && res.status < 400) {
					const loc = res.headers.get("location");
					if (!loc) return { ok: false, error: `HTTP ${res.status} 但没有 Location` };
					let next;
					try {
						next = new URL(loc, u);
					} catch {
						return { ok: false, error: `重定向目标无效：${loc}` };
					}
					if (next.hostname.toLowerCase() !== u.hostname.toLowerCase()) {
						const stripped = {};
						for (const [k, v] of Object.entries(headers)) {
							const key = k.toLowerCase();
							if (key === "authorization" || key === "cookie") continue;
							stripped[k] = v;
						}
						headers = stripped;
					}
					current = next.toString();
					continue;
				}

				if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
				try {
					const buffer = await readCapped(res, maxBytes);
					return {
						ok: true,
						status: res.status,
						buffer,
						contentType: String(res.headers.get("content-type") ?? ""),
						url: current,
					};
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			}
			return { ok: false, error: `重定向超过 ${MAX_REDIRECTS} 跳` };
		},
	};
}

module.exports = { createHttp };
