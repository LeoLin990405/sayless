# Sayless Architecture (v7)

v7 的核心变化：**菜单栏 App 不再每次热键启动一次 CLI，也不再围绕三种固定模式编码**。现在由一个长驻 **Sayless Engine** 执行可编程 **Action / Pipeline**，菜单栏、CLI、hub、插件都是客户端。

## 1. 进程拓扑

```text
┌─────────────────────┐
│ SaylessBar (App)    │  AVAudioEngine 录音 / 权限 / 粘贴 / 菜单栏 / hub
│  ├─ EngineClient    │  stdin/stdout JSON 行
│  └─ HubWindow       │
└─────────┬───────────┘
          │  {"id","action","wav","app","force"}
          ▼
┌─────────────────────┐
│ sayless engine      │  长驻 Node 进程
│  ├─ Action registry │  actionTable(config.actions)
│  ├─ Pipeline        │  asr → dict → llm → translate → ask
│  ├─ ASR adapters    │  whisper / mimo-asr / ark-ws / openai
│  ├─ Provider registry│ OpenAI-compatible baseUrl + key + model
│  ├─ Dictionary      │  replacements / hotwords / per-app layers
│  ├─ Plugins         │  onTranscript / onPolish / onInsert
│  └─ History/archive │  history.jsonl / recordings/
└─────────┬───────────┘
          │  {"id","event":"stage|done|error"}
          ▼
   App / CLI / scripts
```

- **一次启动，多次请求**：Engine 进程复用 Node 启动、配置读取、插件加载和供应商连接。
- **App 是薄客户端**：只负责录音、权限、粘贴和 UI；不再解析 CLI 的 `RESULT_JSON`。
- **失败隔离**：Engine 崩溃时客户端收到结构化的 `error`，下一次任务自动重启 Engine。
- **可替换**：任何能说 JSONL 协议的客户端都能驱动 Engine；CLI 也可绕过 Engine 直连 core 函数。

## 2. Action 模型

Action 是 `~/.sayless/config.json` 中的一段配置：

```jsonc
{
  "actions": {
    "dictate": {
      "label": "听写",
      "pipeline": ["asr", "dict", "llm", "dict"],
      "output": "paste"
    },
    "note": {
      "label": "语音笔记",
      "pipeline": ["asr", "dict", "llm"],
      "output": "file",
      "file": "~/Notes/voice.md"
    }
  }
}
```

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `label` | string | UI/CLI 展示名 |
| `pipeline` | string[] \| string | 有序 stage；支持数组或 `asr,dict,llm` 字符串 |
| `output` | string | `paste` / `clipboard` / `stdout` / `file` / `none` |
| `file` | string | `output=file` 时的目标路径 |
| `to` | string | translate stage 的目标语言；缺省用 `translate.to` |
| `provider` / `model` | string | 覆盖该 action 的模型 |
| `cross` | bool | 覆盖交叉投票开关 |
| `noSearch` | bool | ask stage 跳过联网 |
| `keep` | number | 录音归档保留条数 |

内置三个 action：`dictate`、`translate`、`ask`。自定义 action 只需要新增 key，Engine 无需改代码。

## 3. Stage 语义

| Stage | 输入 | 输出 | 说明 |
|---|---|---|---|
| `asr` | WAV | text | 走 `asr.adapter`；必要时做幻觉过滤 |
| `dict` | text | text | 确定性替换 + 热词 + 分应用词层 |
| `llm` | text | text | 单模型或 `cross` 交叉投票 |
| `translate` | text | text | 目标语言来自 action.to / config.translate.to |
| `ask` | text | text | 检索 + 回答（可 `noSearch`） |

- Stage 顺序完全由 action 决定；`dict` 可以出现多次（前置保护 + 后置兜底）。
- 所有 stage 都在 Engine 内执行；`onStage` 事件让客户端显示进度。
- 插件钩子在 pipeline 前后执行：`onTranscript`、`onPolish`、`onInsert`。

## 4. JSONL 协议

客户端 → Engine：

```json
{"id":"uuid","action":"dictate","wav":"/tmp/utterance.wav","app":"Mail","force":true}
{"id":"uuid","action":"note","text":"已有文本，不需要 asr"}
{"id":"uuid","op":"ping"}
```

Engine → 客户端：

```json
{"id":"uuid","event":"accepted","action":"dictate"}
{"id":"uuid","event":"stage","stage":"asr","index":1,"total":4}
{"id":"uuid","event":"done","ok":true,"result":{"action":"dictate","out":"...","raw":"...","mode":"dictate","ts":"...","rec":"...","timings":{}}}
{"id":"uuid","event":"error","ok":false,"error":"未知 action：nope","code":1}
```

- 一行一个 JSON，stdout 只用于协议；Engine 启动时把 `console.log` 重定向到 stderr。
- `done.result.entry` 同时包含落盘后的历史条目（`inserted=false`，由 App 粘贴后回写）。
- 客户端可随时关闭 stdin；Engine 会退出。

## 5. 分层

| 层 | 文件/进程 | 职责 |
|---|---|---|
| Clients | `SaylessBar.swift` / `sayless action` / hub | 录音、UI、权限、粘贴、查询 |
| Protocol | `engineServe()` | JSONL 编解码、事件、错误 |
| Action runtime | `actionTable()` / `executeAction()` | 注册 action、执行 pipeline、输出适配器 |
| Model layer | provider registry / `chat()` / `crossEnhance()` | 任意 OpenAI 兼容端点、投票、仲裁 |
| Speech layer | `asr()` / 适配器 | whisper / MiMo / 方舟 / OpenAI 兼容 |
| Local state | `history.jsonl` / `dictionary.json` / `recordings/` | 0600 本地数据 |

## 6. 扩展方式

- **新模型供应商**：config `providers` 加 baseUrl/key/model；或 hub 的「供应商连接」。
- **新 action**：config `actions` 加 pipeline；CLI 用 `sayless action <id>`，Engine 用 `{"action":"<id>"}`。
- **新 stage**：在 `executeAction` 的 stage switch 中注册；插件可通过钩子改文本，不需要改 App。
- **新输出**：在 `deliverActionOutput` 加适配器（如 webhook / Apple Notes / webhook）。
- **新客户端**：按 JSONL 协议连接 `sayless engine --stdio` 即可。

## 7. 兼容性

- 旧 CLI 命令（`run` / `transcribe` / `polish` / `translate` / `ask`）保留。
- 旧 `config.json` 缺 `actions` 时由 `ensureInit` 补默认值。
- App 仍用三个内置 action 对应原有三个热键；自定义 action 目前通过 CLI / Engine 调用，后续可映射到动态热键。
