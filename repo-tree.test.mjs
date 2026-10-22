import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { readZip } = require("./core/zip.cjs");
const { buildZip, SKILL_MD } = require("./test-helpers.mjs");
const { listRepoTree, fetchSkillDocs, fetchSubtree, fetchSourceDocs } = require("./server/repo-tree.cjs");
const { resolvePack } = require("./server/fetch.cjs");

const TREE = [
	{ type: "blob", path: "skills/demo/SKILL.md", size: 300 },
	{ type: "blob", path: "skills/demo/scripts/run.sh", size: 20 },
	{ type: "blob", path: "skills/other/SKILL.md", size: 300 },
	{ type: "blob", path: "data/big.bin", size: 50 * 1024 * 1024 },
];

const RAW = {
	"skills/demo/SKILL.md": SKILL_MD,
	"skills/demo/scripts/run.sh": "#!/bin/sh\n",
	"skills/other/SKILL.md": "---\nname: other\ndescription: 另一个技能，当需要别的能力时使用。\n---\n",
};

/** 可切换 zip 大小 / zip 是否可用的假 http。 */
function makeHttp({ zipBuffer = null, zipBytes = 0, headError = null } = {}) {
	const calls = [];
	return {
		calls,
		head: async (url) => {
			calls.push(["HEAD", url]);
			if (headError) return { ok: false, error: headError };
			return { ok: true, status: 200, contentLength: zipBytes };
		},
		get: async (url) => {
			calls.push(["GET", url]);
			if (url.includes("api.github.com")) {
				return { ok: true, buffer: Buffer.from(JSON.stringify({ tree: TREE, truncated: false })) };
			}
			if (url.includes("raw.githubusercontent.com")) {
				const hit = Object.keys(RAW).find((p) => url.endsWith(`/${p}`));
				return hit ? { ok: true, buffer: Buffer.from(RAW[hit]) } : { ok: false, error: "HTTP 404 Not Found" };
			}
			if (url.includes("codeload")) {
				return zipBuffer ? { ok: true, buffer: zipBuffer } : { ok: false, error: "HTTP 404 Not Found" };
			}
			return { ok: false, error: "unexpected url" };
		},
	};
}

describe("zip 只解压需要的文件", () => {
	it("filter 在解压前生效，大文件不会被 inflate", () => {
		const zip = buildZip([
			{ name: "repo-main/skills/demo/SKILL.md", data: SKILL_MD },
			{ name: "repo-main/data/huge.bin", data: Buffer.alloc(2 * 1024 * 1024, 7) },
		]);
		const full = readZip(zip);
		assert.equal(full.ok, true);
		assert.equal(full.files.size, 2);

		const only = readZip(zip, { filter: (n) => /SKILL\.md$/.test(n), maxTotalBytes: 64 * 1024 });
		assert.equal(only.ok, true, only.error);
		assert.deepEqual([...only.files.keys()], ["repo-main/skills/demo/SKILL.md"]);
		assert.ok(only.filtered >= 1);
	});
});

describe("tree API 通道", () => {
	it("token 只发给 api.github.com，不带去 raw", async () => {
		const calls = [];
		const http = {
			get: async (url, opts) => {
				calls.push([url, opts?.headers?.Authorization ?? ""]);
				if (url.includes("api.github.com")) {
					return { ok: true, buffer: Buffer.from(JSON.stringify({ tree: TREE })) };
				}
				return { ok: true, buffer: Buffer.from(SKILL_MD) };
			},
		};
		await listRepoTree({ owner: "o", repo: "r", ref: "", http, auth: { Authorization: "Bearer ghp_x" } });
		await fetchSkillDocs({ owner: "o", repo: "r", ref: "", http, auth: { Authorization: "Bearer ghp_x" } });
		const apiCalls = calls.filter(([u]) => u.includes("api.github.com"));
		const rawCalls = calls.filter(([u]) => u.includes("raw.githubusercontent.com"));
		assert.ok(apiCalls.length >= 2, "应该有 API 调用");
		assert.ok(apiCalls.every(([, a]) => a === "Bearer ghp_x"), "API 调用要带 token");
		assert.ok(rawCalls.length > 0, "应该拉 raw");
		assert.ok(rawCalls.every(([, a]) => a === ""), "raw 不带 token");
	});

	it("列出文件并只拉 SKILL.md", async () => {
		const http = makeHttp();
		const tree = await listRepoTree({ owner: "o", repo: "r", ref: "main", http });
		assert.equal(tree.ok, true);
		assert.equal(tree.paths.length, 4);

		const docs = await fetchSkillDocs({ owner: "o", repo: "r", ref: "main", http });
		assert.equal(docs.ok, true, docs.error);
		assert.deepEqual([...docs.files.keys()].sort(), ["skills/demo/SKILL.md", "skills/other/SKILL.md"]);
	});

	it("按子目录拉整套文件（安装用）", async () => {
		const http = makeHttp();
		const sub = await fetchSubtree({ owner: "o", repo: "r", ref: "main", path: "skills/demo", http });
		assert.equal(sub.ok, true, sub.error);
		assert.deepEqual([...sub.files.keys()].sort(), ["skills/demo/SKILL.md", "skills/demo/scripts/run.sh"]);

		const missing = await fetchSubtree({ owner: "o", repo: "r", ref: "main", path: "nope", http });
		assert.equal(missing.ok, false);
	});

	it("大仓库：zip 太大时自动转 tree", async () => {
		const http = makeHttp({ zipBytes: 300 * 1024 * 1024 });
		const res = await fetchSourceDocs({
			owner: "o",
			repo: "r",
			ref: "",
			http,
			zipCandidates: ["https://codeload.github.com/o/r/zip/HEAD"],
		});
		assert.equal(res.ok, true, res.error);
		assert.equal(res.via, "tree");
		assert.equal(res.files.size, 2);
		assert.ok(!http.calls.some(([m, u]) => m === "GET" && u.includes("codeload")), "探到太大就不该下载 zip");
	});

	it("小仓库走 zip 且剥掉顶层目录", async () => {
		const zip = buildZip([
			{ name: "r-main/skills/demo/SKILL.md", data: SKILL_MD },
			{ name: "r-main/data/big.bin", data: Buffer.alloc(1024, 1) },
		]);
		const http = makeHttp({ zipBuffer: zip, zipBytes: 1024 });
		const res = await fetchSourceDocs({
			owner: "o",
			repo: "r",
			ref: "",
			http,
			zipCandidates: ["https://codeload.github.com/o/r/zip/HEAD"],
		});
		assert.equal(res.ok, true, res.error);
		assert.equal(res.via, "zip");
		assert.deepEqual([...res.files.keys()], ["skills/demo/SKILL.md"], "顶层目录应被剥掉，且只有 SKILL.md");
	});
});

describe("安装时的超大仓库兜底", () => {
	it("zip 太大 + 指定子目录 → 按目录拉取", async () => {
		const http = makeHttp({ zipBytes: 300 * 1024 * 1024 });
		const res = await resolvePack({
			src: { ok: true, kind: "github", owner: "o", repo: "r", ref: "", path: "skills/demo" },
			http,
		});
		assert.equal(res.ok, true, res.error);
		assert.deepEqual([...res.files.keys()].sort(), ["SKILL.md", "scripts/run.sh"]);
		assert.match(res.label, /skills\/demo/);
	});

	it("zip 太大 + 没指定子目录 → 明确报错并提示贴目录", async () => {
		const http = makeHttp({ zipBytes: 300 * 1024 * 1024 });
		const res = await resolvePack({ src: { ok: true, kind: "github", owner: "o", repo: "r", ref: "", path: "" }, http });
		assert.equal(res.ok, false);
		assert.match(res.error, /太大/);
		assert.equal(res.code, "repo-too-large");
	});
});
