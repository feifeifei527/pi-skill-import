/**
 * skill-import —— 宿主入口（ESM，必须保持极薄）。
 *
 * 宿主 plugins_reload 会给本文件加 `?e=N` 击穿 ESM 缓存，但**子模块不会**。
 * 所以真正的实现放在 CJS 里，每次 activate 前清掉本目录的 require.cache，
 * 这样「装新版本 → 重新扫描」就能拿到新代码，不用重启 pi-web-ui。
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { definePlugin } from "./sdk/index.mjs";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = fileURLToPath(new URL("./", import.meta.url));

function loadFresh(rel) {
	for (const key of Object.keys(require.cache)) {
		if (key.startsWith(PLUGIN_DIR)) delete require.cache[key];
	}
	return require(`./${rel}`);
}

export default definePlugin({
	activate(host) {
		return loadFresh("server/impl.cjs").activate(host);
	},
});
