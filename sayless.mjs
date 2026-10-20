#!/usr/bin/env node
// sayless — 本地听写管线 v2（自研实现）：录音 → ASR → 词语库/LLM → 翻译/问答 → 插入焦点应用
// 多模型供应商注册表 + 翻译 + 联网信息检索。代码全新编写，不含任何第三方应用代码。
//
// 用法:
//   sayless init                          生成/补全 ~/.sayless/{config.json,dictionary.json}
//   sayless run [--sec N] [--no-insert] [--raw] [--translate <lang>] [--ask] [--workflow <id>] [--cross]
//   sayless rec  [--sec N] [-o file]      仅录音（wav 16k mono）
//   sayless asr  <file.wav>               仅转写（走当前 ASR 适配器）
//   sayless polish "<text>" [--dry-run] [--cross] [--provider <id>] [--model <id>]
//   sayless translate "<text>" [--to en] [--say] [--cross]
//   sayless ask "<问题>" [--say]          联网检索+回答（带引用）；--say 先录音
//   sayless transcribe <wav> [--translate <lang>] [--ask] [--no-insert] [--raw] [--force] [--app <name>]
//   sayless insert "<text>"               粘贴进焦点应用
//   sayless dict add|del|add-hot|del-hot|import|stats    词语库管理
//   sayless learn "<原文>" "<改稿>"        智能 diff 生成词条；--last 对比上一条；--mine 挖掘高频模式
//   sayless history [-n 20]               听写历史
//   sayless plugin                        已加载插件及钩子
//   sayless doctor                        体检：链路/供应商分组实测/录音设备
// 配置: ~/.sayless/config.json；providers 注册各模型供应商，llm/translate/ask 各自选 provider+model。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const [nmaj] = process.versions.node.split('.').map(Number);
if (nmaj < 18) { console.error(`✗ sayless 需要 Node 18+（当前 ${process.versions.node}）：brew install node 或升级`); process.exit(1); }

const DIR = path.join(os.homedir(), '.sayless');
const CFG = path.join(DIR, 'config.json');
const DICT = path.join(DIR, 'dictionary.json');
const TMP_WAV = path.join(DIR, 'last-utterance.wav');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const DEFAULT_CFG = {
  providers: {
    'ark-plan': {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      // apiKey: Agent Plan 专属 key；也可环境变量 SAYLESS_API_KEY
      model: 'doubao-seed-2-1-turbo-260628'
    },
    dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    minimax: { baseUrl: 'https://api.minimaxi.com/v1' },
    siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1' },
    moonshot: { baseUrl: 'https://api.moonshot.cn/v1' },
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1' },
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1' }, // Kimi for Coding（sk-kimi- key 专用端点）
    stepfun: { baseUrl: 'https://api.stepfun.com/v1' },
    // 套餐通道：同一把 Step API Key，但额度走 /step_plan 专用地址（与按量余额独立）
    'stepfun-plan': { baseUrl: 'https://api.stepfun.com/step_plan/v1' },
    mimo: { baseUrl: 'https://api.xiaomimimo.com/v1' },
    // Token Plan 套餐通道：tp- 前缀 key + 专属域名（额度独立于按量现金余额）
    'mimo-plan': { baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' }
  },
  asr: {
    // adapter: whisper（本地，离线）| mimo-asr（MiMo Token Plan 云端，套餐额度计费）| ark-ws（方舟 Agent Plan 语音，需开按量扣费）| openai（OpenAI 兼容 REST）
    adapter: 'whisper',
    whisperBin: '/opt/homebrew/bin/whisper-cli',
    whisperModel: path.join(DIR, 'ggml-base.bin'),
    wsUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-asr-2-0',
    language: 'zh'
  },
  llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628', temperature: 0 },
  translate: { to: 'en', provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' },
  ask: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628', engines: ['bing', 'ddg'], maxResults: 5, proxy: '' },
  // 交叉加强：多模型并行出稿 → 相似度聚类 → 多数一致取胜，全分歧时仲裁模型裁决
  cross: {
    models: [
      { provider: 'zai', model: 'glm-5-turbo' },
      { provider: 'deepseek', model: 'deepseek-flash' },
      { provider: 'minimax', model: 'MiniMax-M3' },
      { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' }
    ],
    arbiter: { provider: 'deepseek', model: 'deepseek-v4-flash-ga-260910' },
    similarity: 0.82,
    timeoutMs: 30000 // 归一化后字符二元组 Dice 系数阈值，>= 视为一致
  },
  insert: { mode: 'paste' },
  // 工作流预设：切换整套模型组合
  workflows: {
    fast:   { asr: 'whisper', llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' }, cross: false },
    quality:{ asr: 'whisper', llm: { cross: true }, cross: true },
    cloud:  { asr: 'ark-ws', llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-pro-260915' }, cross: true }
  },
  activeWorkflow: 'fast'
};

const DEFAULT_DICT = {
  replacements: [
    { from: '百炼', to: 'Bailian' },
    { from: '方舟', to: 'Ark' }
  ],
  hotwords: ['ZCode', 'Tailscale', 'drizzle', 'OpenClaw', 'koffi', 'MiniMax', '百炼', '方舟', '续费', '听写'],
  styleRules: [
    '删除语气词（嗯、呃、就是说、然后然后）和重复词',
    '技术名词保留英文原文，不要翻译',
    '标点规范：中文用全角，代码/英文 token 前后不加中文标点',
    '统一转换为简体中文',
    '纠正同音/近音错别字（语音识别常见错误，如 擺鏈→百炼、蓄費→续费、C Code→ZCode）'
  ]
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ensureInit = () => {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(CFG)) fs.writeFileSync(CFG, JSON.stringify(DEFAULT_CFG, null, 2));
  if (!fs.existsSync(DICT)) fs.writeFileSync(DICT, JSON.stringify(DEFAULT_DICT, null, 2));
  const cfg = readJson(CFG);
  // 轻量迁移：补缺失字段
  let dirty = false;
  for (const [k, v] of Object.entries(DEFAULT_CFG)) {
    if (cfg[k] === undefined) { cfg[k] = v; dirty = true; }
  }
  if (cfg.providers && DEFAULT_CFG.providers) {
    for (const [k, v] of Object.entries(DEFAULT_CFG.providers)) {
      if (!cfg.providers[k]) { cfg.providers[k] = v; dirty = true; }
    }
  }
  if (dirty) fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  // 工作流预设生效（视图层覆盖，不写回文件）：--workflow <id> 可临时切换
  const wi = process.argv.indexOf('--workflow');
  if (wi > 0 && process.argv[wi + 1]) cfg.activeWorkflow = process.argv[wi + 1];
  const wf = (cfg.workflows || {})[cfg.activeWorkflow];
  if (wf) {
    if (wf.asr) cfg.asr = { ...cfg.asr, adapter: wf.asr };
    if (wf.llm) cfg.llm = { ...cfg.llm, ...(wf.llm.provider ? { provider: wf.llm.provider } : {}), ...(wf.llm.model ? { model: wf.llm.model } : {}) };
    if (typeof wf.cross === 'boolean') cfg._wfCross = wf.cross; // --cross 显式旗标优先于预设
  }
  return cfg;
}

// ---- 插件系统（个性化定制口子）----
// 目录：~/.sayless/plugins/*.mjs，按文件名排序加载。每个插件导出（全部可选）：
//   export const name                     展示名
//   export const providers = {id:{...}}   注册自定义供应商（不覆盖同名用户配置）
//   export async function onTranscript(t, ctx)  ASR+词典之后、LLM 之前；返回新文本或 undefined
//   export async function onPolish(t, ctx)      结果定稿前（历史记录之前）
//   export async function onInsert(t, ctx)      粘贴/输出前最后一道
//   export const workflows = {id:{...}}   追加工作流预设
// ctx = { mode, app, wavPath, cfg }。插件抛错只告警，不阻塞听写。
const pluginLog = [];
let pluginsCache;
async function loadPlugins() {
  if (pluginsCache) return pluginsCache;
  pluginsCache = [];
  const dir = path.join(DIR, 'plugins');
  if (!fs.existsSync(dir)) return pluginsCache;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) {
    try {
      const mod = await import(new URL('file://' + path.join(dir, f)));
      pluginsCache.push({ file: f, ...mod });
      const hooks = ['providers', 'workflows', 'onTranscript', 'onPolish', 'onInsert'].filter(k => mod[k] != null);
      pluginLog.push(`插件 ${f}：${hooks.join(', ') || '（无导出钩子）'}`);
    } catch (e) {
      pluginLog.push(`插件 ${f} 加载失败：${e.message}`);
    }
  }
  return pluginsCache;
}
let pluginsActive = false;
async function activatePlugins(cfg) {
  const ps = await loadPlugins();
  if (!pluginsActive) {
    pluginsActive = true;
    for (const l of pluginLog) console.error(`· ${l}`);
    if (ps.length) console.error(`· 已加载 ${ps.length} 个插件`);
  }
  // 插件供应商并入注册表，用户同名配置优先
  for (const p of ps) {
    for (const [id, prov] of Object.entries(p.providers || {})) {
      cfg.providers = cfg.providers || {};
      if (!cfg.providers[id]) cfg.providers[id] = prov;
    }
    for (const [id, wf] of Object.entries(p.workflows || {})) {
      cfg.workflows = cfg.workflows || {};
      if (!cfg.workflows[id]) cfg.workflows[id] = wf;
    }
  }
  return ps;
}
async function runHook(hook, text, ctx) {
  let t = text;
  for (const p of await loadPlugins()) {
    if (typeof p[hook] !== 'function') continue;
    try {
      const r = await p[hook](t, ctx);
      if (typeof r === 'string') t = r;
    } catch (e) { console.error(`· 插件 ${p.file}.${hook} 出错：${e.message}`); }
  }
  return t;
};

// ---- 词语库（确定性，零云端；支持分应用词层）----
function loadDict(app) {
  const d = readJson(DICT);
  const layers = [d];
  const a = app && (d.apps || {})[app];
  if (a) layers.push(a);
  return {
    replacements: layers.flatMap(l => l.replacements || []),
    hotwords: layers.flatMap(l => l.hotwords || []),
    styleRules: layers.flatMap(l => l.styleRules || []),
    app: app || undefined
  };
}
function applyDict(text, app) {
  const d = loadDict(app);
  let out = text;
  for (const r of d.replacements) {
    if (r.pattern) out = out.replace(new RegExp(r.pattern, 'g'), r.to);
    else if (r.from) out = out.split(r.from).join(r.to);
  }
  return out;
}

// ---- 供应商注册表 + 通用 chat ----
function resolveProvider(cfg, name) {
  const p = { ...((cfg.providers || {})[name] || {}) };
  if (!p.baseUrl && !p.apiKey) throw new Error(`未知 provider: ${name}（config.json 的 providers 里没有）`);
  const key = p.apiKey || process.env.SAYLESS_API_KEY;
  if (!key) throw new Error(`provider ${name} 缺 apiKey`);
  return { ...p, baseUrl: (p.baseUrl || '').replace(/\/$/, ''), apiKey: key };
}

async function chat(cfg, providerName, model, messages, temperature = 0, signal) {
  const p = resolveProvider(cfg, providerName);
  const m = model || p.model;
  if (!m) throw new Error(`provider ${providerName} 未指定 model（--model 或 config 里补）`);
  if (!p.apiKey) throw new Error(`provider ${providerName} 缺 apiKey（设置页写入或 config.json）`);
  // 单模型直出也要熔断：默认 45s，可用 cross.timeoutMs 调
  const fused = signal ?? AbortSignal.timeout(cfg.cross?.timeoutMs ? cfg.cross.timeoutMs + 15000 : 45000);
  const res = await fetch(p.baseUrl + (p.chatPath || '/chat/completions'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
    signal: fused,
    body: JSON.stringify({ model: m, temperature, messages })
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status} (${providerName}/${model}): ${body.slice(0, 300)}`);
  const j = JSON.parse(body);
  const out = j.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error(`LLM 空响应: ${body.slice(0, 200)}`);
  return out;
}

const pick = (cfg, section) => {
  const s = cfg[section] || {};
  return { provider: s.provider || cfg.llm.provider, model: s.model || cfg.llm.model };
};

// ---- 录音（ffmpeg avfoundation，默认麦克风 :0）----
function rec(seconds, outFile) {
  const args = ['-f', 'avfoundation', '-i', ':0', '-ar', '16000', '-ac', '1', '-y'];
  if (seconds) args.push('-t', String(seconds));
  args.push(outFile);
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  console.error(`● 录音中${seconds ? `（${seconds}s）` : ''}，按 Enter 停止…`);
  if (!seconds) {
    const rl = readline.createInterface({ input: process.stdin });
    const stop = () => p.kill('SIGINT');
    rl.once('line', stop);
    if (!process.stdin.isTTY) rl.once('close', stop);
  }
  const err = [];
  p.stderr.on('data', (d) => err.push(d));
  p.on('exit', (code) => {
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) {
      console.error(`■ 完成 → ${outFile}`);
      process.exit(0);
    }
    console.error(`✗ 录音失败 (code=${code})。首次使用需在 系统设置→隐私与安全性→麦克风 授权终端/ffmpeg。`);
    console.error(err.join('').split('\n').slice(-3).join('\n'));
    process.exit(3);
  });
}

// ---- ASR ----
async function asr(wavPath) {
  const cfg = ensureInit();
  const key = process.env.SAYLESS_API_KEY || cfg.asr.apiKey;
  if (cfg.asr.adapter === 'whisper') {
    const modelPath = cfg.asr.whisperModel || '';
    if (!fs.existsSync(modelPath)) {
      console.error(`✗ whisper 模型缺失：${modelPath}`);
      console.error('  下载：mkdir -p ~/.sayless && curl -L -o ~/.sayless/ggml-base.bin \\');
      console.error('        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin');
      console.error('  （网络不畅可把域名换成 hf-mirror.com 镜像；也可以在设置页把 ASR 引擎切成 MiMo 云端）');
      process.exit(3);
    }
    if (fs.statSync(wavPath).size < 20000) { console.error('· 音频过短（<0.6s），跳过识别'); return ''; }
    const { execFileSync } = await import('node:child_process');
    let out;
    try {
      out = execFileSync(cfg.asr.whisperBin || '/opt/homebrew/bin/whisper-cli',
        ['-m', modelPath, '-l', cfg.asr.language || 'zh', '-nt', '-np', '-f', wavPath],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      console.error('✗ whisper 转写失败：' + String(e.message).split('\n')[0]);
      process.exit(3);
    }
    const t = out.replace(/\s+/g, ' ').trim();
    if (/^[（(【\[〔].*[）)\]〕]$/.test(t)) return ''; // 整段括号包裹 = 静音幻觉标记
    return t;
  }
  if (cfg.asr.adapter === 'mimo-asr') {
    // MiMo 云端语音识别：chat 接口 + input_audio base64（非 /audio/transcriptions 端点）。
    // 地址与 key 优先取 providers.mimo-plan（套餐 tp- key + 专属域名），asr.* 仅作回退；
    // 模型名只认 mimo- 开头，避免把其他厂商的 asr.model 带进来。切 adapter 改 asr.adapter 一个字段即可。
    const plan = cfg.providers?.['mimo-plan'] || {};
    const mk = plan.apiKey || cfg.asr.apiKey;
    const base = (plan.baseUrl || cfg.asr.baseUrl || '').replace(/\/$/, '');
    if (!mk || !base) { console.error('✗ mimo-asr 缺配置：providers.mimo-plan 的 baseUrl/apiKey 或 asr.baseUrl/apiKey'); process.exit(2); }
    const model = (cfg.asr.model || '').startsWith('mimo-') ? cfg.asr.model : 'mimo-v2.5-asr';
    const b64 = fs.readFileSync(wavPath).toString('base64');
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mk}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${b64}` } }] }],
        asr_options: { language: cfg.asr.language || 'zh' }
      })
    });
    const t = await res.text();
    if (!res.ok) { console.error(`✗ ASR ${res.status}: ${t.slice(0, 400)}`); process.exit(3); }
    return JSON.parse(t).choices?.[0]?.message?.content ?? '';
  }
  if (!key) { console.error('✗ 缺 apiKey：export SAYLESS_API_KEY=... 或写进 config.json'); process.exit(2); }
  if ((cfg.asr.adapter ?? 'openai') === 'ark-ws') {
    const { arkAsr } = await import(new URL('asr-ark-ws.mjs', import.meta.url));
    return arkAsr({ apiKey: key, wavPath, wsUrl: cfg.asr.wsUrl, onLog: m => console.error(`· ${m}`) });
  }
  const url = cfg.asr.baseUrl.replace(/\/$/, '') + '/audio/transcriptions';
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wavPath)]), path.basename(wavPath), { type: 'audio/wav' });
  form.append('model', cfg.asr.model);
  if (cfg.asr.language) form.append('language', cfg.asr.language);
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const body = await res.text();
  if (!res.ok) { console.error(`✗ ASR ${res.status}: ${body.slice(0, 400)}`); process.exit(3); }
  const j = JSON.parse(body);
  return j.text ?? j.output?.text ?? j.output ?? '';
}

// ---- 润色 ----
async function polishOnce(cfg, d, provider, model, text, signal) {
  const sys = [
    '你是听写文本润色器。用户输入是语音转写的原始文本。',
    '规则：', ...(d.styleRules || []),
    `专有名词（必须保持原样）：${(d.hotwords || []).join('、')}`,
    '只输出润色后的文本，不要解释，不要加引号，不要改变原意。'
  ].join('\n');
  const out = await chat(cfg, provider, model, [{ role: 'system', content: sys }, { role: 'user', content: text }], cfg.llm.temperature ?? 0, signal);
  return applyDict(out);
}
async function polish(text, { dryRun = false, provider: pOv, model: mOv, cross = false, app = null } = {}) {
  const cfg = ensureInit();
  await activatePlugins(cfg);
  cross = cross || cfg._wfCross === true;
  const d = loadDict(app);
  text = applyDict(text, app);
  if (dryRun) return { text, applied: 'dict-only(dry-run)' };
  if (cross) {
    const out = await crossEnhance(cfg, 'polish', text, (p, m, t, sig) => polishOnce(cfg, d, p, m, applyDict(t), sig));
    return { text: applyDict(out), applied: 'cross-consensus' };
  }
  const base = pick(cfg, 'llm');
  const provider = pOv || base.provider, model = mOv || (pOv ? undefined : base.model);
  return { text: await polishOnce(cfg, d, provider, model, text), applied: `dict→${provider}/${model}→dict` };
}

// ---- 交叉加强：并行 fanout → 相似度聚类 → 多数共识 / 仲裁裁决 ----
const normalizeTxt = (s) => s.replace(/\s+/g, '').replace(/[，。,.!?！？；;：:、""''（）()【】\[\]—…·]/g, '').toLowerCase();
function diceSim(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (x) => { const m = new Map(); for (let i = 0; i < x.length - 1; i++) { const g = x.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b);
  let inter = 0, tot = 0;
  for (const [g, c] of A) { tot += c; if (B.has(g)) inter += Math.min(c, B.get(g)); }
  for (const c of B.values()) tot += c;
  return tot ? (2 * inter) / tot : 0;
}
async function crossEnhance(cfg, kind, text, once) {
  const cx = cfg.cross || {};
  const models = cx.models || [];
  if (models.length < 2) { const b = pick(cfg, kind); return once(b.provider, b.model, text); }
  const t0 = Date.now();
  const base = pick(cfg, kind);
  const perCallTimeout = cx.timeoutMs ?? 45000;
  const settled = await Promise.allSettled(models.map(m => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error(`超时 ${perCallTimeout}ms`)), perCallTimeout);
    if (t.unref) t.unref();
    return once(m.provider || base.provider, m.model || base.model, text, ac.signal)
      .finally(() => clearTimeout(t));
  }));
  const ok = settled.map((r, i) => ({
    provider: models[i].provider || base.provider, model: models[i].model || base.model,
    ok: r.status === 'fulfilled', out: r.status === 'fulfilled' ? String(r.value).trim() : null,
    err: r.reason?.message
  })).filter(r => r.ok && r.out);
    for (const r of settled) if (r.status === 'rejected') console.error(`· 交叉[${kind}] 一路失败/超时: ${String(r.reason?.message || r.reason).slice(0, 80)}`);
  console.error(`· 交叉[${kind}] 成功 ${ok.length}/${models.length}: ${ok.map(r => r.provider).join('+')}`);
  if (!ok.length) throw new Error('交叉加强：所有模型都失败');
  if (ok.length === 1) return ok[0].out;
  const thr = cx.similarity ?? 0.82;
  const clusters = [];
  for (const r of ok) {
    const c = clusters.find(c => diceSim(normalizeTxt(c.reps[0].out), normalizeTxt(r.out)) >= thr);
    if (c) c.reps.push(r); else clusters.push({ reps: [r] });
  }
  clusters.sort((a, b) => b.reps.length - a.reps.length);
  if (clusters[0].reps.length >= 2) {
    const winners = clusters[0].reps.map(r => r.provider).join('+');
    console.error(`· 交叉[${kind}] 共识 ${clusters[0].reps.length}/${ok.length}（${winners}）`);
    return clusters[0].reps[0].out;
  }
  const ar = cx.arbiter || { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const labeled = ok.map((r, i) => `【候选${String.fromCharCode(65 + i)}｜来自${r.provider}】\n${r.out}`).join('\n\n');
  const out = await chat(cfg, ar.provider, ar.model, [
    { role: 'system', content: '多个模型对同一任务给出了不同结果。选出综合质量最高的一条；只输出该条原文（可修正明显错别字），不要解释，不要混合各条内容。' },
    { role: 'user', content: `任务：${kind === 'translate' ? '翻译' : '润色'}下面的文本。\n原文本：${text}\n\n${labeled}` }
  ], 0);
  console.error(`· 交叉[${kind}] 全分歧，${ar.provider}/${ar.model} 仲裁`);
  return out;
}

// ---- 翻译 ----
const LANGS = { en: '英语', ja: '日语', ko: '韩语', zh: '中文', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语' };
async function translateOnce(cfg, d, provider, model, text, to, signal) {
  const toName = LANGS[to] || to;
  const sys = [
    `你是专业翻译引擎。将用户文本翻译为${toName}。`,
    `专有名词保持原文不翻译：${(d.hotwords || []).join('、')}`,
    '只输出译文本身，不要解释、不要引号、不要注音。'
  ].join('\n');
  return chat(cfg, provider, model, [{ role: 'system', content: sys }, { role: 'user', content: text }], 0, signal);
}
async function translateText(text, to, { provider: pOv, model: mOv, cross = false } = {}) {
  const cfg = ensureInit();
  await activatePlugins(cfg);
  cross = cross || cfg._wfCross === true;
  const d = readJson(DICT);
  if (cross) return crossEnhance(cfg, 'translate', text, (p, m, t, sig) => translateOnce(cfg, d, p, m, t, to, sig));
  const base = pick(cfg, 'translate');
  const provider = pOv || base.provider, model = mOv || (pOv ? undefined : base.model);
  return translateOnce(cfg, d, provider, model, text, to);
}

// ---- 联网检索（无 key 引擎：Bing CN 直连 / DuckDuckGo 可走代理）----
const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ').replace(/&#0183;/g, '·').replace(/\s+/g, ' ').trim();
const curlGet = (url, { proxy, data } = {}) => {
  const args = ['-sL', '--max-time', '12', '-A', UA];
  if (proxy) args.push('-x', proxy);
  if (data) args.push('--data', data);
  args.push(url);
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
};
function searchBing(q, n) {
  const html = curlGet(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.max(n, 10)}&mkt=zh-CN`);
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    const snippetMatch = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: stripTags(m[2]), url: m[1], snippet: stripTags(snippetMatch?.[1] || '') });
  }
  return out;
}
function searchDdg(q, n, proxy) {
  const html = curlGet('https://html.duckduckgo.com/html/', { proxy, data: `q=${encodeURIComponent(q)}` });
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    let url = m[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    out.push({ title: stripTags(m[2]), url, snippet: stripTags(m[3]) });
  }
  return out;
}
async function webSearch(query, cfgAsk) {
  const engines = cfgAsk?.engines ?? ['bing', 'ddg'];
  const n = cfgAsk?.maxResults ?? 5;
  for (const eng of engines) {
    try {
      console.error(`· 检索[${eng}]: ${query}`);
      const rs = eng === 'bing' ? searchBing(query, n) : searchDdg(query, n, cfgAsk?.proxy);
      if (rs.length) return rs;
      console.error(`· 检索[${eng}] 零结果`);
    } catch (e) { console.error(`· 检索[${eng}] 失败: ${String(e.message).slice(0, 120)}`); }
  }
  return [];
}
async function askAnswer(question, { provider: pOv, model: mOv } = {}) {
  const cfg = ensureInit();
  await activatePlugins(cfg);
  const rs = await webSearch(question, cfg.ask);
  const base = pick(cfg, 'ask');
  const provider = pOv || base.provider, model = mOv || (pOv ? undefined : base.model);
  const src = rs.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  const sys = [
    '基于给定的搜索结果回答用户问题，用简体中文。',
    '优先使用搜索结果作答，引用来源用 [n] 标注（n 为结果编号）。',
    '搜索结果只覆盖部分问题时：用结果回答能覆盖的部分，其余用自身知识补全，并在补全句末标注【补充】。',
    '完全不相关时才说明检索无果。回答简洁、分点、直给结论。'
  ].join('\n');
  const user = rs.length
    ? `问题：${question}\n\n搜索结果：\n${src}`
    : `问题：${question}\n\n（本次未能联网检索到结果，请基于自身知识回答并注明未经联网核实。）`;
  return chat(cfg, provider, model, [{ role: 'system', content: sys }, { role: 'user', content: user }], 0);
}

// ---- 插入焦点应用（剪贴板 + Cmd+V）----
function insertText(text) {
  const cfg = ensureInit();
  if ((cfg.insert?.mode ?? 'paste') === 'none') { console.log(text); return; }
  execFileSync('pbcopy', { input: text, encoding: 'utf8' });
  execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
}

// ---- 统一管线 ----
async function finishPipeline(wavPath, { insert = true, raw = false, translateTo = null, askMode = false, provider = null, model = null, cross = false, app = null, force = false } = {}) {
  const cfg = ensureInit();
  await activatePlugins(cfg);
  let rawText = await asr(wavPath);
  const mode = askMode ? 'ask' : (translateTo ? `translate:${translateTo}` : (raw ? 'raw' : 'dictate'));
  const ctx = { mode, app, wavPath, cfg };
  rawText = await runHook('onTranscript', rawText, ctx) || rawText;
  if (rawText.trim().length === 0) {
    console.error('✗ 语音识别结果为空（纯静音或识别失败），已跳过');
    return;
  }
  const speech = rawText.replace(/[。，,.！!？?、；;：:\s()（）【】\[\]〔〕]/g, '');
  if (speech.length <= 1 && !force) {
    console.error('✗ 未识别到语音内容（录太短或纯静音），已跳过');
    return;
  }
  let out;
  if (askMode) out = await askAnswer(rawText, { provider, model });
  else if (translateTo) out = await translateText(applyDict(rawText), translateTo, { provider, model, cross });
  else if (raw) out = applyDict(rawText, app);
  else out = (await polish(rawText, { provider, model, cross, app })).text;
  out = await runHook('onPolish', String(out), ctx);
  out = await runHook('onInsert', out, ctx);
  console.error(`识别: ${rawText}\n结果: ${out}`);
  // 录音归档：每条听写的 wav 按 ts 存档（回放/重转写用），仅保留最近 200 条
  let rec;
  try {
    const recDir = path.join(DIR, 'recordings');
    fs.mkdirSync(recDir, { recursive: true });
    rec = path.join(recDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
    fs.copyFileSync(wavPath, rec);
    const old = fs.readdirSync(recDir).filter(f => f.endsWith('.wav'))
      .map(f => ({ f, t: fs.statSync(path.join(recDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of old.slice(200)) fs.rmSync(path.join(recDir, x.f), { force: true });
  } catch { /* 归档失败不阻塞主流程 */ }
  try {
    fs.appendFileSync(path.join(DIR, 'history.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), mode, app: app || undefined, raw: rawText.slice(0, 500), out: String(out).slice(0, 1000), inserted: insert, rec }) + '\n');
  } catch { /* 历史落盘失败不阻塞主流程 */ }
  if (insert) insertText(out); else console.log(out);
}

// ---- 学习引擎：智能 diff + 词库挖掘 ----
const PUNCT = /[，。,.！!？?、；;：:\s（）()【】\[\]""''""·—…\-]/g;
function tokenizeCn(text) {
  // 按标点分句 → 按空格分词 → 过滤短段
  return text.replace(PUNCT, ' ').split(/\s+/).filter(t => t.length >= 2);
}
function smartDiff(raw, corrected) {
  // 策略：先按标点/空白切句，对比每句找替换对
  const rawS = raw.replace(PUNCT, '|').split('|').filter(t => t.trim());
  const corS = corrected.replace(PUNCT, '|').split('|').filter(t => t.trim());
  const pairs = [];
  // 逐句对齐（简单：同位置句对比）
  const max = Math.max(rawS.length, corS.length);
  for (let i = 0; i < max; i++) {
    const r = (rawS[i] || '').trim(), c = (corS[i] || '').trim();
    if (!r || !c || r === c) continue;
    // 句内 token 级对比
    const rT = tokenizeCn(r), cT = tokenizeCn(c);
    const minT = Math.min(rT.length, cT.length);
    for (let j = 0; j < minT; j++) {
      if (rT[j] !== cT[j] && rT[j].length >= 1 && cT[j].length >= 1) {
        pairs.push({ from: rT[j], to: cT[j] });
      }
    }
  }
  // 整体兜底：如果没找到 token 级差异但整体不同，把全文作为一对
  if (!pairs.length && normalizeTxt(raw) !== normalizeTxt(corrected)) {
    pairs.push({ from: raw.trim(), to: corrected.trim() });
  }
  return pairs;
}
function mineCorrections() {
  // 从 feedback.jsonl 挖掘高频修正模式
  const fb = path.join(DIR, 'feedback.jsonl');
  if (!fs.existsSync(fb)) { console.log('（暂无反馈记录）'); return; }
  const patterns = {};
  for (const line of fs.readFileSync(fb, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      for (const p of e.pairs || []) {
        const key = `${p.from}→${p.to}`;
        patterns[key] = (patterns[key] || 0) + 1;
      }
    } catch {}
  }
  const sorted = Object.entries(patterns).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) { console.log('（暂无修正模式）'); return; }
  console.log('高频修正模式：');
  for (const [k, c] of sorted.slice(0, 10)) console.log(`  ${k} ×${c}`);
  console.log(`\n用 sayless dict add "${sorted[0][0].split('→')[0].trim()}" "${sorted[0][0].split('→')[1]?.trim()}" 加入词库`);
}
function saveDict(d) { fs.writeFileSync(DICT, JSON.stringify(d, null, 2)); }

// ---- CLI ----
const [, , cmd, ...rest] = process.argv;
const arg = (name, def) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def; };
const has = (name) => rest.includes(name);
const FLAGGED = new Set(['--sec', '-o', '--raw', '--no-insert', '--dry-run', '--translate', '--to', '--ask', '--say', '--provider', '--model', '--cross', '--workflow', '--force', '--app', '-n']);
const positional = () => rest.filter((v, i) => !FLAGGED.has(v) && !['--sec', '-o', '--translate', '--to', '--provider', '--model', '--app'].includes(rest[i - 1]));
const overrides = () => ({ provider: arg('--provider'), model: arg('--model') });

try {
  if (cmd === 'init') { ensureInit(); console.log(`配置就绪：${CFG}\n词语库：${DICT}\n多模型：providers 里配 key，llm/translate/ask 各选 provider+model`); }
  else if (cmd === 'rec') { ensureInit(); rec(arg('--sec') ? Number(arg('--sec')) : 0, arg('-o') || TMP_WAV); }
  else if (cmd === 'asr') { console.log(applyDict(await asr(positional()[0] || TMP_WAV))); }
  else if (cmd === 'polish') { const r = await polish(positional().join(' '), { dryRun: has('--dry-run'), cross: has('--cross'), ...overrides() }); console.log(r.text); }
  else if (cmd === 'translate') {
    let text = positional().join(' ');
    const to = arg('--to') || (ensureInit().translate?.to ?? 'en');
    if (has('--say') || !text) {
      ensureInit();
      rec(arg('--sec') ? Number(arg('--sec')) : 0, TMP_WAV);
      text = applyDict(await asr(TMP_WAV));
      console.error(`识别: ${text}`);
    }
    console.log(await translateText(text, to, { ...overrides(), cross: has('--cross') }));
  }
  else if (cmd === 'ask') {
    let q = positional().join(' ');
    if (has('--say') || !q) {
      ensureInit();
      rec(arg('--sec') ? Number(arg('--sec')) : 0, TMP_WAV);
      q = await asr(TMP_WAV);
      console.error(`识别: ${q}`);
    }
    console.log(await askAnswer(q, overrides()));
  }
  else if (cmd === 'transcribe') {
    await finishPipeline(positional()[0] || TMP_WAV, {
      insert: !has('--no-insert'), raw: has('--raw'), force: has('--force'),
      translateTo: has('--translate') ? (arg('--translate') || (ensureInit().translate?.to ?? 'en')) : null,
      askMode: has('--ask'), cross: has('--cross'), app: arg('--app') || null, ...overrides()
    });
  }
  else if (cmd === 'run') {
    ensureInit();
    rec(arg('--sec') ? Number(arg('--sec')) : 0, TMP_WAV);
    await finishPipeline(TMP_WAV, {
      insert: !has('--no-insert'), raw: has('--raw'),
      translateTo: has('--translate') ? (arg('--translate') || (ensureInit().translate?.to ?? 'en')) : null,
      askMode: has('--ask'), cross: has('--cross'), app: arg('--app') || null, ...overrides()
    });
  }
  else if (cmd === 'insert') { ensureInit(); insertText(positional().join(' ')); }
  else if (cmd === 'dict') {
    ensureInit();
    const save = (d) => fs.writeFileSync(DICT, JSON.stringify(d, null, 2));
    const d = readJson(DICT);
    const sub = rest[0];
    if (sub === 'add') {
      d.replacements.push({ from: rest[1], to: rest[2] }); save(d);
      console.log(`已加替换：${rest[1]} → ${rest[2]}`);
    } else if (sub === 'del') {
      const before = d.replacements.length;
      d.replacements = d.replacements.filter(r => r.from !== rest[1] && r.to !== rest[1]);
      save(d); console.log(`已删 ${before - d.replacements.length} 条含「${rest[1]}」的替换`);
    } else if (sub === 'add-hot') {
      d.hotwords = [...new Set([...(d.hotwords || []), rest[1]])]; save(d);
      console.log(`已加热词：${rest[1]}`);
    } else if (sub === 'del-hot') {
      d.hotwords = (d.hotwords || []).filter(w => w !== rest[1]); save(d);
      console.log(`已删热词：${rest[1]}`);
    } else if (sub === 'import') {
      // 批量导入候选：每行一个词条；「a => b」或「a→b」或「a<TAB>b」解析为替换，否则进热词
      const src = rest[1];
      const text = fs.readFileSync(src, 'utf8');
      let hot = 0, rep = 0;
      for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
        const m = line.match(/^(.+?)(?:\s*(?:=>|→|\t)\s*(.+))$/);
        if (m && m[2]) { d.replacements.push({ from: m[1].trim(), to: m[2].trim() }); rep++; }
        else { d.hotwords = [...new Set([...(d.hotwords || []), line])]; hot++; }
      }
      save(d); console.log(`导入完成：${rep} 条替换，${hot} 个热词`);
    } else if (sub === 'stats') {
      // 词频：扫 history.jsonl 的 out 字段统计热词出现次数
      const file = path.join(DIR, 'history.jsonl');
      const freq = {};
      let total = 0;
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const e = JSON.parse(line); const out = e.out || ''; total++;
            for (const w of d.hotwords || []) if (out.includes(w)) freq[w] = (freq[w] || 0) + 1;
          } catch {}
        }
      }
      console.log(`历史 ${total} 条，热词命中：`);
      for (const [w, c] of Object.entries(freq).sort((a, b) => b[1] - a[1])) console.log(`  ${w}: ${c} 次`);
      const unused = (d.hotwords || []).filter(w => !freq[w]);
      if (unused.length) console.log(`从未命中：${unused.join('、')}`);
    } else console.log(JSON.stringify(d, null, 2));
  }
  else if (cmd === 'history') {
    ensureInit();
    const n = Number(arg('-n') || 20);
    const file = path.join(DIR, 'history.jsonl');
    if (!fs.existsSync(file)) { console.log('(暂无历史)'); }
    else {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n);
      for (const l of lines.reverse()) {
        try { const e = JSON.parse(l); console.log(`${e.ts.replace('T', ' ').slice(0, 19)}  [${e.mode}]  ${(e.out || '').slice(0, 60)}`); } catch {}
      }
    }
  }
  else if (cmd === 'doctor') {
    const cfg = ensureInit();
    await activatePlugins(cfg);
    console.log(`ASR adapter: ${cfg.asr.adapter}${cfg.asr.adapter === 'whisper' ? ` (${cfg.asr.whisperBin}, ${fs.existsSync(cfg.asr.whisperModel) ? '模型OK' : '模型缺失!'})` : ''}`);
    console.log(`链路: LLM=${cfg.llm.provider}/${cfg.llm.model} · 翻译→${cfg.translate.to} (${cfg.translate.provider}) · 交叉投票=${(cfg.cross?.models || []).length}家 · 工作流=${cfg.activeWorkflow}`);
    const withKey = [], noKey = [];
    for (const [name, p] of Object.entries(cfg.providers || {})) {
      const key = p.apiKey || process.env.SAYLESS_API_KEY || '';
      (key ? withKey : noKey).push([name, p]);
    }
    if (noKey.length) console.log(`\n未配 key（仅注册，401=路由存在）:`);
    for (const [name, p] of noKey) {
      try {
        const r = await fetch(p.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: 'Bearer dummy' } });
        console.log(`  ${name}: HTTP ${r.status} ${r.status === 401 ? '(路由在，缺 key)' : r.status === 404 ? '(路由不存在)' : ''}`);
      } catch (e) { console.log(`  ${name}: 网络失败 ${e.cause?.code || e.message}`); }
    }
    if (withKey.length) console.log(`\n已配 key:`);
    for (const [name, p] of withKey) {
      try {
        const r = await fetch(p.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${p.apiKey}` } });
        console.log(`  ${name}: HTTP ${r.status} ${r.status < 300 ? '(key 有效)' : r.status === 401 ? '(key 无效!)' : r.status === 402 ? '(额度不足)' : r.status === 403 ? '(403 未开通/未实名)' : r.status === 404 ? '(端点无 /models，不代表 key 无效)' : ''}`);
      } catch (e) { console.log(`  ${name}: 网络失败 ${e.cause?.code || e.message}`); }
    }
    const { spawnSync } = await import('node:child_process');
    const d = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
    console.log('录音设备：\n' + (d.stderr || '').split('\n').filter(l => /\[\d+\] /.test(l)).slice(0, 6).join('\n'));
  }
  else if (cmd === 'plugin') {
    const cfg = ensureInit();
    const ps = await loadPlugins();
    if (!ps.length) { console.log('未安装插件。目录 ~/.sayless/plugins/，写 *.mjs 导出 onTranscript/onPolish/onInsert/providers/workflows 即可，见 PLUGINS.md。'); process.exit(0); }
    console.log(`已安装 ${ps.length} 个插件（~/.sayless/plugins/）：`);
    for (const l of pluginLog) console.log('  ' + l);
    process.exit(0);
  }
  else if (cmd === 'learn') {
    // 用法:
    //   sayless learn "识别错的" "改对的"     → 智能diff生成词条
    //   sayless learn --last "改对的全文"     → 拿上一条raw对比
    //   sayless learn --mine                 → 从历史挖掘高频修正模式
    ensureInit();
    const FB = path.join(DIR, 'feedback.jsonl');
    if (rest[0] === '--mine') { mineCorrections(); process.exit(0); }
    let rawText, corrected;
    if (rest[0] === '--last') {
      corrected = rest.slice(1).filter(a => !a.startsWith('-')).join(' ');
      // 取最近一条听写的 raw
      const hist = fs.existsSync(path.join(DIR, 'history.jsonl'))
        ? fs.readFileSync(path.join(DIR, 'history.jsonl'), 'utf8').trim().split('\n') : [];
      const lastLine = hist[hist.length - 1];
      if (!lastLine) { console.error('✗ 无历史'); process.exit(1); }
      rawText = JSON.parse(lastLine).raw || '';
    } else {
      rawText = rest[0] || '';
      corrected = rest.slice(1).filter(a => !a.startsWith('-')).join(' ');
    }
    if (!rawText || !corrected) { console.error('用法: sayless learn <raw> <corrected>'); process.exit(2); }
    const pairs = smartDiff(rawText, corrected);
    if (!pairs.length) { console.log('未发现差异'); process.exit(0); }
    const d = readJson(DICT);
    let added = 0;
    for (const pair of pairs) {
      if (pair.from.length < 1 || pair.from === pair.to) continue;
      const exists = (d.replacements || []).some(r => r.from === pair.from);
      if (!exists) { d.replacements.push({ from: pair.from, to: pair.to }); added++; }
      if (pair.to.length >= 2 && /[A-Z\u4e00-\u9fff]/.test(pair.to)) {
        d.hotwords = [...new Set([...(d.hotwords || []), pair.to])];
      }
    }
    saveDict(d);
    fs.appendFileSync(path.join(DIR, 'feedback.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), raw: rawText.slice(0, 300), corrected: corrected.slice(0, 300), pairs, added }) + '\n');
    console.log(`学习完成：${pairs.length} 处差异 → ${added} 条新替换规则`);
    for (const p2 of pairs) console.log(`  ${p2.from} → ${p2.to}`);
  }
  else { console.error('命令: init | run | rec | asr | polish | translate [--to en] | ask | transcribe | insert | dict | learn | history [-n] | plugin | doctor'); process.exit(cmd ? 2 : 0); }
} catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
