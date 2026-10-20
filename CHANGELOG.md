# Changelog

## v4.5.0 (2026-10-20)

一次前后端全栈迭代，重点是把“设置不生效、搜索没反应、录音没结束就转写”这类长期问题修掉，并补齐可测试性。

### 前端（hub.html / SaylessBar）

- **数据驱动 hub**：Swift 只注入一份 `__DATAJSON__`（stats / days / history / dict / cfg / env），前端负责渲染；所有动态文本统一 HTML 转义，配置里 `apiKey` 在 Swift 侧递归剥离，只暴露 `hasKey` 布尔值。
- **历史页**：修复搜索 class 不匹配导致搜索无反应；新增复制、删除、清空、条数统计；回放/重转写继续可用；空状态提示。
- **词典页**：新增筛选、风格规则增删、分应用词层创建/删除、应用热词/替换增删；保留词频统计（结果 + 原文）。
- **设置页**：ASR 路径/语种/幻觉过滤、LLM 温度/重试、翻译 provider/model、交叉阵容与仲裁编辑、Ask 引擎/代理/结果数、行为（剪贴板恢复）、**快捷键录制**、Key 写入、一键体检、关于信息。
- **表单修复**：深色 `color-scheme` + 全局 input/select 样式，修复词典与交叉阵容里白底输入框；模型留空用 `null` 删除旧值；相似度显示保留两位。
- **窗口**：hub 从 `NonKeyWindow` 改为普通可聚焦窗口，设置页输入框/快捷键录制可正常接收键盘。
- **刷新**：词典/历史修改后重新生成 HTML（保留当前 tab），不再 `web.reload()` 旧数据；JS 报错写入隐藏 `#js-error` 便于自动化检查。

### 后端（sayless.mjs）

- **修复 `sayless run` 竞态**：`rec` 改为返回 Promise，等 ffmpeg 真正退出、校验 WAV 后再进入 ASR；`translate/ask --say` 同样等待。
- **配置与工作流**：`activeWorkflow` 只应用投票策略，不再静默覆盖设置页的 ASR/模型；显式 `--workflow <id>` 才应用整套预设；插件工作流的未知警告延后到插件加载后。
- **可靠性**：LLM 429/5xx/网络错误自动重试（可配 `llm.retries`）；统一超时；错误信息带 provider/model；`AbortSignal` 合并兼容 Node 18。
- **录音/数据**：`SAYLESS_DIR`、`SAYLESS_FFMPEG`、`SAYLESS_AUDIO_DEVICE`；配置/词典/历史/录音 0600；原子写入；录音超时、ffmpeg 路径、音频段设备列表。
- **ASR**：`ark-ws` 自动取 `providers.ark-plan.apiKey`；openai 端点缺 baseUrl 明确报错；静音幻觉过滤可配；`asr` 返回值统一清洗。
- **历史/统计**：新增 `sayless stats [--json]`、`history --json/--search/--delete/--clear/--export`；写入 `RESULT_JSON:` 机器可读结果，解决多行文本被 App 截断。
- **词典**：新增风格规则、分应用词层命令、`export`、`validate`；批量导入去重；无效正则只告警；替换文本里的 `$` 原样保留。
- **学习**：LCS + `Intl.Segmenter` 智能 diff 替代按位置比对；`learn --mine --apply --min-count N` 自动回写；`--dry-run`。
- **小修**：`--method=value` 参数、全局 `--help`、`--json`、`--no-search`、默认 provider 补 `zai` / `qwen-plan`、MiniMax `chatPath`。
- **review 修复**：`history --search + --delete` 不再误删非匹配项、空 `--delete` 拒绝、`--workflow` 不再持久化、插件 workflow 不再先套用 activeWorkflow、`--translate` 可选值/`--` 解析、`translate/ask` 空模型使用 provider 默认、分应用替换在 LLM 后二次生效、`inserted` 记录实际结果、`rec -o` 录制期间即 0600、ASR 网络错误 exit 3、未知参数告警、插件加载失败可见、`dict validate` 检查应用词层、未知 ASR adapter 直接拒绝（不回落云端）、cross 空 model 用 provider 默认、doctor 显示 effective model 与显式 workflow、`history --json` 默认全量、stats 使用完整字符数、空数字参数不再当 0。
- **App review 修复**：热键按 keyCode+modifier 存储、PTT 松开修饰键仍能停、tap 被用户输入禁用后恢复、自动重复过滤、录音/处理状态机与取消子进程、WAV 写入失败不再当成功、完整剪贴板快照恢复、粘贴失败通知、AudioRecorder 缓冲加锁、`SAYLESS_DIR` 全链路一致、hub 空配置可渲染、快捷键录制禁止裸可打印键、历史/词典/设置回调与状态同步。

### App / 工程

- App 构建时内置 `sayless.mjs` + `asr-ark-ws.mjs`，不再强依赖 `/opt/homebrew/bin/sayless`；`SAYLESS_CLI` 可覆盖。
- Node/CLI 路径自动发现；`RESULT_JSON` 优先解析；`insert.mode=none` 与 `insert.restoreClipboard` 在 App 内生效。
- Carbon 兜底热键现在尊重配置的 modifier（此前固定 Option）。
- 登录项改为按当前状态 register/unregister。
- 胶囊成功态恢复 2.2s 文本预览（此前成功立即消失）。
- 新增 headless 调试口子：`SAYLESS_DUMP_HUB` / `SAYLESS_DUMP_HUB_TAB`。
- 新增 67 个 Node 集成测试（mock 供应商/ASR + 假 ffmpeg）与 hub Chrome headless 测试；`npm test` / `npm run check`。
- 新增 `package.json`、CI、`tools/gen-hub-demo.mjs`（Chrome 截图 + DOM 检查）。
