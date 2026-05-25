# TeamRadar

选择，看见团队。

## 技术栈

- Deno HTTP Server
- Deno KV：团队聚合、影子缓冲、标签索引、搜索缓存
- DeepSeek API / 本地 Ollama：自由文本脱敏、结构化六维打分
- 公开事件采集 Agent：从官方博客、RSS、公开新闻页收集候选重大事件
- 原生 Web Components：雷达图、匿名评价卡片、贡献弹窗

## 本地运行

```bash
deno task seed
deno task seed:known
deno task dev
```

打开 `http://localhost:8000`。

如需真实调用 DeepSeek：

```bash
export LLM_PROVIDER=deepseek
export DEEPSEEK_API_KEY="sk-..."
deno task dev
```

如需使用本地 Ollama 测试 `gemma4`：

```bash
ollama pull gemma4
ollama serve
```

另开一个终端：

```bash
export LLM_PROVIDER=ollama
export OLLAMA_MODEL=gemma4
export OLLAMA_ENDPOINT=http://localhost:11434/api/chat
export REVIEW_MIN_DELAY_DAYS=0
export REVIEW_MAX_DELAY_DAYS=0
deno task dev
```

如果你的本地模型名称不是 `gemma4`，用 `ollama list` 查看实际名称，并把 `OLLAMA_MODEL` 改成对应值。

没有 API Key 或 Ollama 时，可用显式 Mock 模式体验完整流程：

```bash
export LLM_MOCK=1
export REVIEW_MIN_DELAY_DAYS=0
export REVIEW_MAX_DELAY_DAYS=0
deno task dev
```

提交评价后，如需立刻处理到公开聚合，可调用：

```bash
curl -X POST http://localhost:8000/api/v1/process-due
```

公开事件采集 Agent 可单独运行：

```bash
deno task collect:events
```

采集后同步运行独立管理员 Agent：

```bash
deno task collect:agent
```

也可以在服务启动时启用定时采集，每 6 小时运行一次：

```bash
export PUBLIC_EVENT_COLLECTOR_CRON=1
deno task dev
```

如需启用无人类参与的独立管理员 Agent 确认和发布：

```bash
export PUBLIC_EVENT_COLLECTOR_CRON=1
export PUBLIC_EVENT_ADMIN_AGENT=1
export PUBLIC_EVENT_ADMIN_AGENT_THRESHOLD=0.88
export PUBLIC_EVENT_AGENT_STALE_DAYS=14
deno task dev
```

管理员 Agent
只会处理命中已知团队、来源允许自动确认、事件类型明确且置信分达到阈值的候选；证据不足的候选进入
`needs_evidence`，长期不足或不可确认的候选进入 `agent_dismissed`，不需要人类管理员参与。

公开来源配置在 `data/public_sources.json`，当前包含 Deno、GitHub、Cloudflare、Google
Cloud、AWS、Azure、OpenAI、Anthropic、ByteDance、CNCF
等公开来源，并为每个来源配置可信等级、域名白名单和自动确认开关。

知名团队清单配置在 `data/known_teams.json`，可通过以下命令批量创建 shadow 团队和定向投稿路径：

```bash
deno task seed:known
```

采集候选事件会自动尝试匹配这些知名团队，并在候选记录里给出
`suggested_team_id`、`suggested_team_label` 和 `match_confidence`。

生产环境建议设置：

```bash
export DEEPSEEK_API_KEY="sk-..."
export EMAIL_HASH_SALT="a-long-random-secret"
export AGENT_TOKEN="another-random-secret"
```

设置 `AGENT_TOKEN` 后，采集、队列处理和事件写入接口只允许 Agent 调用：

```bash
curl -X POST http://localhost:8000/api/v1/process-due \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

服务默认以公司内部版本运行，且内部访问默认不需要令牌：

```bash
export AGENT_TOKEN="agent-write-token"
export TEAMRADAR_EVENT_SOURCE_FILE=data/sources.example.json
export PUBLIC_EVENT_COLLECTOR_CRON=1
export PUBLIC_EVENT_ADMIN_AGENT=1
deno task dev
```

如需切换为内部令牌访问模式：

```bash
export INTERNAL_ACCESS_MODE=token
export INTERNAL_ACCESS_TOKEN="internal-read-token"
```

令牌模式会对除 `/api/health` 外的所有页面和 API 启用 `INTERNAL_ACCESS_TOKEN` 访问保护；浏览器可通过
`/?access_token=$INTERNAL_ACCESS_TOKEN` 首次进入并写入内部访问 Cookie，程序化访问也可使用
`Authorization: Bearer $INTERNAL_ACCESS_TOKEN` 或 `x-internal-access-token`。Agent 写接口继续使用
`AGENT_TOKEN`。如需公开版，显式设置 `TEAMRADAR_EDITION=public`。

## API

### `POST /api/v1/reviews`

提交匿名评价，服务端调用 DeepSeek 后只保存脱敏结构化结果。公开版使用 `group_name`，公司内部版使用
`group_name` 表示事业群。

```json
{
  "group_name": "Tencent",
  "dept_path": "云产品 / 开发者体验",
  "email": "user@example.com",
  "raw_content": "这里填写管理风格评价，不要包含真实姓名、手机号、微信号或具体项目机密。"
}
```

内部版示例：

```json
{
  "group_name": "TRADAR",
  "dept_path": "云产品 / 开发者体验",
  "email": "user@example.com",
  "raw_content": "这里填写管理风格评价，不要包含真实姓名、手机号、微信号或具体项目机密。"
}
```

### `GET /api/v1/teams?q=技术导向`

搜索已达到 `N>=3` 安全阈值的团队。

### `GET /api/v1/teams/:id/timeline`

查看团队公开状态的历史时间线。公开时间线按 weekly bucket 展示（例如
`2026-W20`），每个时间点包含当时的雷达图快照、标签、摘要和样本量，可用于前端切换查看过往状态。

### `GET /api/v1/teams/:id/events`

查看导致团队状态发生重大变化的事件记录。事件只来自公开报道、官方公告、公开产品/组织说明等渠道，不从匿名样本总结生成。事件时间点支持
`YYYY-MM`、`YYYY-Www` 或 `YYYY-MM-DD`；建议优先使用月/周粒度，避免过细时间造成反向推断。

### `POST /api/v1/collector/run?admin_agent=1`

Agent 触发公开事件采集，抓取 `data/public_sources.json` 或 `TEAMRADAR_EVENT_SOURCE_FILE`
中配置的来源并写入候选队列。传入 `admin_agent=1` 或设置 `PUBLIC_EVENT_ADMIN_AGENT=1`
后，会在采集后运行独立管理员 Agent。

### `POST /api/v1/collector/admin-agent?threshold=0.88&stale_days=14`

Agent 单独触发管理员 Agent
决策流程。系统会根据来源可信度、已知团队匹配、事件类型、域名白名单、时效性和同事件证据数计算置信分；达到阈值的候选会写入团队重大事件，证据不足进入
`needs_evidence`，长期不足或不可确认进入 `agent_dismissed`。

### `GET /api/v1/collector/candidates?status=candidate`

Agent 查看候选事件。`status` 支持
`candidate`、`needs_evidence`、`agent_confirmed`、`agent_dismissed`、`needs_review`、`auto_confirmed`、`confirmed`、`dismissed`
和 `all`。

### `POST /api/v1/teams/:id/events`

Agent 录入公开来源重大影响事件，需要 `AGENT_TOKEN`。请求体示例：

```json
{
  "occurred_at": "2026-W20",
  "brief": "公开报道显示该团队进入长期维护阶段，工作节奏明显趋稳。",
  "source_title": "公开组织调整说明",
  "source_url": "https://example.com/public-source"
}
```

### `POST /api/v1/access-grant`

写入 7 天互惠解锁权益，只保存邮箱哈希。

```json
{ "email": "user@example.com" }
```

## 隐私边界

- 原始文本只进入内存中的 LLM 清洗流程，不写入 Deno KV。
- 团队样本量小于 3 时保持 `shadow`，不公开雷达图和摘要。
- 公开分数基于聚合均值并注入轻量差分隐私噪音。
- 公开团队状态时间线按周聚合展示；重大事件建议使用月/周粒度，必要时才使用日粒度。
- 重大影响事件只从公开/内网配置来源候选或 Agent 录入的来源记录产生，不从匿名样本自动归纳。
- 管理员 Agent 会保存来源、置信分、事件指纹和确认原因；同一团队同一事件指纹只发布一次。
- 邮箱仅保存 `SHA256(email + salt)`，不与评价记录关联。
