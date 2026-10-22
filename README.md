# skill-import

[![test](https://github.com/feifeifei527/pi-skill-import/actions/workflows/test.yml/badge.svg)](https://github.com/feifeifei527/pi-skill-import/actions/workflows/test.yml)

pi-web-ui 界面插件：导入、管理和按当前任务推荐 Agent Skills。

- 右侧「技能」tab，与「文件」并列；设置中也有同一页面。
- 页面分「推荐 / 已安装 / 导入」，授权、来源、索引、健康检查收进「高级」。
- 导入 GitHub 仓库、ZIP 直链、本地目录或多行 SKILL.md，先校验和预览冲突，再安装。
- 全局/项目技能可启停、下载、删除；支持来源记录、更新检查、覆盖备份和回滚。
- 推荐保留 **任务理解 → BM25＋查询扩展 → RRF → LLM 精排**，不要求 embedding API。

## 安装与开发

```bash
pi-web-ui install feifeifei527/pi-skill-import
# 本地开发，在仓库目录运行：
pi-web-ui install ./ --force
```

装完到 **设置 → 界面插件 → 重新扫描**（`plugins_reload`）。只刷新浏览器不会
重载已激活的服务端代码。技能安装或启停后，还需要在相关对话中发送 `/reload`。

```bash
node --test *.test.mjs
node eval-recommend.mjs --fixture --check  # 固定库离线回归，不调用模型
node eval-recommend.mjs --list             # 对本机索引列出候选，供人工审阅
```

GitHub Actions 在 Node 22、24 上执行语法检查、全部测试和离线基线。

## 推荐页面

- **需求可编辑**：默认识别当前对话任务；「按这个需求推荐」使用输入的 `q`，
  「用当前对话」取消手动覆盖。反馈、安装、启停后重新计算时保留手动需求。
- **重新推荐 ≠ 更新技能库**：重新推荐只读现有索引，即使缓存过期也不偷偷同步。
  首次需点「建立索引并推荐」；后续在高级中点「更新技能库」同步来源。
- **安装位置可见**：卡片选择项目或全局，显示项目名及完整目标路径。
- **收藏独立**：钉住放进收藏区，不插入任务推荐，也不覆盖模型的空推荐结论。
- **状态不混用**：磁盘启用、停用、等待重载分开显示；停用项提供启用入口。
  磁盘启用不证明当前会话已加载，更不证明依赖可运行。
- **安装有进度、可取消、失败可重试**：装技能要下载仓库，首次通常 20–40 秒，大仓库更久。
  按钮显示已等待秒数，45 秒后提示可能限流；有「取消」，5 分钟超时后自动恢复并说明原因。
  同一仓库的第二个技能复用已下载的整仓包，不再重下。
- **大仓库只拉子目录**：已知要装哪个技能时，按仓库体积直接走 GitHub tree/raw，
  不下载整包，因此不会被 64MB 上限挡住；tree API 不可用时给出可读错误和下一步建议。
- **重载明确**：安装、更新、启停、删除、回滚后提示复制 `/reload`。
  「已重新加载」只是用户确认，不是插件自动验证，且只清当前项目/对话的待办。
- **来源可核查**：展示文档声明的限制、未验证依赖和原文片段；同名来源可先独立预览。
  来源尚未锁定不可变 commit，不把片段展示称为能力验证。
- **大仓库易选择**：导入候选支持搜索和分页；粘贴 SKILL.md 使用多行输入。

### 标签页与项目隔离

页面消息使用宿主传来的发送方 `clientId` 调用 `getActiveConversation({clientId})`，
回复也只发给该客户端。快照没有 `cwd` 时，按相同会话 ID 从宿主会话清单取项目路径。
并发请求使用独立异步上下文；切换对话后丢弃旧请求回包，清掉旧的手动需求和推荐。

### 项目目录怎么确定（每个项目各自对应）

解析逻辑抽在 `client/project-dir.mjs`（纯函数，可单测），按可信度排队：

| 顺序 | 策略 | 可信度 | 失效表现 |
|---|---|---|---|
| 1 | 页面桥 `window.__piWebUiHost.getCwd()` | 高 | 宿主改名 → 自动落到 2 |
| 2 | 页面桥 `listSessions()` 按当前会话 id 匹配 `cwd` | 高 | 无该会话 → 落到 3 |
| 3 | `localStorage["pi-web-last-cwd"]` | 中 | 清过缓存 → 落到 4 |
| 4 | `pi-web-recent-projects` 里的**唯一**候选 | 低 | 多于一个时不采用 |
| 5 | 服务端快照 `cwd`（当前宿主版本不提供） | 低 | — |
| 6 | 用户手填的绝对路径 | 手动 | 优先级最高，覆盖以上 |

`resolve()` 返回 `{path, source, confidence}`，面板会显示目录来源；全部失效时
`diagnose()` 会把每条策略「有值/无」列在提示里，便于宿主升级后一眼定位。

每次请求都会带上解析出的 `projectDir`，服务端只接受绝对路径，并据此提供
「项目 · <目录名>」落点；HTTP 侧同理（`?projectDir=` 或 `body.projectDir`）。

「已安装」页第一张卡固定是项目落点：显示路径、读到几个技能、解析来源
（页面桥 / 本地记录 / 服务端 / 手动），未授权时直接给「授权访问」。
这样即使项目里 0 个技能，也能看出到底有没有读对目录。

如果项目目录还没授权，落点会显示「未授权」+「授权访问」，点一次即可
（`host.fs.requestAccess` 会记住）。认不出项目时只显示全局落点，**不会猜测目录**。
页面下载链接携带 15 分钟有效的随机上下文句柄，避免 HTTP 下载再次读取全局 cwd；
过期时需刷新面板。句柄不缓存对话消息。

无客户端身份的 HTTP/CLI/agent-tool 兼容入口仍使用宿主工作区，不具备页面的标签页定位；
调用这些入口前应确认工作区，不能假设它们自动对应发起对话的项目。

## 推荐链路与能力比较

### 1. 能力卡片

`core/card.cjs` 从 SKILL.md 描述、正文和 compatibility 字段规则提取
`tasks / scenarios / io / limits / deps / source / evidence`，未声明项保留未知。
这是有损规则摘要，不是运行测试，也不是 LLM 认证；安装命令识别不覆盖所有依赖写法。

给精排模型的摘要为各字段保留预算，避免长描述挤掉限制和依赖。
**已装能力读取本机实际 SKILL.md**，不拿索引里任意同名技能的说明替代；读不到时保持未知。
项目出现 Python/Node 清单只说明生态线索，不说明某个包、工具、密钥已经可用。
当前实现没有执行依赖或环境探测。

### 2. 当前任务

从当前对话中找最近一次明确需求；连续「这个呢 → 好的 → 继续」不会把 PPO 任务挤掉。
无关旧主题不混入新任务，手动 `q` 覆盖对话推断。分词保留 `RL / KL / IK` 等技术缩写。
项目特征使用已确认项目的绝对路径读取，不能串到宿主最后切换的项目。

### 3. 混合检索

- BM25：`k1=1.2`、`b=0.75`，name×3、tasks×2、description×1。
- 第二路使用 LLM 扩展的技术检索词；RRF（`k=60`）按名次合并。
- 覆盖率门槛过滤仅撞上通用词的候选；技术词单命中有单独的放宽规则。
- 当文档明确声明 IO 时，读取/提取任务不能仅凭输出格式命中，例如不能把
  “绘图导出 PDF”当成“提取 PDF 表格”。未知 IO 不靠猜测排除。
- 已装和已忽略技能不再作为新安装候选。

### 4. LLM 精排

默认开启 `rerank`。模型看到候选能力卡片，以及与任务相关的已装摘要、磁盘状态、
待重载状态、IO、限制与依赖验证情况；判断相对现有能力能新增什么。

输出 `{"picks":[{"name":"…","reason":"…","added_capability":"…","requirements":[]}]}`。
最多 `topN` 条（默认 3）；`picks: []` 是明确结论，不回落硬凑。模型调用/解析失败才
退回关键词候选，并标记「规则匹配」。候选文档作为不可信引用数据，不应执行其中的指令。

关闭 `rerank` 时零模型调用；开启后每次最多两次（查询扩展和精排），扩展缓存 10 分钟。
实际模型延迟和 token 成本尚未做端到端测量。

### 5. 身份和局限

索引及 RRF 身份使用 `repo + ref + path`，同仓库不同 ref 的缓存也隔离。
近似/规范化同名候选仍在精排前归组，以代表条目做判断；其它来源放进 `variants`，
**没有逐变体完成模型适用性判断**，因此需要预览该来源后再安装。可用 `id` 精确定位安装。

旧 schema 2 卡片可补身份后迁移；GitHub 限流时沿用各源旧条目，避免迁移丢库。
索引同步仍受网络、API 配额和来源文档变化影响，界面应以实际条数和错误为准。
可配置可选 `githubToken`；它只发送给 `api.github.com`，不要提交进仓库。

## 评测范围（不要当成真实推荐质量证明）

`eval/cases.json` 是 **24 条显式技能名标签的回归样例**，固定库有 15 个技能；支持
`expect / mustNot / expectNone / installed / messages`。不再用 `training|pdf` 等宽泛
类别正则计分。评测与服务共用任务、检索、覆盖率和 IO 方向过滤逻辑。

固定库基线：Top1/Top3 标签命中 19/19，无合适 3/3，已装排重 2/2，禁推项 0 次。
这些是小型、已知样例的回归结果，不是独立人工盲测，也不代表真实千条索引的泛化效果。
未列入 `mustNot` 的结果不等于已确认适用；已装测试也不模拟真实会话加载或依赖可用性。

尚未完成：50–100 条人工审阅/留出请求、真实查询扩展和精排质量、逐变体判断、模型成本与
端到端延迟测量。自动交互测试验证消息闭环，不等于已在用户浏览器里完成实测。

## 导入、启停与大仓库

- 来源：`owner/repo[#ref]`、GitHub tree/raw URL、ZIP、目录或 `text:<SKILL.md>`。
- 安装前校验 frontmatter、引用、路径和体积；多技能仓库先选子目录；覆盖前显示 diff。
- `.skill-import.json` 记录来源和安装记录；覆盖保留隐藏备份，可回滚，最多保留两份。
- 暂存/备份提供失败恢复；宿主没有原生 rename，适配器使用复制/删除，**不是跨进程原子事务**。
- 停用通过移动到 `<scope>/.disabled/` 实现，不修改 Pi 的 `disabledSkills` 设置。
  Pi 下次 `/reload` 才重新扫描；删除也不会立即卸载当前会话已加载的技能。
- ZIP 超过 64MB 或已知大仓库走 GitHub tree/raw，只取索引所需 SKILL.md 或安装的子树，
  不为下载整个大仓库提高体积上限。ZIP 只解压命中文件。

## 对话侧入口

`import_skill`：`mode=install|list|check|update|health`，
`source`、`scope=project|global`、`path`、`name`、`overwrite`。
覆盖必须用户明确同意；成功后提示 `/reload`。

```text
/skill-import list
/skill-import check
/skill-import health
/skill-import update <name>
/skill-import anthropics/skills --path skills/pdf --project
/skill-import https://github.com/o/r/tree/main/skills/pdf --global
```

也支持 `--overwrite` 及粘贴 `text:` 内容。显式指定不存在的落点会报错，不会静默改成全局。

## HTTP 与消息

HTTP 前缀 `/plugins-api/skill-import`：

- `GET /probe /list /check-updates /health /sources /discover-sources /feedback /reload`
- `POST /preview /install /rollback /update /set-enabled /remove /sources /feedback /ack-reload`
- `GET /recommend?q=…` 复用索引；`force=1` 显式同步。
- `POST /recommend-install`：`{name?, id?, scopeId}`。
- `GET /download?name=…&scopeId=…&context=…`：ZIP，页面提供上下文句柄。

页面通过 `action: "skill-import:feedback"` 路由反馈，操作放在 `op`：
`ignore / unignore / pin / unpin`。HTTP 可用 `{action:"ignore",name}` 或 `{op:"ignore",name}`。

## 实现与许可证

服务端实现为 `.cjs`，薄入口 `index.mjs` 在激活前清理插件局部 `require.cache`。
这是因为宿主热重载只击穿 ESM 入口缓存，普通 ESM 子模块可能继续使用旧代码。
客户端静态依赖必须在 `client/` 内，因此保留 `sdk/` 和 `client/sdk/` 两份 SDK。

- `server/impl.cjs`：路由与消息；`server/context.cjs`：请求级隔离。
- `server/import-service.cjs`：预览、安装、启停与管理；`server/recommend.cjs`：索引与推荐。
- `core/*.cjs`：校验、任务、卡片、BM25、RRF、覆盖率等纯逻辑。
- `client.test.mjs`：真实 mount 和消息闭环；`context.test.mjs`：并发标签页、下载和失效保护。

MIT，见 [LICENSE](LICENSE)。

`sdk/` 与 `client/sdk/` 是上游 pi-web-ui 的 plugin-sdk 拷贝（MIT，
Copyright (c) 2026 xing-shuyin），随插件分发以便离线安装，保留上游版权和许可说明。
