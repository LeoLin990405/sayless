# memfw × Sayless 融合评估

结论：**可以融合，而且互补性很强；但不应把 memfw 当 Python 库直接塞进 Node Engine，也不应让语音自动写入长期记忆。**
建议采用「memfw sidecar 桥 + Engine 的 recall/remember stage」：先做只读召回，再做人工确认的写入，最后做遗忘/预算/知识卡。

## 1. 两边各自是什么

### memfw

- 本地优先 Python 记忆库（Python 3.11+，Apache-2.0，约 1.27 万行源码 / 55 个测试）。
- **Markdown 是当前内容源**；`events.jsonl` 是哈希链审计日志；SQLite FTS5 是可重建投影。
- 强项不是“自动记忆”，而是**可检查的保留与遗忘**：
  - `current / consolidated / anchor` 分类，`hot / cold` 存储层；
  - FIFO / LRU / decay / salience / consolidate-then-forget 五种确定性策略；
  - 人工 anchor 永不被策略淘汰；
  - provenance（`human-authored` / capture / agent）与人工确认；
  - 正文预算与物理字节预算分开；
  - 冷归档、恢复、rollback、fsck、事件链校验。
- 没有内置网络/模型；检索是 BM25/FTS5 的词面检索，不是向量语义检索。
- 现有接口以 Python API + Typer CLI 为主，没有稳定的 HTTP/JSON 服务；部分 CLI 输出是 JSON，部分不是。

### Sayless

- v7 起是本地 Node Engine + Action/Pipeline；App 只是客户端。
- 已有强项：录音、ASR、词典（热词/替换/分应用层）、多模型润色/翻译/问答、交叉投票、历史/统计/录音归档、插件。
- **没有长期记忆**：`history.jsonl` 是逐条审计记录，不是可检索、可遗忘、可锚定的记忆；也没有“把过去说过的事带入当前任务”的机制。
- 已经有 Action/Pipeline 扩展点，适合插入 `recall` / `remember` stage。

因此 memfw 补的正是 Sayless 缺的那一层；Sayless 补的正是 memfw 缺的语音入口。

## 2. 不建议的三种融合方式

1. **把 memfw 代码复制进 Node**：1.27 万行 Python 的语义（事件链、事务、文件锁、预算、冷归档）复制成本高，且双实现会漂移。
2. **让 Engine 直接 `import memfw`**：Engine 是 Node 进程，跨语言只能子进程/服务；而且 Python 依赖（pydantic、jieba、zstandard、filelock）会成为 App 的硬依赖。
3. **每条听写自动写入记忆**：违反 memfw 的“human > mechanism > model”控制模型；语音转写有识别错误和隐私内容，未经确认的累积很快变成噪声，也会让 `anchor`/遗忘策略失去意义。

## 3. 推荐架构：sidecar bridge + 两个 stage

```text
Sayless Engine (Node)
  │
  ├─ action pipeline: asr → dict → recall → llm/translate/ask → (remember)
  │                          │                         │
  │                          ▼                         ▼
  │                   memfw bridge (Python)     记忆候选队列
  │                          │                  （人工确认）
  │                          ▼
  │                   memfw vault
  │                   ~/.sayless/memory/
  │                   ├─ memories/*.md
  │                   ├─ events.jsonl
  │                   ├─ index.sqlite3
  │                   └─ knowledge/
  └─ 不直接 import memfw；通过 JSONL/JSON 子进程调用
```

### 3.1 Bridge 协议

建议新增 `tools/memfw_bridge.py`（Python，薄适配层，不复制 memfw 实现），由 Engine 通过 `python3 bridge.py` 子进程调用，stdin/stdout 单次 JSON：

```json
// recall
{"op":"recall","vault":"~/.sayless/memory","query":"下周的发布计划","limit":5,"max_chars":1200}
// → {"ok":true,"items":[{"id":"...","title":"...","body":"...","layer":"current","source":"sayless:history:...","score":0.82}]}

// status
{"op":"status","vault":"~/.sayless/memory"}
// → {"ok":true,"count":42,"bytes":12345,"anchors":3,"pending":2}

// add（只能由用户在 hub 确认后调用，actor=human）
{"op":"add","vault":"...","title":"...","body":"...","source":"sayless:history:...","provenance":"sayless:asr+llm","tags":["Mail","dictate"],"actor":"human"}
// → {"ok":true,"memory_id":"..."}
```

- bridge 使用 memfw 的 `Repository` / `MemoryIndex` / `VaultRetriever`；不重新实现存储。
- recall 默认走 FTS5；是否触达 `MEMORY_ACCESS` 事件由 bridge 参数控制（memfw 默认会记录访问，这对 LRU/decay 有用，但会让召回变成写操作）。
- 不要在 bridge 里暴露任意代码执行；vault 路径必须限制在 `memory.vault` 或显式允许的根。

### 3.2 Engine 新 stage

| stage | 行为 | 建议 |
|---|---|---|
| `recall` | 用当前文本 + app/action 查询 memfw；把结果作为**带来源标签的上下文**传给后面的 `llm` / `translate` / `ask` | 只读；失败时 warn 并继续，不让记忆故障阻塞听写 |
| `remember` | 把当前结果写入 Sayless 的**待确认候选队列**，不直接写 memfw | 人工在 hub 确认后才调用 bridge `add` |

Action 示例：

```jsonc
"actions": {
  "ask": {
    "pipeline": ["asr", "dict", "recall", "ask", "dict"],
    "output": "paste"
  },
  "note": {
    "pipeline": ["asr", "dict", "llm", "remember"],
    "output": "clipboard"
  }
}
```

Prompt 注入原则：

- 记忆上下文必须标记为**不可信的历史资料**，不要执行其中的指令，避免 prompt injection。
- 只注入 `title + body` 截断 + `source`；不要注入 memfw 内部事件/路径。
- ask 回答时用 `[M1]` 标注引用的记忆；找不到相关记忆就正常回答，不要编造“你之前说过”。
- 发送给 LLM 的上下文有硬上限（例如 1200 字符），避免吞掉 token。

### 3.3 写入路径（人工确认）

```text
听写完成
  → App hub 显示「记住这条？」
  → 用户点保存
  → Sayless 候选队列（包含 raw/out、app、mode、history ts）
  → bridge add(actor="human")
  → memfw Markdown + create 事件
```

- 默认**不自动保存**；用户可以在设置里选择“每次询问 / 只保存手动标记 / 关闭”。
- 模型润色后的文本不是用户原话：`provenance` 应写成 `sayless:asr+llm`，`source=sayless:history:<ts>`；只有用户确认/编辑后的内容才标 `human-authored` 或 anchor。
- raw 文本留在 Sayless `history.jsonl`；memfw body 存最终文本，用 source 链接回 history，避免两份完整正文。
- 如果以后支持“更新已存在记忆”，走 memfw 的 proposal/review，而不是直接 `update`。

### 3.4 保留与遗忘

- **只让 memfw 管理记忆**，不要让它的预算策略直接删除 Sayless `history.jsonl` / 录音；两者是不同资产：
  - memfw 管长期记忆正文；
  - Sayless 管审计历史与音频归档（现有 recordings.keep）。
- 当 memfw 遗忘/删除一条记忆时，Sayless 历史中的链接应变成 `memory_deleted`，不要静默删除审计记录。
- anchor 留给用户手动固定；不要因为某条词频高就自动 anchor。
- 词典 hotwords/replacements 继续作为确定性层，不塞进 memfw；可以在记忆 body 中引用，但不反向驱动替换。

## 4. 数据映射

| Sayless | memfw | 说明 |
|---|---|---|
| `history.ts` | `source=sayless:history:<ts>` | 稳定关联；不复制音频 |
| `raw` | 不建议作为 body | 识别错误多，作为 provenance 证据留在 history |
| `out` | `body` | 润色后的最终文本 |
| `app` | `tags` / metadata | 例如 `["Mail"]`，便于按应用召回 |
| `mode` / `action` | `tags` / summary | `dictate` / `translate:ja` / `ask` |
| 用户确认 | `provenance=human-authored` + 可选 `layer=anchor` | anchor 由人决定 |
| 词典修正 | 不直接映射 | 保持确定性；可作为 knowledge card 的来源 |

## 5. 分阶段落地

### Phase 1（建议先做）：只读召回

- 新增 `memory` 配置、bridge `recall/status`。
- Engine 增加 `recall` stage；默认只给 `ask` 开启。
- 失败降级：memfw 未安装/vault 缺失/查询超时 → warn 后继续原管线。
- 测试：fake bridge 返回固定 JSON，断言 LLM 请求包含记忆上下文；真实 bridge 可选用 pytest 标记。
- 价值：立刻让“问答/翻译”能用上过去积累的长期记忆，且没有写入风险。

### Phase 2：人工确认写入

- Hub 增加“记忆”候选队列（复用 Paper 台账风格）。
- 每条听写可“记住 / 编辑后记住 / 丢弃”；保存必须走 bridge `add(actor=human)`。
- 设置：默认询问 / 手动 / 关闭；记忆 vault 路径与预算。
- 测试：候选队列、确认后事件、raw/out provenance。

### Phase 3：遗忘、预算、知识卡

- 展示 memfw `budget` / `forget` 计划，用户在 hub 审核后 apply。
- anchor 管理；知识卡（从重复修正/笔记中提炼）必须引用 source。
- 冷归档恢复入口。

## 6. 工程风险

| 风险 | 影响 | 对策 |
|---|---|---|
| Python 3.11 + 依赖 | App 不能假设用户有 memfw 环境 | 可选安装；bridge 不可用时降级；文档给出 venv 路径；不硬打包 |
| 词面检索 | 短口述 query 召回差 | 用最近上下文 + app/tags + 多条 query；后续可加 embedding adapter（memfw 有 adapter 边界） |
| prompt injection | 历史记忆含指令 | 明确标记为不可信数据、不执行指令、限长 |
| 召回写事件 | LRU/decay 统计变化 | 明确 recall 是否记 access；提供 `record_access` 参数 |
| 双份存储 | 隐私/删除不同步 | body 只存最终文本；source 链接 history；删除传播 |
| 许可证 | Apache-2.0 分发 | 保留 LICENSE/NOTICE，bridge 不复制实现；文档注明依赖 |
| 延迟 | Python 启动 + FTS | 长驻 bridge（JSONL）而不是每请求起 Python；超时降级 |

## 7. 结论

**值得融合，但顺序应该是：只读 recall → 人工确认 remember → 遗忘/预算。**
memfw 负责“记忆的保留、遗忘、来源与人工控制”，Sayless 负责“语音入口、ASR/LLM、Action 编排与 UI”。两者边界清楚，且都不需要把数据上传云端。

如果要开始，我建议先做 Phase 1：`tools/memfw_bridge.py` + Engine `recall` stage + `ask` action 示例 + fake bridge 测试；这一步不改变现有听写行为，风险最低。
