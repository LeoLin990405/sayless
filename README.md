# sayless — 本地听写/翻译/问答管线（自研）v2

录音 → ASR → 词语库 → 多模型 LLM → 翻译/问答 → 插入焦点应用。
多模型供应商注册表（方舟/百炼/MiniMax/SiliconFlow…任接），翻译 8 语种，
联网问答带引用（Bing CN + DuckDuckGo，无需付费搜索 key）。
自研实现，不含任何第三方听写应用代码；架构思路参考了对本机应用的观察。

## App 外壳：SaylessBar v3（Typeless 式 UI）

- **录音胶囊浮窗**：按热键后屏幕底部居中弹出暗色 HUD 胶囊——红点呼吸 + 7 根麦克风电平条 + 实时计时 + 模式标签（听写 ⌥Space / 翻译 ⌥T / 问答 ⌥Q）；处理中变旋转指示；完成后 ✓ + 润色文本预览，3.5s 自动消失（不抢焦点、全空间悬浮）。
- **听写历史**：菜单"听写历史…"查看最近 100 条（时间/模式/成稿），数据落盘 `~/.sayless/history.jsonl`，CLI 侧 `sayless history -n 20`。
- **静音防幻觉**：整体括号包裹输出（如"(笑)"）或剥标点后 ≤1 字视为无语音，优雅跳过。
- 权限预期（各一次性）：麦克风给 SaylessBar；**辅助功能给 SaylessBar**（粘贴用，未授权时报 1002 并写日志）。

## 多模型

`config.json → providers` 注册任意 OpenAI 兼容供应商（baseUrl+apiKey），
内置预设：`ark-plan`（Agent Plan）/`dashscope`/`minimax`/`siliconflow`/`deepseek`/
`zai`（智谱）/`kimi`（Kimi for Coding：`api.kimi.com/coding/v1` + `sk-kimi-` key）/
`stepfun`/`mimo`，以及两个**套餐专用通道**：

| 通道 | key | 说明 |
|---|---|---|
| `stepfun-plan` | Step API Key（与按量同一把） | 套餐额度走 `https://api.stepfun.com/step_plan/v1`，与按量余额独立；需先[实名认证](https://account.stepfun.com/security?action=realname)；仅 `step-router-v1`（路由模型，输出带 advisor 脚手架，不建议进交叉投票） |
| `mimo-plan` | 小米 Token Plan 的 `tp-` key | 套餐额度走 `https://token-plan-sgp.xiaomimimo.com/v1`，key 在[控制台](https://platform.xiaomimimo.com/console)获取；`mimo-v2.6-flash` 已进 5 模型交叉投票 |

`llm`/`translate`/`ask` 三条链路各自 `provider+model`，随时切国产模型。
`sayless doctor` 分组实测各供应商（已配 key / 未配 key）+ 显示当前链路。
当前实测组合：ASR=本地 whisper.cpp（离线）；LLM=ark-plan + doubao-seed-2-1-lite；
交叉投票=zai + deepseek + minimax + ark-plan + mimo-plan 共 5 模型。

**工作流**（`activeWorkflow`，hub 设置页可切，`--workflow <id>` 可临时切）：
`fast`=单模型直出（日常听写推荐，2-3s）· `quality`=5 模型交叉投票（~15s）·
`cloud`=云端 ASR+投票。预设可在 config.json `workflows` 增补，插件也能注册。

## 插件（个性化定制口子）

`~/.sayless/plugins/` 放 `.mjs` 即可定制管线，不改源码：文本钩子
（`onTranscript`/`onPolish`/`onInsert`）、注册自定义供应商与工作流。
按应用切换语气、行业术语后处理、听写自动同步外部系统等场景见 **[PLUGINS.md](PLUGINS.md)**，
`sayless plugin` 查看已加载插件。

## 翻译与问答

```sh
sayless translate "文本" --to ja     # 8 语种：en/ja/ko/zh/fr/de/es/ru
sayless translate --say              # 说话→识别→翻译
sayless ask "问题"                    # Bing/DDG 检索 → LLM 回答带 [n] 引用
sayless ask --say                    # 说话→识别→检索问答
sayless run --translate en           # run 管线直接切翻译模式
```

检索引擎 `ask.engines: ["bing","ddg"]` 顺序兜底；ddg 可配 `ask.proxy` 走代理。

## 一次性配置

```sh
sayless init                    # 生成 ~/.sayless/{config.json, dictionary.json}
export SAYLESS_API_KEY=你的key   # 方舟或百炼的 key（也分别可写在 config 里）
sayless doctor                  # 探测路由/设备；401=路由在缺key，200=key有效
```

默认：**ASR 走火山方舟**（`/api/v3/audio/transcriptions`，豆包套餐；确切 model id 用
`arkcli models search asr` 查），**LLM 润色走百炼**（qwen-flash，Qwen 套餐）。
都是 OpenAI 兼容协议，换任何兼容供应商只改 config 两个 url/model。

云端 ASR 还支持 **MiMo 语音识别**（`asr.adapter: "mimo-asr"`）：MiMo-V2.5-ASR，
中英双语+方言、自动标点，消耗 Token Plan 套餐额度（按音频秒计费）。地址/key 自动取
`providers.mimo-plan`，切 adapter 只改 `asr.adapter` 一个字段；`asr.model` 仅在
`mimo-` 开头时生效（默认 `mimo-v2.5-asr`）。

## 用法

```sh
sayless run                # 说话，按 Enter 停止 → 自动转写+润色+粘贴进当前焦点应用
sayless run --sec 10       # 定长 10 秒
sayless run --raw          # 跳过 LLM 润色（只做本地词语库替换）
sayless run --no-insert    # 只输出不粘贴
sayless polish "文本"       # 只润色
sayless dict add 方舟 Ark  # 词语库加确定性替换（零云端，立即生效）
```

## 个性化（~/.sayless/dictionary.json）

- `replacements`：确定性替换（`{"from":"百炼","to":"Bailian"}` 或正则 `{"pattern":...}`），
  在 LLM 前后各跑一遍——不联网也生效。
- `hotwords`：专有名词表，注入润色 prompt，防止 ASR/LLM 瞎改。
- `styleRules`：风格规则（删语气词/标点规范/称呼习惯），逐条进 system prompt。

## App 外壳：SaylessBar（菜单栏常驻）

`/Applications/SaylessBar.app`——菜单栏 🎙 图标 + 全局热键 **⌥Space** 切换听写：

- 🎙 就绪 / 🔴 录音中 / ⏳ 转写润色中；菜单里有"只转写不粘贴"、打开词语库/日志、退出。
- 录音由 app 直接 spawn ffmpeg；转写→润色→粘贴复用 `sayless transcribe` CLI。
- 首次按 ⌥Space 会弹**麦克风**授权（授予 SaylessBar）；首次粘贴会弹**辅助功能**
  授权（同样给 SaylessBar）。错误走系统通知，日志在 `~/.sayless/saylessbar.log`。
- **主面板四页**：首页（洞察+热力图）/ 历史记录（可搜索）/ 词典（可视化编辑）/
  **设置**（ASR 引擎、润色模型、交叉阵容、翻译语种、工作流、行为开关——保存深合并
  写回 config.json，apiKey 等敏感字段不进页面、不会被覆盖）。菜单"设置…"直达。
- 重新构建：`app/build.sh`（swiftc 编译 + ad-hoc 签名 + 装 /Applications 并启动）。
  调试：`SAYLESS_SHOW_HUB=3`（0-3 = 启动即开首页/历史/词典/设置页）。
- 开机自启：系统设置 → 通用 → 登录项 → 添加 SaylessBar。

## 注意

- 粘贴走 剪贴板+Cmd+V（比逐字 keystroke 对中文可靠），会覆盖剪贴板；
  需要辅助功能权限（同 ishot）。`insert.mode: "none"` 可关。
- 录音首次使用需授权麦克风（终端/ffmpeg）。
- 你的语音只发给**你自己配置的 ASR 端点**，润色文本只发给**你自己配置的 LLM**。
