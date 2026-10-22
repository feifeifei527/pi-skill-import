# skill-import

pi-web-ui 界面插件：快捷导入、管理、推荐 Agent Skills。

- 右侧「技能」tab：全局/项目技能列表、启停、下载、删除
- 导入：GitHub 仓库 / zip 直链 / 本地目录 / 粘贴 SKILL.md，落盘前校验、冲突 diff
- 推荐：任务理解 → BM25 + 查询扩展 → RRF → 大模型精排（判断能否补上已有能力）
- 索引：7+ 个技能库、1000+ 条，按仓库 `pushed_at` 缓存；超大仓库走 tree API

## 安装

```bash
pi-web-ui install feifeifei527/pi-skill-import
# 或本地开发：pi-web-ui install ./ --force
```

装完在页面里 **设置 → 界面插件 → 重新扫描**（等价于发一条 `plugins_reload`），
只刷新浏览器不会重载已激活的插件。

## 开发

```bash
node --test core.test.mjs server.test.mjs recommend.test.mjs repo-tree.test.mjs pipeline.test.mjs index.test.mjs
node eval-recommend.mjs        # 推荐效果基线（离线，不调模型）
```

改完装到运行时：

```bash
pi-web-ui install ./ --force
```

> 服务端实现是 `.cjs`、入口是极薄的 `index.mjs`：宿主 `plugins_reload` 只给入口
> 加 `?e=N` 击穿缓存，ESM 子模块不会失效；`index.mjs` 每次 activate 前清
> `require.cache`，所以「装新版本 → 重新扫描」是真生效，不用重启。

## 自检

```bash
curl -s http://127.0.0.1:8788/plugins-api/skill-import/probe | python3 -m json.tool
```

## 结构

- `manifest.json` — 声明 `settings.pages` 页面（也自带顶栏 tab），权限 `ui` / `fs` / `http`
- `index.mjs` — 服务端：`activate()` 订阅 `onMessage`、挂 `GET /probe`、跟 `onCwdChange`
- `client/entry.mjs` — 页面视图：探测四类技能落点 + 授权按钮
- `sdk/`、`client/sdk/` — plugin-sdk 拷贝（客户端侧必须在 `client/` 内）

## 进度

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 骨架 + 落点探测 + 授权可视化 | ✅ |
| 2 | 核心模块：URL 解析 / zip 解包 / 校验 / 冲突 / 原子写 | ✅ |
| 3 | 路由 + 页面接通（preview / install / list / rollback） | ✅ |
| 4 | 接入 pi 对话：`import_skill` agent tool + slash command | ✅ |
| 5 | 冲突 diff / 更新检查 / 健康检查 | ✅ |
| 6 | 启停 / 删除 / 下载 + 文件列表旁的「技能」tab | ✅ |
| 7 | 按「你做的事」推荐技能（规则 + 可选 LLM 重排） | ✅ |
| 8 | 多源索引（7 个库 / 1066 技能）+ 发现更多库 + 市场缓存建议 | ✅ |

## core/ 模块

| 文件 | 职责 |
|---|---|
| `source.mjs` | 把粘贴内容识别成 GitHub / zip / 直链 / 本地路径 / 文本，产出 raw 候选地址 |
| `zip.mjs` | 零依赖 zip 读取（store + deflate），防 zip-slip、限体积、剥顶层目录 |
| `frontmatter.mjs` | SKILL.md 头部 YAML 子集解析 + 规范校验（name/description） |
| `inspect.mjs` | 定位 SKILL.md、引用完整性、体积/可疑文件、汇总 issues |
| `conflicts.mjs` | 同名技能在四个落点里的分布与 shadow 关系 |
| `install.mjs` | staging → 备份 → 改名的原子安装，失败回滚（写操作走注入的 ops） |

验证基线：`node --test` 34 个用例；用 anthropics/skills 全仓 20 个技能实测
17 个零告警，2 条真实告警（一个 description 1068 字符超规范、一个 5.3MB），
其余为误报已修（subscript/superscript、URL 路径、域名开头链接文字）。

## 架构：入口薄、实现走 CJS（重要）

宿主 `plugins_reload` 只给入口 `index.mjs` 加 `?e=N` 击穿 ESM 缓存，
**ESM 子模块的缓存永不失效**（同进程里改完仍是旧代码，实测确认）。
所以服务端实现全部是 `.cjs`，`index.mjs` 每次 `activate` 前清掉本目录的
`require.cache`，再 require 实现——装新版本 → 重新扫描即可生效，不用重启服务。

- `index.mjs` — 仅 20 行：清缓存 + require `server/impl.cjs`
- `server/impl.cjs` — activate / probe / 路由 / 消息分发
- `server/*.cjs` — http 下载、host.fs 适配、预览安装服务
- `core/*.cjs` — 纯逻辑（source/zip/frontmatter/inspect/conflicts/install/diff）
- `server/*.cjs` — http 下载、host.fs 适配、fs-pack、预览安装/更新/健康检查、agent-bridge
- `server.test.mjs` / `core.test.mjs` / `index.test.mjs` — 70 个用例

## 对话侧入口

**agent tool `import_skill`**（manifest 需要 `tools` 能力）

```
mode      install（默认）| list | check | update | health
source    owner/repo | GitHub URL | zip 直链 | 本地路径 | text:<SKILL.md>
scope     global | project（默认 project）
path      仓库里多个技能时指定子目录
name      mode=update 时的技能名
overwrite 覆盖同名（必须用户明确同意；会留备份）
```

返回结构化文本：装好 → 提示用户 `/reload`；多个技能 → 候选列表；同名 → 要求
`overwrite: true`；校验失败 → 逐条错误。

**斜杠命令 `/skill-import`**

```
/skill-import list | check | health | update <name>  # 管理
/skill-import anthropics/skills                     # 列出候选
/skill-import https://github.com/o/r/tree/main/skills/pdf --project
/skill-import text:---
name: my-skill
description: 当……时使用
---
...                                                 # 直接装粘贴内容
/skill-import list                                  # 已装清单（* = 本插件导入）
```

开关：`--global` / `--project` / `--path <dir>` / `--overwrite`。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plugins-api/skill-import/probe` | 四个落点 + 授权状态 |
| POST | `/preview` | `{source}` 或 `{token,path}` → 校验结果、候选、冲突 |
| POST | `/install` | `{token,path,scopeId,overwrite}` → 原子落盘 |
| POST | `/rollback` | `{id}` → 还原备份 |
| GET | `/list` | 已装技能（是否本插件导入、可回滚） |
| GET | `/check-updates` | 按记录来源重拉，与磁盘内容哈希对比 |
| POST | `/update` | `{name, scopeId}` → 按来源更新（留备份） |
| GET | `/health` | 全部技能校验 + 跨作用域重名 shadow |
| POST | `/set-enabled` | `{name, scopeId, enabled}` → 搬进/搬出 `.disabled/` |
| POST | `/remove` | `{name, scopeId}` → 删除技能（只认作用域里列出的名字） |
| GET | `/download` | `?name=&scopeId=` → zip（store/deflate 自适应） |
| GET | `/recommend` | `?force=1` 重建索引；否则走 24h 缓存 |
| POST | `/recommend-install` | `{name, scopeId}` → 从索引还原来源并安装 |

## 覆盖 / 更新 / 健康

- **覆盖前看 diff**：目标已有同名时，预览与安装都会回 `{added, changed, removed, unchanged}`（按内容哈希，不看 mtime），页面直接列出来；确认后才覆盖，旧版进 `.skill-import.json` 同级隐藏备份。
- **更新检查**：按 `.skill-import.json` 记的 `sourceMeta` 重新拉取（同一仓库只下一次 zipball），哈希对比；`text:` 来源标记 `no-source`。registry 里指向已删除目录的记录会自动清理。
- **健康检查**：扫描所有可读落点，跑同一套 `inspectPack`——断链引用、规范违规、跨作用域重名 shadow。
- 每个技能最多保留 2 份备份；备份/暂存目录点开头，Pi 的扫描会跳过。

## 启停 / 删除 / 下载

- **启停**走文件级：停用 = 把 `<scope>/<name>/`（或 `<name>.md`）搬进 `<scope>/.disabled/`。
  Pi 的扫描跳过点开头条目，所以停用后 `resourceLoader` 里就没了；启用再搬回来。
  不动 Pi 的 `disabledSkills` 设置，两个机制互不打架。
- **删除**：只接受当前作用域里列出的技能名（防路径穿越），删完顺手清 registry。
- **下载**：`core/zip-write.cjs` 零依赖打包，逐个文件选 deflate/store 更小的那个；
  停用状态的技能也能下。
- UI：右侧面板 `rightpanel.tabs` 新增「技能」tab，和「文件」并列；未授权作用域只展示、不给启停/删除按钮。

## 推荐：任务理解 → 混合检索 → 大模型精排 → 去重

链路在 `server/recommend.cjs`，纯逻辑在 `core/{task,card,bm25,rrf}.cjs`。

**1. 能力卡片**（`core/card.cjs`，索引用 `entriesFromTree` 生成）
每个技能带 `tasks / scenarios / io / limits / deps / source`；规则没提到的字段进
`unknown`，不编造。卡片只在建索引时生成，随索引缓存。

**2. 任务理解**（`core/task.cjs`）
只取**最近 3 条用户消息** + 当前项目特征（依赖、扩展名、README 标题），抽
`task / keywords / capabilities`；长期偏好不参与。

**3. 混合检索**
- 路 A：BM25（k1=1.2, b=0.75，name×3 / tasks×2 / description×1）跑原始关键词
- 路 B：LLM 把口语需求扩成技术词（“训练崩了” → PPO / reward / KL / Stable-Baselines3），
  再跑一路 BM25
- **RRF**（k=60）按名次合并，取 30 → 去重（同 repo 近似名 / Jaccard≥0.8）→ 20
- 覆盖率兜底：查询词一个都撞不上或覆盖率 <10% → 不算候选

**4. 大模型精排**（`rerank` 设置，默认开）
模型只看候选卡片 + 已装技能，回答：能覆盖哪些步骤、已装是否覆盖、
新增什么能力、需要什么前提。输出
`{"picks":[{"name","reason","added_capability","requirements"}]}`；
`picks: []` 是**明确结论**（库里没有合适的），不会回落硬凑；
调用/解析失败才回落到关键词结果（带「规则匹配」标记）。

**5. 去重与出口**
最多 `topN`（默认 3）条；已装但命中的技能单独返回 `installedHits`，
UI 显示「已装可直接用」。

**评测基线**（`node eval-recommend.mjs`，离线、不调模型）
10 条真实需求 + 2 条「库里没有」：Recall@20 10/10、Top3 10/10、无合适判定 2/2，
规则部分平均 0.4ms/次。

**成本**：每次推荐 2 次模型调用（查询扩展 + 精排，扩展结果缓存 10 分钟），
约 2–3k token；关闭 `rerank` 则零调用。索引元信息 6h 内不重复问 GitHub；
配额 60/h，可在设置里填 `githubToken` 提到 5000/h。

## 大仓库：不下载整包，只取需要的文件

`readZip(buf, { filter })` 在**解压前**按文件名过滤，只 inflate 命中的条目。
仓库 zipball 超过 64MB 时不再硬下，改走 GitHub tree API：

- 索引用 `fetchSkillDocs`：tree 一次拿路径，只并发拉所有 `SKILL.md`
- 安装用 `fetchSubtree`：只拉目标技能子目录下的文件
- K-Dense（zip 235MB / 解压 277MB）实测：177 个技能，单源 8.4s，
  进程峰值内存只涨了约 139MB（594MB → 733MB）；如果按「提上限 + 全量解压」，
  峰值会是 500MB+。

## 已知约束

- 插件拿不到会话重载接口：装完技能要用户自己 `/reload`（或等下次会话）。
- 写 `~/.pi/agent/skills` 需要 `host.fs.requestAccess`（用户点过才有），写项目内
  `<cwd>/.pi/skills` 免授权。
- `host.cwd` 是服务端全局值（跟随最后一次切目录），不是每个客户端独立。
- `host.net.fetch` 只回 512KB 文本，装不下 zipball，所以 `server/http.cjs` 走
  进程内 fetch，但先过 `manifest.netAllowlist` / `host.requestPermission` 同口径校验。
- 备份/暂存目录用 `.` 开头（Pi 的扫描会跳过点开头条目），每个技能只留最近 2 份备份。
