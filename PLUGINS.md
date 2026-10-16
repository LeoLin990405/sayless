# sayless 插件开发指南

给 sayless 做个性化定制，不需要改源码：把一个 `.mjs` 文件放进 `~/.sayless/plugins/`，
每次听写自动加载。适合：按应用改写语气、行业术语后处理、自定义供应商接入、
输出重定向（比如自动发到某个文件/机器人）。

## 安装

```sh
mkdir -p ~/.sayless/plugins
cp examples/plugins/example.mjs ~/.sayless/plugins/   # 从仓库拿示例
sayless plugin                                        # 查看已加载插件
```

加载顺序按文件名排序；插件加载失败只告警，不阻塞听写。

## 插件契约

每个导出都是可选的，返回 `undefined` 表示"我不修改"：

```js
// ~/.sayless/plugins/my-plugin.mjs

export const name = '我的定制';

// 1) 注册自定义供应商（不覆盖用户 config 同名项）
export const providers = {
  'my-llm': { baseUrl: 'https://your-endpoint/v1', model: 'your-model' },
};
// 之后 config.json → llm.provider = "my-llm" 即可启用；apiKey 写 providers.my-llm.apiKey

// 2) 追加工作流预设（config.activeWorkflow 或 --workflow 切换）
export const workflows = {
  mine: { asr: 'whisper', llm: { provider: 'my-llm' }, cross: true },
};

// 3) 文本钩子（按管线顺序）
// ctx = { mode: 'dictate'|'translate:*'|'ask'|'raw', app: 前台应用名|null, wavPath, cfg }
export async function onTranscript(text, ctx) { return text; }  // ASR+词典后、LLM 前
export async function onPolish(text, ctx)     { return text; }  // 结果定稿前（历史落盘前）
export async function onInsert(text, ctx)     { return text; }  // 粘贴/输出前最后一道
```

钩子里可以 `import` 任何 npm 包（插件是标准 ESM，`node_modules` 放
`~/.sayless/plugins/` 下即可被相对解析）。

## 食谱

### 按应用切换语气（微信随便说 → 邮件正式说）

```js
export async function onPolish(text, ctx) {
  if (ctx.app === 'Mail' && ctx.mode === 'dictate') {
    // 简单确定性改写；要更强可以在这里自己 fetch 一个 LLM
    return text.replace(/哈+/, '').replace(/~+$/, '') + '\n\n此致';
  }
}
```

### 只对翻译模式生效

```js
export async function onInsert(text, ctx) {
  if (ctx.mode?.startsWith('translate:')) return text.toUpperCase();
}
```

### 每条听写自动追加到团队知识库

```js
export async function onPolish(text, ctx) {
  fetch('https://your-bot.internal/hook', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: ctx.app, text }),
  }).catch(() => {});   // 别让网络问题阻塞听写
  return text;
}
```

## 调试

- `sayless plugin`：列出插件和它们注册的钩子
- `sayless doctor`：头部会打印插件加载日志（含报错原因）
- 钩子内 `console.error` 会打到终端/SaylessBar 日志，不会混进粘贴文本
