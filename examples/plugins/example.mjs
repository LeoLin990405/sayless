// sayless 示例插件 — 复制到 ~/.sayless/plugins/ 即自动加载
// 测试钩子是否生效：PLUGIN_EXAMPLE=1 sayless polish "那个帮我看一下呃明天的会"
// 默认所有钩子原样放行（返回 undefined），不改变听写行为。

export const name = '示例插件';

// 注册自定义供应商（可选）：不覆盖用户 config 里的同名 provider。
// 拿到套餐专属 baseUrl 后，把 apiKey 填进 ~/.sayless/config.json 的 providers.<id>.apiKey 即可。
export const providers = {
  'my-llm': { baseUrl: 'https://example.invalid/v1', model: 'my-flash', note: '示例：改成你的 OpenAI 兼容端点' },
};

// 追加工作流预设（可选）：`sayless run --workflow demo` 或 config.activeWorkflow 切换
export const workflows = {
  demo: { asr: 'whisper', llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' }, cross: true },
};

// 钩子 1：ASR + 词典之后、LLM 之前
export async function onTranscript(text, ctx) {
  if (!process.env.PLUGIN_EXAMPLE) return; // undefined = 不修改
  return text.replace(/^(那个|就是|然后)+/, '');
}

// 钩子 2：结果定稿前（写入历史之前）
export async function onPolish(text, ctx) {
  if (!process.env.PLUGIN_EXAMPLE) return;
  console.error(`· [示例插件] mode=${ctx.mode} app=${ctx.app ?? '-'} 长度=${text.length}`);
  return text;
}

// 钩子 3：粘贴/输出前最后一道（想加签名、改格式在这里）
export async function onInsert(text, ctx) {
  if (!process.env.PLUGIN_EXAMPLE) return;
  return text;
}
