# Changelog

## v6.0.0 (2026-10-21)

**彻底重构 UI，摆脱 Typeless 视觉语言。** 功能与数据格式保持不变。

### Sayless Paper（Hub）

- 全新设计系统：暖纸底、墨色正文、朱砂强调色、宋体标题、等宽小标签、硬朗 2–3px 圆角与实体投影。
- 结构重写：移除左侧栏与右侧 rail，改为**顶部刊头**（品牌印章 / 01–04 导航 / 日期 / 命令 / 帮助），内容单栏居中。
- 首页：印章 hero + 52 周书写记录矩阵 + 台账式统计 + 最近条目/系统/归档/快捷键/阵容。
- 历史：从卡片流改为**纸面台账**，大字号搜索结果、日期/模式戳、细分割线。
- 词典：索引式章节，替换表/热词/应用词层/风格规则统一纸面排版。
- 设置：从长单列改为**左侧分类导航 + 右侧单组表单**（语音/模型/质量/交互/数据），每组有说明、状态摘要和保存状态；顶部与底部均可保存，未保存自动提示。
- ⌘K 命令面板、`?` 快捷键帮助、确认框、toast 全部换为纸面/朱砂体系。

### 菜单栏与录音形态

- **自定义菜单栏弹出面板**替换系统 NSMenu：S 图标 → NSPopover（344×432）：开始听写、翻译/问答、最近 3 条、工作台/历史/设置、更多菜单（登录启动/词库/数据目录/日志/辅助功能/紧急停止/退出）。
- 状态栏图标改为自绘模板 S + 录音点，不再使用 emoji。
- **录音胶囊改为 Paper 录音纸片**：米纸底、朱砂录音点、墨色波形、红色方形停止；移除 Typeless 的 ✕/✓ 深色浮条语言。

### Tests / Docs

- 74 个 Node 集成测试全部通过；README / CHANGELOG / capsule / menubar / hub 截图全部更新到 v6.0.0。
- README 明确：v6 起 UI 为独立 Sayless Paper 设计，不再按 Typeless 1:1 复刻。

## v5.2.0 (2026-10-21)

最后一轮体验收尾。

### Hub / App

- **? 快捷键帮助层**：集中展示 ⌘K、⌘1–4、`/`、Esc 和当前录音热键；顶部 `?` 按钮或键盘 `?` 均可打开。
- 命令面板新增「键盘快捷键」入口；帮助层沿用 Studio 玻璃卡片与 kbd 体系。
- 录音胶囊 Transcribing 状态增加循环点动效，减少“卡住”的错觉。
- 快捷键帮助中的听写/翻译/问答键位从当前配置动态读取，改键后显示同步。

### Tests / Docs

- 73 个 Node 集成测试：新增 `?` 打开/关闭帮助层并展示动态热键的 Chrome 行为测试。
- 新增快捷键帮助截图；README / CHANGELOG 更新到 v5.2.0。

## v5.1.0 (2026-10-21)

以「键盘优先 + 检索可读性」为主的 hub 体验迭代。

### Hub

- **⌘K 命令面板**：统一入口搜索/执行页面跳转、开始听写、打开数据目录、导入/导出词库与历史、运行体检；输入关键词时自动出现「在历史中搜索」动作。
- **键盘导航**：⌘1–4 切换四页，`/` 聚焦历史搜索；命令面板支持 ↑↓ / ↵ / esc。
- **历史命中高亮**：全量搜索结果中的原文、结果和 ASR 原文用酸橙 `<mark>` 标出，长文本更容易定位。
- 顶部栏增加 ⌘K 触发按钮；命令面板沿用 Studio 视觉（墨绿玻璃、酸橙选中态）。

### Tests / Docs

- 72 个 Node 集成测试：新增命令面板打开 + 过滤的 Chrome 行为测试，并扩展历史搜索高亮断言。
- 新增命令面板截图；README / CHANGELOG 更新到 v5.1.0。

## v5.0.0 (2026-10-21)

「Sayless Studio」视觉重构：功能与数据格式不变，只重做观感与信息层次。

### Hub

- 全新深墨绿画布 + 酸橙强调色 + 细颗粒/双径向光晕，去掉旧版通用蓝灰卡片感。
- 左侧栏品牌 mark、分区导航、活跃态指示；主区新增 top line（SAYLESS / VOICE STUDIO + 本地模式 + 日期）。
- 首页：衬线感大标题（第二段酸橙高亮）、麦克风呼吸 orb、快捷标签；四格统计改为一条连续 activity strip（带序号）；热力图扩展为 26 周并铺满卡片。
- 历史/词典/设置统一新的卡片、表单、chip、kbd、按钮和滚动条体系；历史操作按钮常显低透明度、hover 提升；设置保存栏改为文档流结尾，避免遮挡内容。
- 录音胶囊同步重做：460×58 墨绿底、酸橙 18 段波形、Listening/Translating/Asking 状态、圆形 ✕/✓ 按钮。
- 增加 tab 入场、orb 呼吸、信号点等轻量动效，并尊重 `prefers-reduced-motion`；窄窗口响应式折叠右栏/侧栏。

### Tests / Docs

- 无功能变更；71 个 Node 集成测试全部通过。
- README / CHANGELOG / 全部 hub 截图更新到 v5.0.0 视觉。

## v4.9.0 (2026-10-21)

以「历史全量检索 + 分页浏览」为主的下一轮迭代。

### Hub / App

- **全量历史搜索**：输入关键词后由 Swift 读取全部 `history.jsonl` 匹配（原文/结果/应用/模式/时间），返回前 200 条与总匹配数；不再受界面最近 1000 条限制。
- **分页加载**：历史底部新增「加载更早记录（剩余 N 条）」，每次追加 500 条并保持时间倒序；搜索状态与分页按钮互斥，避免误触。
- **搜索竞态**：请求带 request id + query 校验，快速输入时旧结果不会覆盖新结果；无 native 的浏览器预览退回本地已加载搜索。
- 历史详情/回放/重转写/删除/导出在搜索结果中同样可用。

### Backend / Tests

- 71 个 Node 集成测试：新增历史追加 + 全量搜索渲染的 Chrome 行为测试。
- `rec` 权限测试等待窗口放宽，降低高负载下的偶发失败。
- README / CHANGELOG / 截图更新到 4.9.0。

## v4.8.0 (2026-10-21)

以「数据可携带 + 维护体验」为主的下一轮迭代。

### Hub

- **词典导入/导出**：词典页新增「导出词库」「导入词库」；导出保留完整 JSON（0600），导入走 NSOpenPanel、校验结构后**合并**（替换按 from/pattern 去重，热词/规则去重，分应用层合并），成功后提示数量并刷新。
- **历史导出**：历史页新增「导出历史」，把全部历史（不受 hub 1000 条显示上限影响）导出为格式化 JSON。
- 导入/导出复用 native `hubActionResult`，失败（坏 JSON/权限/取消）不会假成功。

### CLI

- `sayless dict import` 自动识别 JSON：接受 `dict export` 产物或任意合法词库 JSON，按同一规则合并；坏 JSON/结构错误 exit 2。
- 文本导入（`a=>b` / 纯热词）保持兼容。

### Tests / Docs

- 70 个 Node 集成测试（新增 JSON 词典导入、hub 导入导出按钮覆盖）。
- README/CHANGELOG/截图更新到 4.8.0。

## v4.7.0 (2026-10-21)

以「操作结果可信、权限提示、首页可观测性」为主的下一轮全栈迭代。

### Hub

- **操作结果确认**：所有词典/历史写操作带 request id；Swift 在真正写入成功后调用 `hubActionResult`，失败时页面保留输入并提示原因，不再先弹「已添加/已删除」。
- **首页运行状态**：新增 ASR / 润色 / 翻译 / 交叉家数 / Key 配置数，点击直达设置；首次使用显示未初始化。
- **初始化/Provider 状态**：保留 v4.6 的一键 init 与 provider 状态 chips；操作提示统一到 native 回调。

### App / 权限

- **麦克风权限预检**：`AVCaptureDevice.authorizationStatus`；未决定时先请求，拒绝/受限时明确提示，不再出现“卡住录音到最后才报没声音”。
- **通知迁移**：`NSUserNotification` → `UserNotifications`，按需请求授权，失败写入日志；移除弃用 API 警告。
- **首次权限体验**：麦克风授权成功后自动继续同一次听写（保留 pendingMode）。

### Backend / Tests

- 本版无破坏性 CLI 变更；沿用 v4.6.0。
- 69 个 Node 集成测试；新增 hub 操作回调/首页状态静态覆盖，继续包含 Chrome headless、mock provider/ASR、假 ffmpeg。

## v4.6.0 (2026-10-21)

以「首次使用 / 可观测性 / 日常检查」为主的下一轮全栈迭代。

### Hub / App

- **首次使用引导**：config 缺失或 provider 为空时，hub 顶部显示初始化横幅；一键调用内置 CLI `sayless init`（不联网），成功自动刷新，失败把命令输出展示在页面里。
- **Provider 状态**：设置页列出每个供应商「已配置 / 未配置」，点击即可选中写入 key；Key 写入成功后状态即时更新。
- **历史详情**：每条历史可展开 `ⓘ`，查看 ASR 原文、ASR/LLM/总耗时、应用与录音文件；数据来自新增的 `timings` 字段。
- **快捷键冲突**：hub 内联提示重复的 key+modifier，保存前拦截；快捷键录制期间临时注销 Carbon 热键，避免录制已被占用的组合时触发原动作。
- **空配置/回调**：`configExists`、`dictExists` 注入；初始化、设置保存、Key 写入均有成功/失败回调，不再只做乐观提示。
- App 页头版本、Info.plist、CLI、package 统一 4.6.0。

### Backend

- 本版无破坏性 CLI 变更；沿用 v4.5.0 的解析/权限/重试/历史语义。
- hub 数据补充 `timings`、`configExists`、`dictExists`。

### Tests / Docs

- 68 个 Node 集成测试（新增 hub onboarding / provider 状态 / 历史详情；仍含 mock provider、mock ASR、假 ffmpeg、Chrome headless）。
- 更新 README、CHANGELOG、hub 截图。

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
