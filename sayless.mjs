#!/usr/bin/env node
// sayless — 本地优先的听写管线（自研实现）：录音 → ASR → 词语库/LLM → 翻译/问答 → 插入焦点应用
// 多模型供应商注册表 + 翻译 + 联网信息检索 + 交叉投票。代码全新编写，不含任何第三方应用代码。
//
// 用法:
//   sayless init                          生成/补全 ~/.sayless/{config.json,dictionary.json}
//   sayless run [--sec N] [--no-insert] [--raw] [--translate <lang>] [--ask] [--workflow <id>] [--cross]
//   sayless rec  [--sec N] [-o file]      仅录音（wav 16k mono）
//   sayless asr  <file.wav>               仅转写（走当前 ASR 适配器）
//   sayless polish "<text>" [--dry-run] [--cross] [--provider <id>] [--model <id>]
//   sayless translate "<text>" [--to en] [--say] [--cross]
//   sayless ask "<问题>" [--say] [--no-search]  联网检索+回答（带引用）；--say 先录音
//   sayless transcribe <wav> [--translate <lang>] [--ask] [--no-insert] [--raw] [--force] [--app <name>]
//   sayless insert "<text>"               粘贴进焦点应用
//   sayless dict add|del|add-hot|del-hot|import|stats|...    词语库管理
//   sayless learn "<原文>" "<改稿>"        智能 diff 生成词条；--last 对比上一条；--mine 挖掘高频模式
//   sayless history [-n 20] [--json] [--search q] [--delete n|ts] [--clear --force] [--export file]
//   sayless stats [--json]                听写数据统计
//   sayless plugin                        已加载插件及钩子
//   sayless doctor [--offline] [--json]   体检：ASR/链路/供应商分组实测/录音设备
// 配置: ~/.sayless/config.json；providers 注册各模型供应商，llm/translate/ask 各自选 provider+model。
// 环境变量: SAYLESS_DIR 覆盖数据目录；SAYLESS_API_KEY 作为未配 provider key 时的兜底；SAYLESS_FFMPEG / SAYLESS_AUDIO_DEVICE。
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const [nmaj] = process.versions.node.split('.').map(Number);
if (nmaj < 18) { console.error(`✗ sayless 需要 Node 18+（当前 ${process.versions.node}）：brew install node 或升级`); process.exit(1); }

const VERSION = '4.9.0';
const DIR = process.env.SAYLESS_DIR ? path.resolve(process.env.SAYLESS_DIR) : path.join(os.homedir(), '.sayless');
const CFG = path.join(DIR, 'config.json');
const DICT = path.join(DIR, 'dictionary.json');
const HISTORY = path.join(DIR, 'history.jsonl');
const FEEDBACK = path.join(DIR, 'feedback.jsonl');
const REC_DIR = path.join(DIR, 'recordings');
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
    minimax: { baseUrl: 'https://api.minimaxi.com/v1', chatPath: '/text/chatcompletion_v2', model: 'MiniMax-M3' },
    zai: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5-turbo' },
    'qwen-plan': { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
    siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1' },
    moonshot: { baseUrl: 'https://api.moonshot.cn/v1' },
    zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    kimi: { baseUrl: 'https://api.kimi.com/coding/v1' }, // Kimi for Coding（sk-kimi- key 专用端点）
    stepfun: { baseUrl: 'https://api.stepfun.com/v1' },
    // 套餐通道：同一把 Step API Key，但额度走 /step_plan 专用地址（与按量余额独立）
    'stepfun-plan': { baseUrl: 'https://api.stepfun.com/step_plan/v1' },
    mimo: { baseUrl: 'https://api.xiaomimimo.com/v1' },
    // Token Plan 套餐通道：tp- 前缀 key + 专属域名（额度独立于按量现金余额）
    'mimo-plan': { baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' }
  },
  asr: {
    // adapter: whisper（本地，离线）| mimo-asr（MiMo Token Plan 云端，套餐额度计费）| ark-ws（方舟 Agent Plan 语音，需开按量扣费）| openai（OpenAI 兼容 REST）
    adapter: 'whisper',
    whisperBin: '/opt/homebrew/bin/whisper-cli',
    whisperModel: path.join(DIR, 'ggml-base.bin'),
    wsUrl: 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-asr-2-0',
    language: 'zh',
    filterHallucinations: true
  },
  llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628', temperature: 0, retries: 2, timeoutMs: 45000 },
  translate: { to: 'en', provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' },
  ask: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628', engines: ['bing', 'ddg'], maxResults: 5, proxy: '' },
  // 交叉加强：多模型并行出稿 → 相似度聚类 → 多数一致取胜，全分歧时仲裁模型裁决
  cross: {
    models: [
      { provider: 'zai', model: 'glm-5-turbo' },
      { provider: 'deepseek', model: 'deepseek-flash' },
      { provider: 'minimax', model: 'MiniMax-M3' },
      { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' },
      { provider: 'mimo-plan', model: 'mimo-v2.6-flash' }
    ],
    arbiter: { provider: 'deepseek', model: 'deepseek-v4-flash-ga-260910' },
    similarity: 0.82,
    timeoutMs: 30000 // 归一化后字符二元组 Dice 系数阈值，>= 视为一致
  },
  rec: { ffmpeg: '', device: ':0' },
  recordings: { keep: 200 },
  insert: { mode: 'paste', restoreClipboard: true },
  // 工作流预设：切换整套模型组合
  workflows: {
    fast:   { llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' }, cross: false },
    quality:{ llm: { cross: true }, cross: true },
    cloud:  { asr: 'ark-ws', llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-pro-260915' }, cross: true }
  },
  activeWorkflow: 'fast',
  hotkeys: {
    dictate: { key: 49, modifier: 'option', label: 'Space' },
    translate: { key: 17, modifier: 'option', label: 'T' },
    ask: { key: 12, modifier: 'option', label: 'Q' }
  }
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

const HELP = `sayless ${VERSION} — 本地优先的听写管线

用法:
  sayless <命令> [参数]

核心:
  init                         生成/补全 ~/.sayless 配置与词语库
  run [--sec N] [--raw]        录音 → 转写 → 润色 → 粘贴（--sec 定长，默认按 Enter 停止）
  rec [--sec N] [-o file]      仅录音（16k mono wav）
  asr <file.wav>               仅转写（当前 ASR 适配器）
  transcribe <wav>             对已有音频跑完整管线
  polish "<text>" [--dry-run]  只润色（--dry-run 只过词语库，不发网络请求）
  translate "<text>" --to ja   翻译（--say 先录音）
  ask "<问题>" [--no-search]   联网检索 + 带引用回答（--say 先录音）
  insert "<text>"              粘贴任意文本到焦点应用

数据:
  history [-n 20] [--json] [--search q] [--delete n|ts] [--clear --force] [--export file]
  stats [--json]               口述字数/条数/活跃天/连续天/模式分布
  dict <add|del|add-hot|del-hot|import|stats|export|...>
  learn "<原文>" "<改稿>"      智能 diff 生成词条；--last、--mine [--apply]
  plugin                       已加载插件及钩子
  doctor [--offline] [--json]  体检：ASR/链路/供应商/录音设备
  devices                      列出 avfoundation 录音设备

通用旗标:
  --provider <id>  --model <id>  --workflow <id>  --cross
  --app <name>  --json  --force  --no-insert

环境变量:
  SAYLESS_DIR=~/.sayless        覆盖数据目录
  SAYLESS_API_KEY=...           未配置 provider key 时的兜底
  SAYLESS_FFMPEG / SAYLESS_AUDIO_DEVICE  覆盖录音命令与设备

示例:
  sayless init && sayless run
  sayless polish "那个我们明天十点开个会" --cross
  sayless translate "今天天气不错" --to en
  sayless history -n 10 --json
  sayless doctor --offline
`;

// ---- 通用工具 ----
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
function fail(message, exitCode = 1) {
  const e = new Error(message);
  e.exitCode = exitCode;
  throw e;
}
const warn = (msg) => console.error(`· ${msg}`);
const oneLine = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const expandHome = (p) => {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
};
function writeFileAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* 非 POSIX 环境忽略 */ }
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}
function readJsonFile(file, label = path.basename(file)) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') fail(`未找到 ${label}：${file}\n  先运行 sayless init`, 2);
    fail(`读取 ${label} 失败：${e.message}`, 2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${label} 解析失败（${e.message}）\n  文件：${file}\n  修复 JSON 后再试（可先备份该文件）`, 2);
  }
}
function fileMode(file) {
  try { return (fs.statSync(file).mode & 0o777).toString(8); } catch { return null; }
}
function which(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  try { return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
// 这些字段缺省表示“用 provider 默认模型”；迁移时不能塞回默认 Ark 模型。
const SKIP_DEFAULT_FILL = new Set(['llm.model', 'translate.model', 'ask.model', 'cross.arbiter.model']);
function fillDefaults(dst, src, pathParts = []) {
  let dirty = false;
  for (const [k, v] of Object.entries(src)) {
    const parts = pathParts.concat(k);
    if (dst[k] === undefined) {
      if (SKIP_DEFAULT_FILL.has(parts.join('.'))) continue;
      dst[k] = clone(v);
      dirty = true;
    } else if (isObj(dst[k]) && isObj(v)) {
      if (fillDefaults(dst[k], v, parts)) dirty = true;
    }
  }
  return dirty;
}

// ---- 配置 ----
function applyWorkflow(cfg, explicit = false, warnMissing = true) {
  const requested = cfg._workflow || cfg.activeWorkflow;
  let wf = cfg.workflows?.[requested];
  if (!wf) {
    // 显式 --workflow 可能来自尚未加载的插件：先不应用，等 activatePlugins 注册后再解析。
    // 不能在这里回退 activeWorkflow，否则会把 cloud 的 ASR/模型泄漏到 plugin workflow 上。
    if (cfg._workflow) {
      if (warnMissing) warn(`未知工作流「${requested}」`);
      return;
    }
    wf = cfg.workflows?.[cfg.activeWorkflow || 'fast'];
  }
  if (!isObj(wf)) return;
  // 持久 activeWorkflow 只决定「是否交叉投票」这类策略；
  // 模型 / ASR / 翻译 / 问答以设置页的顶层配置为准，避免旧版 workflow 静默覆盖用户选择。
  // 只有显式 `sayless ... --workflow <id>` 才把预设里的整套模型组合一次性应用。
  if (typeof wf.cross === 'boolean') cfg._wfCross = wf.cross;
  if (!explicit) return;
  if (wf.asr) {
    cfg.asr = { ...(cfg.asr || {}), ...(isObj(wf.asr) ? wf.asr : { adapter: wf.asr }) };
  }
  if (isObj(wf.llm)) {
    cfg.llm = { ...(cfg.llm || {}) };
    for (const k of ['provider', 'model', 'temperature']) if (wf.llm[k] !== undefined) cfg.llm[k] = wf.llm[k];
  }
  for (const sec of ['translate', 'ask']) {
    if (isObj(wf[sec])) cfg[sec] = { ...(cfg[sec] || {}), ...wf[sec] };
  }
}

function ensureInit() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(DIR, 0o700); } catch { /* ignore */ }
  let dirty = false;
  if (!fs.existsSync(CFG)) {
    writeFileAtomic(CFG, JSON.stringify(DEFAULT_CFG, null, 2), 0o600);
    dirty = false;
  }
  if (!fs.existsSync(DICT)) writeFileAtomic(DICT, JSON.stringify(DEFAULT_DICT, null, 2), 0o600);
  const cfg = readJsonFile(CFG, 'config.json');
  if (!isObj(cfg)) fail(`config.json 顶层必须是对象：${CFG}`, 2);
  if (fillDefaults(cfg, DEFAULT_CFG)) dirty = true;
  if (!isObj(cfg.providers)) { cfg.providers = clone(DEFAULT_CFG.providers); dirty = true; }
  if (!isObj(cfg.asr)) cfg.asr = clone(DEFAULT_CFG.asr), dirty = true;
  if (!isObj(cfg.llm)) cfg.llm = clone(DEFAULT_CFG.llm), dirty = true;
  if (!isObj(cfg.translate)) cfg.translate = clone(DEFAULT_CFG.translate), dirty = true;
  if (!isObj(cfg.ask)) cfg.ask = clone(DEFAULT_CFG.ask), dirty = true;
  if (!isObj(cfg.cross)) cfg.cross = clone(DEFAULT_CFG.cross), dirty = true;
  if (!isObj(cfg.workflows)) cfg.workflows = clone(DEFAULT_CFG.workflows), dirty = true;
  // 清掉旧版本可能误写进 config 的 _workflow；本次 --workflow 只在内存里生效。
  if (Object.prototype.hasOwnProperty.call(cfg, '_workflow')) { delete cfg._workflow; dirty = true; }
  const wi = flagArgv.indexOf('--workflow');
  const wfOverride = wi >= 0 && flagArgv[wi + 1] && !flagArgv[wi + 1].startsWith('-') ? flagArgv[wi + 1] : null;
  if (dirty) writeFileAtomic(CFG, JSON.stringify(cfg, null, 2), 0o600);
  try { fs.chmodSync(CFG, 0o600); } catch { /* ignore */ }
  if (wfOverride) cfg._workflow = wfOverride;
  applyWorkflow(cfg, !!cfg._workflow, false);
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
let pluginsActive = false;
async function loadPlugins() {
  if (pluginsCache) return pluginsCache;
  pluginsCache = [];
  const dir = path.join(DIR, 'plugins');
  if (!fs.existsSync(dir)) return pluginsCache;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      pluginsCache.push({ file: f, ...mod });
      const hooks = ['providers', 'workflows', 'onTranscript', 'onPolish', 'onInsert'].filter(k => mod[k] != null);
      pluginLog.push(`插件 ${f}：${hooks.join(', ') || '（无导出钩子）'}`);
    } catch (e) {
      pluginLog.push(`插件 ${f} 加载失败：${e.message}`);
    }
  }
  return pluginsCache;
}
async function activatePlugins(cfg) {
  const ps = await loadPlugins();
  if (!pluginsActive) {
    pluginsActive = true;
    for (const l of pluginLog) console.error(`· ${l}`);
    if (ps.length) console.error(`· 已加载 ${ps.length} 个插件`);
  }
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
  applyWorkflow(cfg, !!cfg._workflow, true);
  return ps;
}
async function runHook(hook, text, ctx) {
  let t = text;
  for (const p of await loadPlugins()) {
    if (typeof p[hook] !== 'function') continue;
    try {
      const r = await p[hook](t, ctx);
      if (typeof r === 'string') t = r;
    } catch (e) {
      console.error(`· 插件 ${p.file}.${hook} 出错：${e.message}`);
    }
  }
  return t;
}

// ---- 词语库（确定性，零云端；支持分应用词层）----
function readDictDoc() {
  const d = readJsonFile(DICT, 'dictionary.json');
  if (!isObj(d)) fail(`dictionary.json 顶层必须是对象：${DICT}`, 2);
  return d;
}
function validReplacements(list) {
  const out = [];
  let warned = false;
  for (const r of Array.isArray(list) ? list : []) {
    if (!isObj(r)) continue;
    if (typeof r.pattern === 'string' && r.pattern) {
      if (typeof r.to !== 'string') {
        if (!warned) { warn(`dictionary.json 里有缺 to 的正则规则，已跳过：${r.pattern}`); warned = true; }
        continue;
      }
      try { new RegExp(r.pattern); } catch {
        if (!warned) { warn(`dictionary.json 里有无效正则，已跳过：${r.pattern}`); warned = true; }
        continue;
      }
      out.push(r);
    } else if (typeof r.from === 'string' && r.from && typeof r.to === 'string') {
      out.push(r);
    }
  }
  return out;
}
function loadDict(app) {
  const d = readDictDoc();
  const layers = [d];
  if (app) {
    const apps = isObj(d.apps) ? d.apps : {};
    const key = Object.keys(apps).find(k => k === app || k.toLowerCase() === String(app).toLowerCase());
    if (key && isObj(apps[key])) layers.push(apps[key]);
  }
  return {
    replacements: layers.flatMap(l => validReplacements(l.replacements)),
    hotwords: [...new Set(layers.flatMap(l => Array.isArray(l.hotwords) ? l.hotwords.filter(w => typeof w === 'string' && w) : []))],
    styleRules: layers.flatMap(l => Array.isArray(l.styleRules) ? l.styleRules.filter(r => typeof r === 'string' && r) : []),
    app: app || undefined
  };
}
function applyDict(text, app) {
  const d = loadDict(app);
  let out = String(text ?? '');
  for (const r of d.replacements) {
    try {
      // 用函数式替换，避免 to 里的 $& / $1 被当成替换模式
      if (r.pattern) out = out.replace(new RegExp(r.pattern, 'g'), () => r.to);
      else if (r.from) out = out.split(r.from).join(r.to);
    } catch (e) {
      warn(`词典规则执行失败（${r.pattern || r.from}）：${e.message}`);
    }
  }
  return out;
}

// ---- 供应商注册表 + 通用 chat ----
function resolveProvider(cfg, name) {
  const raw = (cfg.providers || {})[name] || {};
  if (!raw.baseUrl) throw new Error(`未知 provider 或缺少 baseUrl：${name}（检查 config.json 的 providers）`);
  const key = raw.apiKey || process.env.SAYLESS_API_KEY;
  if (!key) throw new Error(`provider ${name} 缺 apiKey（设置页写入或 config.json）`);
  return { ...raw, name, baseUrl: String(raw.baseUrl).replace(/\/$/, ''), apiKey: key };
}
function isRetryableError(e) {
  if (e?.retryable === false) return false;
  const s = e?.status;
  return !s || s === 408 || s === 409 || s === 425 || s === 429 || s >= 500;
}
async function chatOnce(cfg, providerName, p, model, messages, temperature, signal) {
  let res;
  try {
    res = await fetch(p.baseUrl + (p.chatPath || '/chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, temperature, messages })
    });
  } catch (e) {
    if (signal?.aborted) throw signal.reason || e;
    const err = new Error(`LLM 网络错误（${providerName}/${model}）：${e.cause?.code || e.message}`);
    err.retryable = true;
    throw err;
  }
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`LLM ${res.status} (${providerName}/${model}): ${oneLine(body, 300)}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw err;
  }
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    const err = new Error(`LLM 响应不是 JSON（${providerName}/${model}）：${oneLine(body, 200)}`);
    err.retryable = false;
    throw err;
  }
  const out = (j.choices?.[0]?.message?.content ?? '').trim();
  if (!out) throw new Error(`LLM 空响应（${providerName}/${model}）：${oneLine(body, 160)}`);
  return out;
}
async function chat(cfg, providerName, model, messages, temperature = 0, signal) {
  const p = resolveProvider(cfg, providerName);
  const m = model || p.model;
  if (!m) throw new Error(`provider ${providerName} 未指定 model：请在设置页填写，或在 config.providers.${providerName}.model 配置默认值`);
  const retries = Number.isFinite(Number(cfg.llm?.retries)) ? Math.max(0, Number(cfg.llm.retries)) : 2;
  const timeoutMs = Number(cfg.llm?.timeoutMs) > 0
    ? Number(cfg.llm.timeoutMs)
    : (Number(cfg.cross?.timeoutMs) > 0 ? Number(cfg.cross.timeoutMs) + 15000 : 45000);
  // 统一超时 + 外部 signal 合并（Node 18 没有 AbortSignal.any）
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal.reason || new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(new Error(`LLM 超时 ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await chatOnce(cfg, providerName, p, m, messages, temperature, ac.signal);
      } catch (e) {
        if (!isRetryableError(e) || attempt >= retries || ac.signal.aborted) throw e;
        const wait = Math.min(5000, Math.max(300, (e.retryAfter || 0) * 1000 || 300 * (2 ** attempt)))
          + Math.floor(Math.random() * 200);
        console.error(`· LLM ${providerName}/${m} 第 ${attempt + 1} 次失败（${oneLine(e.message, 120)}），${wait}ms 后重试`);
        await sleep(wait, ac.signal);
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const pick = (cfg, section) => {
  const s = cfg[section] || {};
  const fallback = cfg.llm || {};
  // translate / ask 的模型只取自己的配置；缺失或空串都表示使用该 provider 的默认模型。
  // polish/llm 才允许沿用 cfg.llm.model。
  const model = (section === 'translate' || section === 'ask')
    ? (s.model || '')
    : (s.model === undefined ? (fallback.model || '') : s.model);
  return { provider: s.provider || fallback.provider, model };
};

// ---- 录音（ffmpeg avfoundation，默认麦克风 :0）----
function ffmpegBin(cfg) {
  return process.env.SAYLESS_FFMPEG || expandHome(cfg.rec?.ffmpeg) || which('ffmpeg') || 'ffmpeg';
}
function audioDevice(cfg) {
  return process.env.SAYLESS_AUDIO_DEVICE || cfg.rec?.device || ':0';
}
function rec(seconds, outFile, cfg = ensureInit()) {
  return new Promise((resolve, reject) => {
    if (Number.isFinite(seconds) && seconds < 0) {
      return reject(Object.assign(new Error('--sec 不能为负数'), { exitCode: 2 }));
    }
    if (!seconds && !process.stdin.isTTY) {
      return reject(Object.assign(new Error('非交互环境请用 --sec N 指定录音时长'), { exitCode: 2 }));
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
    // 录制期间就保持 0600：共享目录里的 -o 文件不能在成功前暴露为 0644
    try {
      fs.writeFileSync(outFile, Buffer.alloc(0), { mode: 0o600 });
      fs.chmodSync(outFile, 0o600);
    } catch (e) {
      warn(`无法预创建录音文件：${e.message}`);
    }
    const bin = ffmpegBin(cfg);
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', audioDevice(cfg), '-ar', '16000', '-ac', '1', '-y'];
    if (seconds) args.push('-t', String(seconds));
    args.push(outFile);
    let p;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      return reject(Object.assign(new Error(`启动录音失败（${bin}）：${e.message}`), { exitCode: 3 }));
    }
    console.error(`● 录音中${seconds ? `（${seconds}s）` : '，按 Enter 停止'}…`);
    const err = [];
    let settled = false;
    let stopping = false;
    let rl;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try { p.kill('SIGINT'); } catch { /* ignore */ }
    };
    if (!seconds) {
      rl = readline.createInterface({ input: process.stdin });
      rl.once('line', stop);
    }
    const onSig = () => stop();
    process.once('SIGINT', onSig);
    const cleanup = () => {
      try { rl?.close(); } catch { /* ignore */ }
      process.removeListener('SIGINT', onSig);
    };
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error(`录音启动失败（${bin}）：${e.message}`), { exitCode: 3 }));
    });
    p.on('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      let size = 0;
      try { size = fs.statSync(outFile).size; } catch { /* ignore */ }
      try { fs.chmodSync(outFile, 0o600); } catch { /* ignore */ }
      if (size > 1000) {
        try { fs.chmodSync(outFile, 0o600); } catch { /* ignore */ }
        console.error(`■ 完成 → ${outFile}`);
        return resolve(outFile);
      }
      const tail = err.join('').split('\n').filter(Boolean).slice(-3).join('\n');
      reject(Object.assign(new Error(`录音失败 (code=${code})。首次使用需在 系统设置→隐私与安全性→麦克风 授权终端/ffmpeg。${tail ? `\n${tail}` : ''}`), { exitCode: 3 }));
    });
  });
}
function listAudioDevices(cfg = ensureInit()) {
  const bin = ffmpegBin(cfg);
  const r = spawnSync(bin, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8', timeout: 6000 });
  const lines = String(r.stderr || '').split('\n').filter(l => /\[\d+\]/.test(l));
  const audioAt = lines.findIndex(l => /audio devices/i.test(l));
  return audioAt >= 0 ? lines.slice(audioAt + 1) : lines;
}

// ---- ASR ----
const HALLUCINATION = [
  /^\[?(blank[ _-]?audio|music|silence|inaudible)\]?$/i,
  /^[（(【\[]?(音乐|掌声|静音|空白音频)[）)】\]]?$/,
  /^(谢谢观看|感谢观看|请不吝点赞|订阅频道|字幕由.{0,20}提供)[。.!！]?$/
];
function cleanAsrText(text, cfg) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (cfg.asr?.filterHallucinations !== false) {
    if (HALLUCINATION.some(re => re.test(t))) return '';
    if (/^[（(【\[〔].*[）)\]〕]$/.test(t)) return '';
  }
  return t;
}
const ASR_ADAPTERS = new Set(['whisper', 'mimo-asr', 'ark-ws', 'openai']);
async function asr(wavPath, cfg = ensureInit()) {
  if (!fs.existsSync(wavPath)) fail(`音频不存在：${wavPath}`, 2);
  const adapter = cfg.asr?.adapter || 'whisper';
  if (!ASR_ADAPTERS.has(adapter)) {
    fail(`未知 ASR adapter「${adapter}」：只支持 whisper / mimo-asr / ark-ws / openai（拒绝把音频发到不确定的端点）`, 2);
  }
  if (adapter === 'whisper') {
    const modelPath = expandHome(cfg.asr.whisperModel || '');
    const binCfg = expandHome(cfg.asr.whisperBin) || '';
    const bin = binCfg
      ? (binCfg.includes('/') ? binCfg : which(binCfg))
      : which('whisper-cli');
    if (!bin || !fs.existsSync(bin)) {
      fail(`whisper 可执行文件缺失：${cfg.asr.whisperBin}\n  brew install whisper-cpp  或在设置页切换 ASR 引擎`, 3);
    }
    if (!modelPath || !fs.existsSync(modelPath)) {
      fail(`whisper 模型缺失：${modelPath || '(未配置)'}\n  下载：mkdir -p ~/.sayless && curl -L -o ~/.sayless/ggml-base.bin \\\n        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin\n  （网络不畅可把域名换成 hf-mirror.com 镜像；也可以在设置页把 ASR 引擎切成 MiMo 云端）`, 3);
    }
    if (fs.statSync(wavPath).size < 20000) { warn('音频过短（<0.6s），跳过识别'); return ''; }
    let out;
    try {
      out = execFileSync(bin, ['-m', modelPath, '-l', cfg.asr.language || 'zh', '-nt', '-np', '-f', wavPath],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      fail(`whisper 转写失败：${String(e.message).split('\n')[0]}`, 3);
    }
    return cleanAsrText(out, cfg);
  }
  if (adapter === 'mimo-asr') {
    // MiMo 云端语音识别：chat 接口 + input_audio base64（非 /audio/transcriptions 端点）。
    // 地址与 key 优先取 providers.mimo-plan（套餐 tp- key + 专属域名），asr.* 仅作回退；
    // 模型名只认 mimo- 开头，避免把其他厂商的 asr.model 带进来。切 adapter 改 asr.adapter 一个字段即可。
    const plan = cfg.providers?.['mimo-plan'] || {};
    const mk = plan.apiKey || cfg.asr.apiKey || process.env.SAYLESS_API_KEY;
    const base = String(plan.baseUrl || cfg.asr.baseUrl || '').replace(/\/$/, '');
    if (!mk || !base) fail('mimo-asr 缺配置：providers.mimo-plan 的 baseUrl/apiKey 或 asr.baseUrl/apiKey', 2);
    const model = String(cfg.asr.model || '').startsWith('mimo-') ? cfg.asr.model : 'mimo-v2.5-asr';
    const b64 = fs.readFileSync(wavPath).toString('base64');
    let res, t;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mk}` },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${b64}` } }] }],
          asr_options: { language: cfg.asr.language || 'zh' }
        })
      });
      t = await res.text();
    } catch (e) {
      fail(`ASR 网络错误（mimo-asr）：${e.cause?.code || e.message}`, 3);
    }
    if (!res.ok) fail(`ASR ${res.status}: ${oneLine(t, 400)}`, 3);
    let j;
    try { j = JSON.parse(t); } catch { fail(`ASR 响应不是 JSON：${oneLine(t, 200)}`, 3); }
    return cleanAsrText(j.choices?.[0]?.message?.content ?? '', cfg);
  }
  // ark-ws：Agent Plan 语音 key 可以写在 asr.apiKey，也可以写在 providers.ark-plan；
  // 与 resolveProvider 一致：显式配置优先，SAYLESS_API_KEY 只做兜底。
  const plan = cfg.providers?.['ark-plan'] || {};
  const key = cfg.asr.apiKey || plan.apiKey || process.env.SAYLESS_API_KEY;
  if (adapter === 'ark-ws') {
    if (!key) fail('ark-ws 缺 apiKey：写 asr.apiKey 或 providers.ark-plan.apiKey', 2);
    const { arkAsr } = await import(new URL('asr-ark-ws.mjs', import.meta.url));
    try {
      const text = await arkAsr({ apiKey: key, wavPath, wsUrl: cfg.asr.wsUrl, onLog: m => console.error(`· ${m}`) });
      return cleanAsrText(text, cfg);
    } catch (e) {
      fail(`ark-ws ASR 失败：${e.message}`, 3);
    }
  }
  if (!key) fail('缺 apiKey：export SAYLESS_API_KEY=... 或写进 config.json', 2);
  if (!cfg.asr.baseUrl) fail('openai ASR 缺 asr.baseUrl（config.json 的 asr）', 2);
  const url = String(cfg.asr.baseUrl).replace(/\/$/, '') + '/audio/transcriptions';
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wavPath)]), path.basename(wavPath), { type: 'audio/wav' });
  form.append('model', cfg.asr.model || 'whisper-1');
  if (cfg.asr.language) form.append('language', cfg.asr.language);
  let res, body;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(90000)
    });
    body = await res.text();
  } catch (e) {
    fail(`ASR 网络错误（openai）：${e.cause?.code || e.message}`, 3);
  }
  if (!res.ok) fail(`ASR ${res.status}: ${oneLine(body, 400)}`, 3);
  let j;
  try { j = JSON.parse(body); } catch { fail(`ASR 响应不是 JSON：${oneLine(body, 200)}`, 3); }
  const text = j.text ?? j.output?.text ?? (typeof j.output === 'string' ? j.output : '');
  return cleanAsrText(text, cfg);
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
  return applyDict(out, d.app);
}
async function polish(text, { dryRun = false, provider: pOv, model: mOv, cross = false, app = null, cfg: cfgIn = null } = {}) {
  const cfg = cfgIn || ensureInit();
  await activatePlugins(cfg);
  cross = cross || cfg._wfCross === true;
  const d = loadDict(app);
  text = applyDict(text, app);
  if (dryRun) return { text, applied: 'dict-only(dry-run)' };
  if (cross) {
    const out = await crossEnhance(cfg, 'polish', text, (p, m, t, sig) => polishOnce(cfg, d, p, m, applyDict(t), sig));
    return { text: applyDict(out, app), applied: 'cross-consensus' };
  }
  const base = pick(cfg, 'llm');
  const provider = pOv || base.provider, model = mOv || (pOv ? undefined : base.model);
  return { text: await polishOnce(cfg, d, provider, model, text), applied: `dict→${provider}/${model || '(默认)'}→dict` };
}

// ---- 交叉加强：并行 fanout → 相似度聚类 → 多数共识 / 仲裁裁决 ----
const normalizeTxt = (s) => String(s).replace(/\s+/g, '').replace(/[，。,.!?！？；;：:、""''（）()【】\[\]—…·]/g, '').toLowerCase();
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
function pickMedoid(cluster) {
  if (cluster.length <= 1) return cluster[0];
  let best = cluster[0], bestScore = -1;
  for (const c of cluster) {
    let score = 0;
    for (const o of cluster) if (o !== c) score += diceSim(normalizeTxt(c.out), normalizeTxt(o.out));
    score /= Math.max(1, cluster.length - 1);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}
async function crossEnhance(cfg, kind, text, once) {
  const cx = cfg.cross || {};
  const seen = new Set();
  const models = (cx.models || []).filter(m => {
    if (!isObj(m)) return false;
    const key = `${m.provider || ''}/${m.model || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (models.length < 2) {
    warn(`交叉投票需要至少 2 个不同模型，当前 ${models.length} 个，退回单模型`);
    const b = pick(cfg, kind);
    return once(b.provider, b.model, text);
  }
  const t0 = Date.now();
  const base = pick(cfg, kind);
  const perCallTimeout = Number(cx.timeoutMs) > 0 ? Number(cx.timeoutMs) : 45000;
  const settled = await Promise.allSettled(models.map(m => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error(`超时 ${perCallTimeout}ms`)), perCallTimeout);
    if (t.unref) t.unref();
    return Promise.resolve()
      .then(() => {
        // 行内有 provider 时，空 model 表示用该 provider 的默认模型；只有 provider 也缺省才回落到 base.model
        const provider = m.provider || base.provider;
        const model = m.model || (m.provider ? undefined : base.model);
        return once(provider, model, text, ac.signal);
      })
      .finally(() => clearTimeout(t));
  }));
  const ok = settled.map((r, i) => ({
    provider: models[i].provider || base.provider, model: models[i].model || base.model,
    ok: r.status === 'fulfilled', out: r.status === 'fulfilled' ? String(r.value).trim() : null,
    err: r.reason?.message
  })).filter(r => r.ok && r.out);
  for (const r of settled) if (r.status === 'rejected') console.error(`· 交叉[${kind}] 一路失败/超时: ${oneLine(r.reason?.message || r.reason, 100)}`);
  console.error(`· 交叉[${kind}] 成功 ${ok.length}/${models.length}: ${ok.map(r => r.provider).join('+')}`);
  if (!ok.length) throw new Error('交叉加强：所有模型都失败');
  if (ok.length === 1) return ok[0].out;
  const thr = Number(cx.similarity) >= 0 && Number(cx.similarity) <= 1 ? Number(cx.similarity) : 0.82;
  const clusters = [];
  for (const r of ok) {
    const c = clusters.find(c => diceSim(normalizeTxt(c.reps[0].out), normalizeTxt(r.out)) >= thr);
    if (c) c.reps.push(r); else clusters.push({ reps: [r] });
  }
  clusters.sort((a, b) => b.reps.length - a.reps.length);
  if (clusters[0].reps.length >= 2) {
    const winner = pickMedoid(clusters[0].reps);
    console.error(`· 交叉[${kind}] 共识 ${clusters[0].reps.length}/${ok.length}（${clusters[0].reps.map(r => r.provider).join('+')}），采用 ${winner.provider}`);
    return winner.out;
  }
  const ar = cx.arbiter || { provider: 'deepseek', model: 'deepseek-v4-pro' };
  const labeled = ok.map((r, i) => `【候选${String.fromCharCode(65 + i)}｜来自${r.provider}】\n${r.out}`).join('\n\n');
  const out = await chat(cfg, ar.provider, ar.model, [
    { role: 'system', content: '多个模型对同一任务给出了不同结果。选出综合质量最高的一条；只输出该条原文（可修正明显错别字），不要解释，不要混合各条内容。' },
    { role: 'user', content: `任务：${kind === 'translate' ? '翻译' : '润色'}下面的文本。\n原文本：${text}\n\n${labeled}` }
  ], 0);
  console.error(`· 交叉[${kind}] 全分歧，${ar.provider}/${ar.model} 仲裁（${Date.now() - t0}ms）`);
  return out;
}

// ---- 翻译 ----
const LANGS = { en: '英语', ja: '日语', ko: '韩语', zh: '中文', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语', it: '意大利语', pt: '葡萄牙语' };
async function translateOnce(cfg, d, provider, model, text, to, signal) {
  const toName = LANGS[to] || to;
  const sys = [
    `你是专业翻译引擎。将用户文本翻译为${toName}。`,
    `专有名词保持原文不翻译：${(d.hotwords || []).join('、')}`,
    '只输出译文本身，不要解释、不要引号、不要注音。'
  ].join('\n');
  return chat(cfg, provider, model, [{ role: 'system', content: sys }, { role: 'user', content: text }], 0, signal);
}
async function translateText(text, to, { provider: pOv, model: mOv, cross = false, app = null, cfg: cfgIn = null } = {}) {
  const cfg = cfgIn || ensureInit();
  to = String(to || 'en').toLowerCase().split('-')[0];
  await activatePlugins(cfg);
  cross = cross || cfg._wfCross === true;
  const d = loadDict(app);
  if (!String(text || '').trim()) fail('翻译文本为空', 2);
  if (cross) return crossEnhance(cfg, 'translate', text, (p, m, t, sig) => translateOnce(cfg, d, p, m, t, to, sig));
  const base = pick(cfg, 'translate');
  const provider = pOv || base.provider, model = mOv || (pOv ? undefined : base.model);
  return translateOnce(cfg, d, provider, model, text, to);
}

// ---- 联网检索（无 key 引擎：Bing CN 直连 / DuckDuckGo 可走代理）----
const stripTags = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ').replace(/&#0183;/g, '·').replace(/\s+/g, ' ').trim();
const curlGet = (url, { proxy, data } = {}) => {
  const args = ['-sL', '--max-time', '12', '-A', UA];
  if (proxy) args.push('-x', proxy);
  if (data) args.push('--data', data);
  args.push(url);
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
};
function searchBing(q, n, proxy) {
  const html = curlGet(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.max(n, 10)}&mkt=zh-CN`, { proxy });
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
async function webSearch(query, cfgAsk, { noSearch = false } = {}) {
  if (noSearch) return [];
  const engines = Array.isArray(cfgAsk?.engines) ? cfgAsk.engines : ['bing', 'ddg'];
  const n = Number(cfgAsk?.maxResults) > 0 ? Number(cfgAsk.maxResults) : 5;
  for (const eng of engines) {
    try {
      console.error(`· 检索[${eng}]: ${query}`);
      const rs = eng === 'bing' ? searchBing(query, n, cfgAsk?.proxy) : searchDdg(query, n, cfgAsk?.proxy);
      if (rs.length) {
        // 同一 URL 只保留一次
        const seen = new Set();
        return rs.filter(r => r.url && !seen.has(r.url) && seen.add(r.url)).slice(0, n);
      }
      console.error(`· 检索[${eng}] 零结果`);
    } catch (e) { console.error(`· 检索[${eng}] 失败: ${oneLine(e.message, 120)}`); }
  }
  return [];
}
async function askAnswer(question, { provider: pOv, model: mOv, noSearch = false, app = null, cfg: cfgIn = null } = {}) {
  const cfg = cfgIn || ensureInit();
  await activatePlugins(cfg);
  if (!String(question || '').trim()) fail('问题为空', 2);
  const d = loadDict(app);
  question = applyDict(question, app);
  const rs = await webSearch(question, cfg.ask, { noSearch });
  const base = pick(cfg, 'ask');
  const provider = pOv || base.provider, model = mOv || (pOv ? undefined : base.model);
  const src = rs.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const sys = [
    `今天是 ${today}。基于给定的搜索结果回答用户问题，用简体中文。`,
    (d.hotwords || []).length ? `专有名词保持原样：${d.hotwords.join('、')}` : '',
    '优先使用搜索结果作答，引用来源用 [n] 标注（n 为结果编号）。',
    '搜索结果只覆盖部分问题时：用结果回答能覆盖的部分，其余用自身知识补全，并在补全句末标注【补充】。',
    '完全不相关时才说明检索无果。回答简洁、分点、直给结论。'
  ].join('\n');
  const user = rs.length
    ? `问题：${question}\n\n搜索结果：\n${src}`
    : `问题：${question}\n\n（本次未联网检索，或没有检索到结果；请基于自身知识回答并注明未经联网核实。）`;
  return chat(cfg, provider, model, [{ role: 'system', content: sys }, { role: 'user', content: user }], 0);
}

// ---- 插入焦点应用（剪贴板 + Cmd+V，默认粘贴后恢复剪贴板）----
function readClipboard() {
  try { return execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); } catch { return ''; }
}
function scheduleClipboardRestore(oldText) {
  if (!oldText) return;
  try {
    const child = spawn('/bin/sh', ['-c', 'sleep 1.6; exec pbcopy'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end(oldText);
    child.unref();
  } catch { /* 恢复失败不阻塞 */ }
}
function insertText(text, cfg = ensureInit()) {
  const out = String(text ?? '');
  if (!out) return false;
  if ((cfg.insert?.mode ?? 'paste') === 'none') { console.log(out); return false; }
  const old = cfg.insert?.restoreClipboard !== false ? readClipboard() : '';
  execFileSync('pbcopy', { input: out, encoding: 'utf8' });
  try {
    execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    fail(`粘贴失败：辅助功能授权可能掉了（系统设置→隐私与安全性→辅助功能）。\n  文本已复制到剪贴板，可手动 ⌘V。\n  ${oneLine(e.message, 200)}`, 4);
  }
  if (cfg.insert?.restoreClipboard !== false && old && old !== out) scheduleClipboardRestore(old);
  return true;
}

// ---- 历史 / 统计 ----
function readHistory() {
  if (!fs.existsSync(HISTORY)) return [];
  const out = [];
  for (const line of fs.readFileSync(HISTORY, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (isObj(e)) out.push(e);
    } catch { /* 跳过坏行，历史应尽量可读 */ }
  }
  return out;
}
function writeHistory(entries) {
  const body = entries.map(e => JSON.stringify(e)).join('\n');
  writeFileAtomic(HISTORY, body ? body + '\n' : '', 0o600);
}
function appendHistory(entry) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n', { mode: 0o600 });
  try { fs.chmodSync(HISTORY, 0o600); } catch { /* ignore */ }
}
const entryTime = (e) => { const t = Date.parse(e?.ts || ''); return Number.isFinite(t) ? t : 0; };
const pad2 = (n) => String(n).padStart(2, '0');
function dayLocal(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || '').slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function localStamp(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts || '');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return dayLocal(d.toISOString());
}
const nextDay = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000) === 1;
function recordingStats() {
  let count = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(REC_DIR)) {
      if (!f.endsWith('.wav')) continue;
      count++;
      try { bytes += fs.statSync(path.join(REC_DIR, f)).size; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { count, bytes };
}
function computeStats(entries) {
  const days = new Set(), modes = {}, apps = {};
  let chars = 0, rawChars = 0, first = null, last = null;
  for (const e of entries) {
    const out = typeof e.out === 'string' ? e.out : '';
    chars += Number.isFinite(e.chars) ? e.chars : [...out].length;
    rawChars += Number.isFinite(e.rawChars) ? e.rawChars : (typeof e.raw === 'string' ? [...e.raw].length : 0);
    if (e.ts) days.add(dayLocal(e.ts));
    const mode = e.mode || '-';
    modes[mode] = (modes[mode] || 0) + 1;
    if (e.app) apps[e.app] = (apps[e.app] || 0) + 1;
    const t = entryTime(e);
    if (t) { first = first === null ? t : Math.min(first, t); last = last === null ? t : Math.max(last, t); }
  }
  const sortedDays = [...days].sort();
  let longest = 0, run = 0, prev = null;
  for (const d of sortedDays) {
    run = prev && nextDay(prev, d) ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  const today = dayLocal(new Date().toISOString());
  const yesterday = addDays(today, -1);
  let streak = 0;
  let probe = days.has(today) ? today : (days.has(yesterday) ? yesterday : null);
  while (probe && days.has(probe)) { streak++; probe = addDays(probe, -1); }
  const recStats = recordingStats();
  return {
    entries: entries.length,
    chars,
    rawChars,
    avgChars: entries.length ? Math.round(chars / entries.length * 10) / 10 : 0,
    activeDays: days.size,
    streak,
    longestStreak: longest,
    today,
    modes,
    apps,
    first: first ? new Date(first).toISOString() : null,
    last: last ? new Date(last).toISOString() : null,
    recordings: recStats.count,
    recordingsBytes: recStats.bytes
  };
}
function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- 学习引擎：智能 diff + 词库挖掘 ----
function tokenizeForDiff(text) {
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter('zh', { granularity: 'word' });
      return Array.from(seg.segment(String(text)), s => s.segment);
    }
  } catch { /* fall back */ }
  return Array.from(String(text));
}
function lcsPairs(raw, corrected) {
  const A = tokenizeForDiff(raw), B = tokenizeForDiff(corrected);
  if (A.length > 1200 || B.length > 1200) return [];
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0, dels = [], ins = [];
  const flush = () => {
    const from = dels.join('').trim(), to = ins.join('').trim();
    if (from && from !== to) pairs.push({ from, to });
    dels = []; ins = [];
  };
  while (i < n && j < m) {
    if (A[i] === B[j]) { flush(); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) dels.push(A[i++]);
    else ins.push(B[j++]);
  }
  while (i < n) dels.push(A[i++]);
  while (j < m) ins.push(B[j++]);
  flush();
  return pairs.filter(p => /[\p{L}\p{N}]/u.test(p.from));
}
function smartDiff(raw, corrected) {
  const pairs = lcsPairs(raw, corrected);
  if (pairs.length) return pairs;
  if (normalizeTxt(raw) !== normalizeTxt(corrected)) {
    return [{ from: String(raw).trim(), to: String(corrected).trim() }];
  }
  return [];
}
const PUNCT = /[，。,.！!？?、；;：:\s（）()【】\[\]""''""·—…\-]/g;
function tokenizeCn(text) {
  return String(text).replace(PUNCT, ' ').split(/\s+/).filter(t => t.length >= 2);
}
function minePatterns() {
  if (!fs.existsSync(FEEDBACK)) return [];
  const patterns = new Map();
  for (const line of fs.readFileSync(FEEDBACK, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      for (const p of e.pairs || []) {
        if (!p || typeof p.from !== 'string' || typeof p.to !== 'string') continue;
        const key = `${p.from}\u0000${p.to}`;
        const cur = patterns.get(key) || { from: p.from, to: p.to, count: 0 };
        cur.count++;
        patterns.set(key, cur);
      }
    } catch { /* skip */ }
  }
  return [...patterns.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
}
function dictDocForEdit() {
  const d = readDictDoc();
  if (!Array.isArray(d.replacements)) d.replacements = [];
  if (!Array.isArray(d.hotwords)) d.hotwords = [];
  if (!Array.isArray(d.styleRules)) d.styleRules = [];
  if (!isObj(d.apps)) d.apps = {};
  return d;
}
function saveDict(d) { writeFileAtomic(DICT, JSON.stringify(d, null, 2), 0o600); }
function mergeDictInto(dst, src) {
  if (!isObj(src)) fail('词库 JSON 顶层必须是对象', 2);
  const known = ['replacements', 'hotwords', 'styleRules', 'apps'];
  if (!known.some(k => src[k] !== undefined)) fail('不是 sayless 词库 JSON（缺少 replacements/hotwords/styleRules/apps）', 2);
  const validateRule = (r, where) => {
    if (!isObj(r)) fail(`${where} 不是对象`, 2);
    if (typeof r.to !== 'string') fail(`${where} 缺少字符串 to`, 2);
    if (typeof r.from === 'string' && r.from) return;
    if (typeof r.pattern === 'string' && r.pattern) {
      try { new RegExp(r.pattern); } catch (e) { fail(`${where} 正则无效：${e.message}`, 2); }
      return;
    }
    fail(`${where} 需要非空 from 或 pattern`, 2);
  };
  const srcReps = src.replacements ?? [];
  const srcHot = src.hotwords ?? [];
  const srcRules = src.styleRules ?? [];
  const srcApps = src.apps ?? {};
  if (!Array.isArray(srcReps)) fail('replacements 必须是数组', 2);
  if (!Array.isArray(srcHot) || srcHot.some(w => typeof w !== 'string')) fail('hotwords 必须是字符串数组', 2);
  if (!Array.isArray(srcRules) || srcRules.some(r => typeof r !== 'string')) fail('styleRules 必须是字符串数组', 2);
  if (!isObj(srcApps)) fail('apps 必须是对象', 2);
  srcReps.forEach((r, i) => validateRule(r, `replacements[${i}]`));
  for (const [app, layer] of Object.entries(srcApps)) {
    if (!isObj(layer)) fail(`apps.${app} 必须是对象`, 2);
    if (layer.replacements !== undefined && !Array.isArray(layer.replacements)) fail(`apps.${app}.replacements 必须是数组`, 2);
    (layer.replacements || []).forEach((r, i) => validateRule(r, `apps.${app}.replacements[${i}]`));
    if (layer.hotwords !== undefined && (!Array.isArray(layer.hotwords) || layer.hotwords.some(w => typeof w !== 'string'))) fail(`apps.${app}.hotwords 必须是字符串数组`, 2);
    if (layer.styleRules !== undefined && (!Array.isArray(layer.styleRules) || layer.styleRules.some(r => typeof r !== 'string'))) fail(`apps.${app}.styleRules 必须是字符串数组`, 2);
  }
  const keyOf = r => r.from || r.pattern;
  const counts = { rep: srcReps.length, hot: 0, rules: 0, apps: 0 };
  for (const r of srcReps) {
    dst.replacements = dst.replacements.filter(x => keyOf(x) !== keyOf(r));
    dst.replacements.push(r);
  }
  for (const w of srcHot) {
    if (!dst.hotwords.includes(w)) { dst.hotwords.push(w); counts.hot++; }
  }
  for (const rule of srcRules) {
    if (!dst.styleRules.includes(rule)) { dst.styleRules.push(rule); counts.rules++; }
  }
  dst.apps = isObj(dst.apps) ? dst.apps : {};
  for (const [app, layer] of Object.entries(srcApps)) {
    const target = ensureAppLayer(dst, app);
    for (const r of (layer.replacements || [])) {
      target.replacements = target.replacements.filter(x => keyOf(x) !== keyOf(r));
      target.replacements.push(r);
    }
    for (const w of (layer.hotwords || [])) {
      if (!target.hotwords.includes(w)) target.hotwords.push(w);
    }
    for (const rule of (layer.styleRules || [])) {
      if (!target.styleRules.includes(rule)) target.styleRules.push(rule);
    }
    counts.apps++;
  }
  return counts;
}
function ensureAppLayer(d, app) {
  d.apps = isObj(d.apps) ? d.apps : {};
  if (!isObj(d.apps[app])) d.apps[app] = {};
  const layer = d.apps[app];
  if (!Array.isArray(layer.hotwords)) layer.hotwords = [];
  if (!Array.isArray(layer.replacements)) layer.replacements = [];
  if (!Array.isArray(layer.styleRules)) layer.styleRules = [];
  return layer;
}

// ---- CLI 参数 ----
const RAW_ARGV = process.argv.slice(2);
const argv = [];
for (let i = 0; i < RAW_ARGV.length; i++) {
  const a = RAW_ARGV[i];
  if (a === '--') { argv.push(...RAW_ARGV.slice(i)); break; }
  if (a.startsWith('--') && a.includes('=')) {
    const idx = a.indexOf('=');
    argv.push(a.slice(0, idx), a.slice(idx + 1));
  } else argv.push(a);
}
const [, , cmd, ...rest] = [process.argv[0], process.argv[1], ...argv];
const dashIndex = rest.indexOf('--');
const headRest = dashIndex >= 0 ? rest.slice(0, dashIndex) : rest;
const tailRest = dashIndex >= 0 ? rest.slice(dashIndex + 1) : [];
const flagArgv = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
const VALUE_FLAGS = new Set([
  '--sec', '-o', '--to', '--translate', '--provider', '--model', '--workflow', '--app', '-n',
  '--delete', '--search', '--export', '--min-count', '--keep'
]);
const arg = (name, def) => {
  const i = headRest.indexOf(name);
  if (i < 0) return def;
  const v = headRest[i + 1];
  return v === undefined || v.startsWith('-') ? def : v;
};
const has = (name) => headRest.includes(name);
const LANGUAGE_RE = /^[a-z]{2}(-[a-z]{2})?$/i;
const positional = () => {
  const out = [];
  for (let i = 0; i < headRest.length; i++) {
    const a = headRest[i];
    if (a === '--translate') {
      // --translate 的值是可选语言代码；后面若直接跟另一个参数/文件名，不能吞掉它
      const next = headRest[i + 1];
      if (next && !next.startsWith('-') && LANGUAGE_RE.test(next)) i++;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const next = headRest[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;
      continue;
    }
    if (a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  // -- 之后的内容一律当位置参数（文件名/文本），不再解析成旗标
  out.push(...tailRest);
  return out;
};
const overrides = () => ({ provider: arg('--provider'), model: arg('--model') });
const KNOWN_FLAGS = new Set([
  '--sec', '-o', '--to', '--translate', '--provider', '--model', '--workflow', '--app', '-n',
  '--delete', '--search', '--export', '--min-count', '--keep', '--raw', '--no-insert', '--dry-run',
  '--ask', '--say', '--cross', '--force', '--json', '--offline', '--no-search', '--clear',
  '--apply', '--mine', '--last', '--help', '-h', '--version', '-v'
]);
const unknownFlags = [...new Set(headRest.filter(a => a.startsWith('-') && a !== '-' && !KNOWN_FLAGS.has(a)))];
if (unknownFlags.length) console.error(`· 未知参数（已忽略）：${unknownFlags.join(' ')}`);
function readStdinText() {
  try { return fs.readFileSync(0, 'utf8').trim(); } catch { return ''; }
}
function textArg() {
  const p = positional();
  if (p.length === 1 && p[0] === '-') return readStdinText();
  return p.join(' ').trim();
}
function numberArg(name, def) {
  const v = arg(name);
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function translateTarget(cfg) {
  if (!has('--translate')) return null;
  const v = arg('--translate');
  if (!v) return cfg.translate?.to ?? 'en';
  const lang = v.toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(lang)) return cfg.translate?.to ?? 'en';
  return lang.includes('-') ? lang.split('-')[0] : lang;
}
function requireFile(p, label = '文件') {
  if (!p || !fs.existsSync(p)) fail(`${label}不存在：${p || '(未提供)'}`, 2);
  return p;
}
function historyHumanLine(e) {
  const rec = e.rec ? `  [${path.basename(String(e.rec))}]` : '';
  return `${localStamp(e.ts)}  [${e.mode || '-'}]  ${oneLine(e.out || '', 80)}${rec}`;
}
async function probeProvider(name, p, key, timeoutMs = 8000) {
  const base = String(p.baseUrl || '').replace(/\/$/, '');
  try {
    const r = await fetch(base + '/models', {
      headers: { Authorization: `Bearer ${key || 'dummy'}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { name, status: r.status, ok: r.status < 300 };
  } catch (e) {
    return { name, error: e.cause?.code || e.message };
  }
}
function effectiveModel(cfg, section) {
  const s = cfg[section] || {};
  const provider = s.provider || cfg.llm.provider;
  const own = s.model || '';
  const fallback = section === 'llm' ? (cfg.llm.model || '') : '';
  const providerDefault = cfg.providers?.[provider]?.model || '';
  const model = own || fallback || providerDefault || '(provider 默认)';
  return `${provider}/${model}`;
}
function statusHint(r) {
  if (r.error) return `网络失败 ${r.error}`;
  if (r.status < 300) return 'key 有效';
  if (r.status === 401) return 'key 无效/缺失';
  if (r.status === 402) return '额度不足';
  if (r.status === 403) return '未开通/未实名';
  if (r.status === 404) return '端点无 /models（不代表 key 无效）';
  return `HTTP ${r.status}`;
}

// ---- CLI ----
try {
  if (flagArgv.includes('--help') || flagArgv.includes('-h')) {
    console.log(HELP);
    process.exitCode = 0;
  } else if (!cmd || cmd === 'help') {
    console.log(HELP);
    process.exitCode = cmd ? 0 : 2;
  } else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(`sayless ${VERSION} · node ${process.version}`);
  } else if (cmd === 'init') {
    const cfg = ensureInit();
    const providers = Object.keys(cfg.providers || {}).length;
    console.log(`配置就绪：${CFG}`);
    console.log(`词语库：${DICT}`);
    console.log(`供应商 ${providers} 个 · 工作流 ${Object.keys(cfg.workflows || {}).join(' / ')} · ASR=${cfg.asr.adapter}`);
    console.log('下一步：sayless doctor 体检；sayless run 开始听写');
  } else if (cmd === 'rec') {
    const cfg = ensureInit();
    const out = arg('-o') || TMP_WAV;
    await rec(numberArg('--sec', 0), out, cfg);
    console.log(out);
  } else if (cmd === 'devices') {
    const lines = listAudioDevices(ensureInit());
    if (!lines.length) fail('无法列出录音设备（确认 ffmpeg 可用）', 3);
    console.log(lines.map(l => l.replace(/^.*?\] /, '')).join('\n'));
  } else if (cmd === 'asr') {
    const cfg = ensureInit();
    const wav = requireFile(positional()[0] || TMP_WAV, '音频');
    console.log(applyDict(await asr(wav, cfg), arg('--app') || null));
  } else if (cmd === 'polish') {
    const text = textArg();
    if (!text) fail('用法: sayless polish "<text>"（可用 - 从 stdin 读取）', 2);
    const r = await polish(text, { dryRun: has('--dry-run'), cross: has('--cross'), ...overrides() });
    console.log(r.text);
  } else if (cmd === 'translate') {
    const cfg = ensureInit();
    let text = textArg();
    const to = arg('--to') || cfg.translate?.to || 'en';
    if (has('--say') || !text) {
      await rec(numberArg('--sec', 0), TMP_WAV, cfg);
      text = applyDict(await asr(TMP_WAV, cfg));
      if (text) console.error(`识别: ${text}`);
    }
    if (!text) fail('翻译文本为空', 2);
    console.log(await translateText(text, to, { ...overrides(), cross: has('--cross'), app: arg('--app') || null, cfg }));
  } else if (cmd === 'ask') {
    const cfg = ensureInit();
    let q = textArg();
    if (has('--say') || !q) {
      await rec(numberArg('--sec', 0), TMP_WAV, cfg);
      q = applyDict(await asr(TMP_WAV, cfg));
      if (q) console.error(`识别: ${q}`);
    }
    if (!q) fail('问题为空', 2);
    console.log(await askAnswer(q, { ...overrides(), noSearch: has('--no-search'), app: arg('--app') || null, cfg }));
  } else if (cmd === 'transcribe') {
    const cfg = ensureInit();
    const wav = requireFile(positional()[0] || TMP_WAV, '音频');
    await finishPipeline(wav, {
      insert: !has('--no-insert'), raw: has('--raw'), force: has('--force'),
      translateTo: translateTarget(cfg),
      askMode: has('--ask'), noSearch: has('--no-search'),
      cross: has('--cross'), app: arg('--app') || null, cfg, ...overrides()
    });
  } else if (cmd === 'run') {
    const cfg = ensureInit();
    await rec(numberArg('--sec', 0), TMP_WAV, cfg);
    await finishPipeline(TMP_WAV, {
      insert: !has('--no-insert'), raw: has('--raw'),
      translateTo: translateTarget(cfg),
      askMode: has('--ask'), noSearch: has('--no-search'),
      cross: has('--cross'), app: arg('--app') || null, cfg, ...overrides()
    });
  } else if (cmd === 'insert') {
    const text = textArg();
    if (!text) fail('用法: sayless insert "<text>"', 2);
    insertText(text, ensureInit());
  } else if (cmd === 'dict') {
    const cfg = ensureInit();
    void cfg;
    const sub = rest[0];
    const vals = positional().slice(1);
    if (sub === 'add') {
      if (!vals[0] || vals[1] === undefined) fail('用法: sayless dict add <原词> <替换为>', 2);
      const d = dictDocForEdit();
      d.replacements = d.replacements.filter(r => !(isObj(r) && r.from === vals[0]));
      d.replacements.push({ from: vals[0], to: vals[1] });
      saveDict(d);
      console.log(`已加替换：${vals[0]} → ${vals[1]}`);
    } else if (sub === 'del') {
      if (!vals[0]) fail('用法: sayless dict del <原词或目标词>', 2);
      const d = dictDocForEdit();
      const before = d.replacements.length;
      d.replacements = d.replacements.filter(r => r.from !== vals[0] && r.to !== vals[0]);
      saveDict(d);
      console.log(`已删 ${before - d.replacements.length} 条含「${vals[0]}」的替换`);
    } else if (sub === 'add-hot') {
      if (!vals[0]) fail('用法: sayless dict add-hot <词>', 2);
      const d = dictDocForEdit();
      d.hotwords = [...new Set([...d.hotwords, vals[0]])];
      saveDict(d);
      console.log(`已加热词：${vals[0]}`);
    } else if (sub === 'del-hot') {
      if (!vals[0]) fail('用法: sayless dict del-hot <词>', 2);
      const d = dictDocForEdit();
      d.hotwords = d.hotwords.filter(w => w !== vals[0]);
      saveDict(d);
      console.log(`已删热词：${vals[0]}`);
    } else if (sub === 'add-rule' || sub === 'rule-add') {
      const rule = vals.join(' ').trim();
      if (!rule) fail('用法: sayless dict add-rule <风格规则>', 2);
      const d = dictDocForEdit();
      d.styleRules = [...new Set([...d.styleRules, rule])];
      saveDict(d);
      console.log(`已加风格规则：${rule}`);
    } else if (sub === 'del-rule' || sub === 'rule-del') {
      const key = vals.join(' ').trim();
      if (!key) fail('用法: sayless dict del-rule <序号|规则文本>', 2);
      const d = dictDocForEdit();
      const idx = Number(key) - 1;
      const before = d.styleRules.length;
      if (Number.isInteger(idx) && idx >= 0 && idx < before) d.styleRules.splice(idx, 1);
      else d.styleRules = d.styleRules.filter(r => r !== key);
      saveDict(d);
      console.log(`已删 ${before - d.styleRules.length} 条风格规则`);
    } else if (sub === 'app-add-hot' || sub === 'app-del-hot' || sub === 'app-add' || sub === 'app-del' ||
               sub === 'app-add-replace' || sub === 'app-del-replace') {
      const app = vals[0];
      if (!app) fail(`用法: sayless dict ${sub} <应用名> ...`, 2);
      const d = dictDocForEdit();
      if (sub === 'app-del') {
        delete (d.apps || {})[app];
        saveDict(d);
        console.log(`已删应用词层：${app}`);
      } else {
        const layer = ensureAppLayer(d, app);
        if (sub === 'app-add') {
          saveDict(d);
          console.log(`已创建应用词层：${app}`);
        } else if (sub === 'app-add-hot') {
          if (!vals[1]) fail('用法: sayless dict app-add-hot <应用名> <词>', 2);
          layer.hotwords = [...new Set([...layer.hotwords, vals[1]])];
          saveDict(d);
          console.log(`已加 ${app} 热词：${vals[1]}`);
        } else if (sub === 'app-del-hot') {
          if (!vals[1]) fail('用法: sayless dict app-del-hot <应用名> <词>', 2);
          layer.hotwords = layer.hotwords.filter(w => w !== vals[1]);
          saveDict(d);
          console.log(`已删 ${app} 热词：${vals[1]}`);
        } else if (sub === 'app-add-replace') {
          if (!vals[1] || vals[2] === undefined) fail('用法: sayless dict app-add-replace <应用名> <原词> <替换为>', 2);
          layer.replacements = layer.replacements.filter(r => !(isObj(r) && r.from === vals[1]));
          layer.replacements.push({ from: vals[1], to: vals[2] });
          saveDict(d);
          console.log(`已加 ${app} 替换：${vals[1]} → ${vals[2]}`);
        } else {
          if (!vals[1]) fail('用法: sayless dict app-del-replace <应用名> <原词>', 2);
          layer.replacements = layer.replacements.filter(r => r.from !== vals[1]);
          saveDict(d);
          console.log(`已删 ${app} 替换：${vals[1]}`);
        }
      }
    } else if (sub === 'import') {
      const src = vals[0];
      if (!src) fail('用法: sayless dict import <file>', 2);
      const text = fs.readFileSync(requireFile(src), 'utf8');
      const d = dictDocForEdit();
      if (text.trim().startsWith('{')) {
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { fail(`词库 JSON 解析失败：${e.message}`, 2); }
        const counts = mergeDictInto(d, parsed);
        saveDict(d);
        console.log(`导入完成（JSON 合并）：${counts.rep} 替换 / ${counts.hot} 热词 / ${counts.rules} 规则 / ${counts.apps} 应用层`);
      } else {
        let hot = 0, rep = 0;
        for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
          const m = line.match(/^(.+?)(?:\s*(?:=>|→|\t)\s*(.+))$/);
          if (m && m[2]) {
            if (!d.replacements.some(r => r.from === m[1].trim())) rep++;
            d.replacements = d.replacements.filter(r => r.from !== m[1].trim());
            d.replacements.push({ from: m[1].trim(), to: m[2].trim() });
          } else {
            if (!d.hotwords.includes(line)) hot++;
            d.hotwords = [...new Set([...d.hotwords, line])];
          }
        }
        saveDict(d);
        console.log(`导入完成：${rep} 条新替换，${hot} 个新热词`);
      }
    } else if (sub === 'stats') {
      const d = dictDocForEdit();
      const entries = readHistory();
      const freq = {};
      for (const e of entries) {
        const text = `${e.out || ''} ${e.raw || ''}`;
        for (const w of d.hotwords) if (text.includes(w)) freq[w] = (freq[w] || 0) + 1;
      }
      console.log(`历史 ${entries.length} 条 · 替换 ${d.replacements.length} 条 · 热词 ${d.hotwords.length} 个 · 风格规则 ${d.styleRules.length} 条 · 应用词层 ${Object.keys(d.apps).length} 个`);
      if (Object.keys(freq).length) {
        console.log('热词命中：');
        for (const [w, c] of Object.entries(freq).sort((a, b) => b[1] - a[1])) console.log(`  ${w}: ${c} 次`);
      }
      const unused = d.hotwords.filter(w => !freq[w]);
      if (unused.length) console.log(`从未命中：${unused.join('、')}`);
    } else if (sub === 'export') {
      const dest = vals[0] || path.join(DIR, `dictionary-${new Date().toISOString().slice(0, 10)}.json`);
      writeFileAtomic(dest, JSON.stringify(dictDocForEdit(), null, 2), 0o600);
      console.log(`已导出：${dest}`);
    } else if (sub === 'validate') {
      const d = dictDocForEdit();
      const issues = [];
      const checkReplacement = (r, where) => {
        if (!isObj(r)) { issues.push(`${where} 不是对象`); return; }
        if (typeof r.pattern === 'string' && r.pattern) {
          try { new RegExp(r.pattern); } catch (e) { issues.push(`${where} 无效正则 ${r.pattern}: ${e.message}`); }
        } else if (!r.from) {
          issues.push(`${where} 存在空 from`);
        }
        if (typeof r.to !== 'string') issues.push(`${where}（${r.from || r.pattern || '?'}）缺少 to`);
      };
      d.replacements.forEach((r, i) => checkReplacement(r, `替换 #${i + 1}`));
      for (const [app, layer] of Object.entries(d.apps)) {
        if (!isObj(layer)) { issues.push(`应用词层 ${app} 不是对象`); continue; }
        if (layer.replacements !== undefined && !Array.isArray(layer.replacements)) issues.push(`应用词层 ${app}.replacements 不是数组`);
        (Array.isArray(layer.replacements) ? layer.replacements : []).forEach((r, i) => checkReplacement(r, `${app} 替换 #${i + 1}`));
        if (layer.hotwords !== undefined && !Array.isArray(layer.hotwords)) issues.push(`应用词层 ${app}.hotwords 不是数组`);
      }
      if (issues.length) { console.log('发现问题：'); for (const i of issues) console.log('  ✗ ' + i); process.exitCode = 2; }
      else console.log('词语库校验通过 ✓');
    } else if (sub) {
      fail(`未知 dict 子命令：${sub}\n  可用：add | del | add-hot | del-hot | add-rule | del-rule | app-add-hot | app-del-hot | app-add-replace | app-del-replace | app-del | import | stats | export | validate`, 2);
    } else {
      console.log(JSON.stringify(readDictDoc(), null, 2));
    }
  } else if (cmd === 'history') {
    ensureInit();
    let entries = readHistory().sort((a, b) => entryTime(b) - entryTime(a));
    const allEntries = entries.slice();
    const filter = arg('--search');
    if (filter) {
      const q = filter.toLowerCase();
      entries = entries.filter(e => [e.out, e.raw, e.mode, e.app, e.ts].some(v => String(v || '').toLowerCase().includes(q)));
    }
    if (has('--clear')) {
      if (!has('--force')) fail('清空历史需要加 --force 确认', 2);
      writeHistory([]);
      console.log('已清空听写历史（录音归档未删除）');
    } else if (has('--delete') || arg('--delete') !== undefined) {
      const key = arg('--delete');
      if (key === undefined || key === '') fail('--delete 需要一个序号或时间戳/录音文件名', 2);
      // 注意：--search 只用于定位序号；删除必须回写完整历史，不能只写搜索结果。
      const all = allEntries;
      const before = all.length;
      let remaining = all;
      let removed = 0;
      const num = Number(key);
      if (Number.isInteger(num)) {
        if (num <= 0 || num > entries.length) fail(`--delete 序号超出范围：${key}（当前匹配 ${entries.length} 条）`, 2);
        const target = entries[num - 1];
        remaining = all.filter(e => e !== target);
        removed = before - remaining.length;
      } else {
        const hit = (e) => {
          const ts = String(e.ts || '');
          if (ts === key || ts.startsWith(key)) return true;
          if (path.basename(String(e.rec || '')) === key) return true;
          // 人类可读输出是本地时间；允许按界面上的本地日期/时间删除
          const stamp = localStamp(ts);
          if (stamp === key || stamp.startsWith(key)) return true;
          return dayLocal(ts) === key;
        };
        remaining = all.filter(e => !hit(e));
        removed = before - remaining.length;
      }
      if (!removed) fail(`没有匹配的历史记录：${key}`, 2);
      writeHistory(remaining);
      console.log(`已删除 ${removed} 条历史（原有 ${before} 条）`);
    } else if (arg('--export')) {
      const dest = arg('--export');
      writeFileAtomic(dest, JSON.stringify(entries, null, 2), 0o600);
      console.log(`已导出 ${entries.length} 条历史 → ${dest}`);
    } else {
      const nRaw = arg('-n');
      const nNum = nRaw === undefined || nRaw === '' ? null : Number(nRaw);
      const limit = nNum !== null && Number.isFinite(nNum) ? nNum : (has('--json') ? 0 : 20);
      const view = limit > 0 ? entries.slice(0, limit) : entries;
      if (has('--json')) {
        console.log(JSON.stringify(view, null, 2));
      } else if (!view.length) {
        console.log(filter ? '（没有匹配的历史记录）' : '（暂无历史）');
      } else {
        for (const e of view) console.log(historyHumanLine(e));
        console.error(`· 共 ${entries.length} 条${view.length < entries.length ? `，显示最近 ${view.length} 条` : ''}`);
      }
    }
  } else if (cmd === 'stats') {
    ensureInit();
    const stats = computeStats(readHistory());
    if (has('--json')) console.log(JSON.stringify(stats, null, 2));
    else {
      console.log(`听写 ${stats.entries} 条 · 口述 ${stats.chars} 字 · 平均 ${stats.avgChars} 字/条`);
      console.log(`活跃 ${stats.activeDays} 天 · 当前连续 ${stats.streak} 天 · 最长连续 ${stats.longestStreak} 天`);
      console.log(`录音归档 ${stats.recordings} 条（${fmtBytes(stats.recordingsBytes)}）`);
      const modes = Object.entries(stats.modes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' · ');
      if (modes) console.log(`模式：${modes}`);
      const apps = Object.entries(stats.apps).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' · ');
      if (apps) console.log(`应用：${apps}`);
    }
  } else if (cmd === 'doctor') {
    const cfg = ensureInit();
    await activatePlugins(cfg);
    const offline = has('--offline');
    const json = has('--json');
    const whisperBin = expandHome(cfg.asr.whisperBin) || '';
    const whisperModel = expandHome(cfg.asr.whisperModel) || '';
    const ffmpeg = ffmpegBin(cfg);
    const recStats = recordingStats();
    const report = {
      version: VERSION,
      node: process.version,
      dataDir: DIR,
      config: { path: CFG, exists: fs.existsSync(CFG), mode: fileMode(CFG) },
      asr: {
        adapter: cfg.asr.adapter,
        language: cfg.asr.language,
        whisperBin,
        whisperBinExists: !!which(whisperBin),
        whisperModel,
        whisperModelExists: !!whisperModel && fs.existsSync(whisperModel),
        whisperModelBytes: whisperModel && fs.existsSync(whisperModel) ? fs.statSync(whisperModel).size : 0
      },
      ffmpeg: { path: ffmpeg, exists: !!which(ffmpeg) },
      pipeline: {
        llm: effectiveModel(cfg, 'llm'),
        translate: `${effectiveModel(cfg, 'translate')} → ${cfg.translate.to}`,
        ask: effectiveModel(cfg, 'ask'),
        cross: (cfg.cross?.models || []).length,
        workflow: cfg._workflow || cfg.activeWorkflow
      },
      files: { history: readHistory().length, recordings: recStats.count, recordingsBytes: recStats.bytes, feedback: fs.existsSync(FEEDBACK) },
      plugins: pluginLog,
      providers: []
    };
    const providers = Object.entries(cfg.providers || {});
    if (!offline) {
      const probes = await Promise.all(providers.map(([name, p]) => probeProvider(name, p, p.apiKey || process.env.SAYLESS_API_KEY)));
      const byName = new Map(probes.map(r => [r.name, r]));
      for (const [name, p] of providers) {
        const r = byName.get(name);
        report.providers.push({ name, baseUrl: p.baseUrl, hasKey: !!(p.apiKey || process.env.SAYLESS_API_KEY), ...(r || {}) });
      }
    } else {
      for (const [name, p] of providers) report.providers.push({ name, baseUrl: p.baseUrl, hasKey: !!(p.apiKey || process.env.SAYLESS_API_KEY) });
    }
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`sayless ${VERSION} · Node ${process.version} · 数据目录 ${DIR}`);
      console.log(`ASR: ${cfg.asr.adapter}${cfg.asr.adapter === 'whisper' ? ` · ${whisperBin} ${which(whisperBin) ? 'OK' : '缺失!'} · 模型 ${whisperModel} ${fs.existsSync(whisperModel) ? 'OK' : '缺失!'}` : ''}`);
      console.log(`链路: LLM=${effectiveModel(cfg, 'llm')} · 翻译→${cfg.translate.to} (${effectiveModel(cfg, 'translate')}) · 交叉投票=${(cfg.cross?.models || []).length}家 · 工作流=${cfg._workflow || cfg.activeWorkflow}`);
      console.log(`录音: ffmpeg ${which(ffmpeg) ? 'OK' : '缺失!'}${offline ? ' · 离线模式' : ''} · 历史 ${report.files.history} 条 · 录音归档 ${recStats.count} 条（${fmtBytes(recStats.bytes)}）`);
      if (pluginLog.length) console.log(`插件: ${pluginLog.join(' | ')}`);
      const withKey = report.providers.filter(p => p.hasKey);
      const noKey = report.providers.filter(p => !p.hasKey);
      if (noKey.length) console.log('\n未配 key（仅注册，401=路由存在）:');
      for (const p of noKey) console.log(`  ${p.name}: ${p.error ? `网络失败 ${p.error}` : p.status ? `HTTP ${p.status} ${statusHint(p)}` : '未探测'}`);
      if (withKey.length) console.log('\n已配 key:');
      for (const p of withKey) console.log(`  ${p.name}: ${p.error ? `网络失败 ${p.error}` : p.status ? `HTTP ${p.status} (${statusHint(p)})` : '未探测'}`);
      if (!offline && !json) {
        const devs = listAudioDevices(cfg);
        console.log('\n录音设备：');
        console.log(devs.length ? devs.map(l => l.replace(/^.*?\] /, '')).join('\n') : '  （未发现，检查 ffmpeg / 麦克风权限）');
      }
    }
  } else if (cmd === 'plugin') {
    ensureInit();
    const ps = await loadPlugins();
    if (!ps.length) {
      if (pluginLog.length) {
        console.log('插件加载失败：');
        for (const l of pluginLog) console.log('  ' + l);
      } else {
        console.log('未安装插件。目录 ~/.sayless/plugins/，写 *.mjs 导出 onTranscript/onPolish/onInsert/providers/workflows 即可，见 PLUGINS.md。');
      }
    } else {
      console.log(`已安装 ${ps.length} 个插件（~/.sayless/plugins/）：`);
      for (const l of pluginLog) console.log('  ' + l);
    }
  } else if (cmd === 'learn') {
    const cfg = ensureInit();
    void cfg;
    if (has('--mine')) {
      const patterns = minePatterns();
      if (!patterns.length) { console.log('（暂无修正模式，先用 sayless learn 记录几条改稿）'); process.exitCode = 0; }
      else {
        if (has('--apply')) {
          const min = numberArg('--min-count', 2);
          const d = dictDocForEdit();
          let added = 0, updated = 0;
          for (const p of patterns) {
            if (p.count < min) continue;
            if (!p.from || p.from.length > 40 || p.to.length > 40) continue;
            const ex = d.replacements.find(r => r.from === p.from);
            if (ex) {
              if (ex.to !== p.to) { ex.to = p.to; updated++; }
            } else { d.replacements.push({ from: p.from, to: p.to }); added++; }
            if (p.to.length >= 2 && /[A-Za-z\u4e00-\u9fff]/.test(p.to)) d.hotwords = [...new Set([...d.hotwords, p.to])];
          }
          if (has('--dry-run')) {
            console.log(`（dry-run）将应用 ${patterns.filter(p => p.count >= min).length} 个高频模式：${added} 条新增，${updated} 条更新（阈值 ${min} 次）`);
          } else {
            saveDict(d);
            console.log(`已应用 ${patterns.filter(p => p.count >= min).length} 个高频模式：${added} 条新增，${updated} 条更新（阈值 ${min} 次）`);
          }
        }
        console.log('高频修正模式：');
        for (const p of patterns.slice(0, 10)) console.log(`  ${p.from} → ${p.to} ×${p.count}`);
        console.log('\n加 --apply 自动写入词库（--min-count 调整阈值）');
      }
    } else {
      let rawText, corrected;
      if (has('--last')) {
        corrected = textArg();
        const hist = readHistory().sort((a, b) => entryTime(b) - entryTime(a));
        if (!hist.length) fail('✗ 无历史，无法 --last', 2);
        rawText = String(hist[0].raw || '');
      } else {
        const p = positional();
        rawText = p[0] || '';
        corrected = p.slice(1).join(' ');
      }
      if (!rawText || !corrected) fail('用法: sayless learn <raw> <corrected>\n      sayless learn --last "<改稿>"\n      sayless learn --mine [--apply]', 2);
      const pairs = smartDiff(rawText, corrected);
      if (!pairs.length) { console.log('未发现差异'); }
      else {
        const d = dictDocForEdit();
        let added = 0, skipped = 0;
        for (const pair of pairs) {
          if (!pair.from || pair.from === pair.to) continue;
          if (pair.from.length > 40 || (pair.to || '').length > 40) { skipped++; continue; }
          const exists = d.replacements.find(r => r.from === pair.from);
          if (exists) { if (exists.to !== pair.to) { exists.to = pair.to; added++; } }
          else { d.replacements.push({ from: pair.from, to: pair.to }); added++; }
          if ((pair.to || '').length >= 2 && /[A-Za-z\u4e00-\u9fff]/.test(pair.to)) {
            d.hotwords = [...new Set([...d.hotwords, pair.to])];
          }
        }
        if (!has('--dry-run')) {
          saveDict(d);
          fs.appendFileSync(FEEDBACK, JSON.stringify({ ts: new Date().toISOString(), raw: rawText.slice(0, 300), corrected: corrected.slice(0, 300), pairs, added }) + '\n', { mode: 0o600 });
          try { fs.chmodSync(FEEDBACK, 0o600); } catch { /* ignore */ }
        }
        console.log(`学习完成：${pairs.length} 处差异 → ${added} 条${has('--dry-run') ? '（dry-run，未写入）' : '新替换规则'}${skipped ? `，跳过 ${skipped} 条超长` : ''}`);
        for (const p2 of pairs) console.log(`  ${p2.from} → ${p2.to}`);
      }
    }
  } else {
    console.error(`未知命令：${cmd}\n`);
    console.log(HELP);
    process.exitCode = 2;
  }
} catch (e) {
  const code = Number.isInteger(e?.exitCode) ? e.exitCode : 1;
  console.error(`✗ ${e.message}`);
  if (process.env.SAYLESS_DEBUG) console.error(e.stack);
  process.exitCode = code;
}

// ---- 统一管线（放在最后，函数声明会提升）----
async function finishPipeline(wavPath, {
  insert = true, raw = false, translateTo = null, askMode = false, provider = null, model = null,
  cross = false, app = null, force = false, noSearch = false, cfg: cfgIn = null
} = {}) {
  const t0 = Date.now();
  const cfg = cfgIn || ensureInit();
  await activatePlugins(cfg);
  if (!fs.existsSync(wavPath)) fail(`音频不存在：${wavPath}`, 2);
  const tAsr = Date.now();
  let rawText = await asr(wavPath, cfg);
  const asrMs = Date.now() - tAsr;
  const mode = askMode ? 'ask' : (translateTo ? `translate:${translateTo}` : (raw ? 'raw' : 'dictate'));
  const ctx = { mode, app, wavPath, cfg };
  rawText = (await runHook('onTranscript', rawText, ctx)) || rawText;
  if (!String(rawText).trim()) fail('语音识别结果为空（纯静音或识别失败），已跳过', 2);
  const speech = String(rawText).replace(/[。，,.！!？?、；;：:\s()（）【】\[\]〔〕]/g, '');
  if (speech.length <= 1 && !force) fail('未识别到语音内容（录太短或纯静音），已跳过', 2);
  const tLlm = Date.now();
  let out;
  if (askMode) out = await askAnswer(rawText, { provider, model, noSearch, app, cfg });
  else if (translateTo) out = await translateText(applyDict(rawText, app), translateTo, { provider, model, cross, app, cfg });
  else if (raw) out = applyDict(rawText, app);
  else out = (await polish(rawText, { provider, model, cross, app, cfg })).text;
  const llmMs = Date.now() - tLlm;
  out = await runHook('onPolish', String(out), ctx);
  out = await runHook('onInsert', out, ctx);
  if (!String(out).trim()) fail('管线输出为空（插件可能返回了空文本）', 1);
  // 录音归档：每条听写的 wav 按 ts 存档（回放/重转写用），保留最近 N 条
  let recFile;
  try {
    fs.mkdirSync(REC_DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(REC_DIR, 0o700); } catch { /* ignore */ }
    let base = new Date().toISOString().replace(/[:.]/g, '-');
    recFile = path.join(REC_DIR, `${base}.wav`);
    let n = 1;
    while (fs.existsSync(recFile)) recFile = path.join(REC_DIR, `${base}-${n++}.wav`);
    fs.copyFileSync(wavPath, recFile);
    try { fs.chmodSync(recFile, 0o600); } catch { /* ignore */ }
    const keep = Math.max(1, numberArg('--keep', Number(cfg.recordings?.keep) > 0 ? Number(cfg.recordings.keep) : 200));
    const old = fs.readdirSync(REC_DIR).filter(f => f.endsWith('.wav'))
      .map(f => ({ f, t: fs.statSync(path.join(REC_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of old.slice(keep)) fs.rmSync(path.join(REC_DIR, x.f), { force: true });
  } catch (e) {
    warn(`录音归档失败（不影响听写）：${e.message}`);
  }
  // 先输出/粘贴，再落历史：inserted 记录实际结果（mode=none/粘贴失败都算 false）
  let inserted = false;
  let insertError = null;
  if (insert) {
    try {
      inserted = insertText(out, cfg);
    } catch (e) {
      insertError = e;
    }
  } else {
    console.log(out);
  }
  const timings = { asr: asrMs, llm: llmMs, total: Date.now() - t0 };
  const entry = {
    ts: new Date().toISOString(), mode, app: app || undefined,
    raw: String(rawText).slice(0, 500), out: String(out).slice(0, 1000),
    chars: [...String(out)].length, rawChars: [...String(rawText)].length,
    inserted, rec: recFile ? path.basename(recFile) : undefined, timings
  };
  try { appendHistory(entry); } catch (e) { warn(`历史落盘失败：${e.message}`); }
  console.error(`识别: ${rawText}\n结果: ${out}`);
  console.error(`· 耗时 ASR ${asrMs}ms · LLM ${llmMs}ms · 总计 ${timings.total}ms`);
  // 给菜单栏 App 的机器可读结果（避免多行文本被逐行解析截断）
  console.error(`RESULT_JSON:${JSON.stringify({ out: String(out), raw: String(rawText), mode, rec: entry.rec, ts: entry.ts, inserted })}`);
  if (insertError) throw insertError;
  return { raw: rawText, out: String(out), mode, rec: recFile, inserted, entry };
}
