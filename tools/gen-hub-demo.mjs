#!/usr/bin/env node
// 用演示数据渲染 hub 截图（不读取、不修改真实 ~/.sayless 数据）。
// 用法: node tools/gen-hub-demo.mjs [输出目录]
// 依赖: 本机 Google Chrome（headless 截图），可用 CHROME_BIN 覆盖路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || '/tmp/hub-demo');
const TPL = path.join(ROOT, 'app', 'hub.html');
function findChrome() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [];
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!d.startsWith('chromium_headless_shell')) continue;
      const dir = path.join(cache, d);
      for (const sub of fs.readdirSync(dir)) {
        candidates.push(path.join(dir, sub, 'chrome-headless-shell'));
        candidates.push(path.join(dir, sub, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
        candidates.push(path.join(dir, sub, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'));
      }
    }
  } catch { /* playwright not installed */ }
  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return candidates.find(p => fs.existsSync(p)) || '';
}
const CHROME = findChrome();

const today = '2026-10-20';
const iso = (offset) => {
  const d = new Date(today + 'T12:00:00');
  d.setDate(d.getDate() + offset);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const at = (offset, hhmm) => `${iso(offset)}T${hhmm}:00.000Z`;

const rawHistory = [
  { ts: at(0, '12:31'), mode: 'dictate', out: '把明天的站会改到十点，记得同步进度。', app: 'Slack', rec: '2026-10-20T12-31-10.wav', inserted: true },
  { ts: at(0, '11:04'), mode: 'translate:en', out: 'Please send the revised proposal to the client by Friday.', app: 'Mail', rec: '2026-10-20T11-04-22.wav', inserted: true },
  { ts: at(0, '09:47'), mode: 'ask', out: '结论：10TB 冷存储按单价从低到高依次是 OSS 归档、S3 Glacier Deep Archive、S3 Glacier。[1][2]', app: 'SaylessBar', rec: '', inserted: false },
  { ts: at(-1, '21:03'), mode: 'dictate', out: '这个 bug 的根因是连接池没有释放，我先写个回归测试。', app: 'VS Code', rec: '2026-10-19T21-03-40.wav', inserted: true },
  { ts: at(-1, '16:27'), mode: 'dictate', out: '中午和小王约了产品评审，带上最新的原型图。', app: 'WeChat', rec: '2026-10-19T16-27-09.wav', inserted: true },
  { ts: at(-1, '10:15'), mode: 'translate:ja', out: '来週の会議は火曜日の午後3時に変更になりました。', app: 'Mail', rec: '2026-10-19T10-15-31.wav', inserted: true },
  { ts: at(-2, '20:42'), mode: 'dictate', out: '把方舟的 key 换到 Agent Plan 那条通道，别走按量。', app: 'Terminal', rec: '2026-10-18T20-42-11.wav', inserted: true },
  { ts: at(-2, '14:02'), mode: 'dictate', out: '周末去趟超市，买牛奶、鸡蛋和咖啡豆。', app: 'Notes', rec: '', inserted: true },
  { ts: at(-3, '19:11'), mode: 'dictate', out: '用 Drizzle 写一个迁移脚本，先加索引再回填。', app: 'VS Code', rec: '2026-10-17T19-11-58.wav', inserted: true },
  { ts: at(-4, '10:36'), mode: 'ask', out: 'Bun 1.2 的冷启动比 Node 22 快约 3 倍，主要差在模块解析和 V8 snapshot。[1]', app: 'SaylessBar', rec: '', inserted: false },
  { ts: at(-5, '08:19'), mode: 'dictate', out: '提醒我周五之前把报价单发给客户，抄送财务。', app: 'Mail', rec: '2026-10-15T08-19-03.wav', inserted: true },
  { ts: at(-7, '22:05'), mode: 'dictate', out: '这个版本先把 hub 的历史搜索修好，再做快捷键编辑。', app: 'Slack', rec: '2026-10-13T22-05-17.wav', inserted: true },
  { ts: at(-12, '15:48'), mode: 'dictate', out: '测试一下新的 whisper 模型，看中文标点有没有改善。', app: 'Terminal', rec: '', inserted: true },
  { ts: at(-18, '11:22'), mode: 'translate:en', out: 'The release is blocked by the accessibility permission regression.', app: 'Slack', rec: '2026-10-02T11-22-45.wav', inserted: true },
  { ts: at(-26, '18:53'), mode: 'dictate', out: '国庆回来后先把语音链路压测一轮，再看交叉投票的耗时。', app: 'Notes', rec: '', inserted: true }
];

const daysSet = new Set(rawHistory.map(h => h.ts.slice(0, 10)));
for (let i = 1; i < 140; i++) {
  if (i % 3 === 0 || i % 7 === 2) daysSet.add(iso(-i));
}
const days = [...daysSet].sort();
const chars = rawHistory.reduce((n, h) => n + [...h.out].length, 0);

const dict = {
  replacements: [
    { from: '摆链', to: 'Bailian' },
    { from: '方舟', to: 'Ark' },
    { from: 'C Code', to: 'ZCode' },
    { from: '机光', to: '极光' }
  ],
  hotwords: ['ZCode', 'Bailian', 'Ark', 'MiniMax', 'whisper', 'Drizzle', 'OpenClaw', 'Tailscale'],
  styleRules: [
    '删除语气词（嗯、呃、就是说、然后然后）和重复词',
    '技术名词保留英文原文，不要翻译',
    '标点规范：中文用全角，代码/英文 token 前后不加中文标点',
    '统一转换为简体中文',
    '纠正同音/近音错别字（语音识别常见错误，如 擺鏈→百炼、蓄費→续费、C Code→ZCode）'
  ],
  apps: {
    Mail: { hotwords: ['Bailian', '方舟'], replacements: [{ from: '摆链', to: 'Bailian' }] },
    'VS Code': { hotwords: ['Drizzle', 'ZCode', 'Tailscale'], replacements: [] },
    WeChat: { hotwords: ['方舟'], replacements: [] }
  }
};

const providers = ['ark-plan', 'deepseek', 'zai', 'minimax', 'kimi', 'mimo-plan', 'stepfun-plan', 'dashscope'];
const cfg = {
  providers: Object.fromEntries(providers.map(p => [p, { baseUrl: 'https://example.invalid/v1' }])),
  asr: {
    adapter: 'whisper', language: 'zh', whisperBin: '/opt/homebrew/bin/whisper-cli',
    whisperModel: '/Users/leo/.sayless/ggml-base.bin', filterHallucinations: true
  },
  llm: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628', temperature: 0, retries: 2 },
  translate: { to: 'en', provider: 'deepseek', model: 'deepseek-flash' },
  ask: { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628', engines: ['bing', 'ddg'], maxResults: 5, proxy: '' },
  cross: {
    models: [
      { provider: 'zai', model: 'glm-5-turbo' },
      { provider: 'deepseek', model: 'deepseek-flash' },
      { provider: 'minimax', model: 'MiniMax-M3' },
      { provider: 'ark-plan', model: 'doubao-seed-2-1-turbo-260628' },
      { provider: 'mimo-plan', model: 'mimo-v2.6-flash' }
    ],
    arbiter: { provider: 'deepseek', model: 'deepseek-v4-flash-ga-260910' },
    similarity: 0.82, timeoutMs: 30000
  },
  insert: { mode: 'paste', restoreClipboard: true },
  sound: true, ptt: false,
  hotkeys: {
    dictate: { key: 49, modifier: 'option', label: 'Space' },
    translate: { key: 17, modifier: 'option', label: 'T' },
    ask: { key: 12, modifier: 'option', label: 'Q' }
  },
  workflows: { fast: {}, quality: { cross: true }, cloud: { cross: true } },
  activeWorkflow: 'fast'
};

const stats = {
  chars, entries: rawHistory.length, activeDays: days.length,
  streak: 6, longestStreak: 11, avgChars: Math.round(chars / rawHistory.length),
  today, recordings: rawHistory.filter(h => h.rec).length,
  recordingsBytes: rawHistory.filter(h => h.rec).length * 380000,
  modes: rawHistory.reduce((m, h) => { m[h.mode] = (m[h.mode] || 0) + 1; return m; }, {}),
  apps: rawHistory.reduce((m, h) => { m[h.app] = (m[h.app] || 0) + 1; return m; }, {})
};

const data = {
  version: '4.8.0', dataDir: '/Users/leo/.sayless', initialTab: 0,
  stats, days, history: rawHistory, dict, cfg,
  providers,
  providerKeys: { 'ark-plan': true, deepseek: true, zai: true, minimax: true, 'mimo-plan': true },
  env: {
    node: 'v22.14.0', whisperBinExists: true, whisperModelExists: true,
    ffmpegExists: true, configMode: '600', configExists: true, dictExists: true, plugins: []
  }
};

function safeJSON(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function chrome(args) {
  const r = spawnSync(CHROME, args, { encoding: 'utf8', timeout: 60000 });
  if (r.error) throw r.error;
  return r;
}

fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}\n可用 CHROME_BIN 指定路径。`);
  process.exit(1);
}
const tpl = fs.readFileSync(TPL, 'utf8');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sayless-hub-profile-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sayless-hub-pages-'));
const pages = [
  { name: 'hub-home', tab: 0, width: 1280, height: 860 },
  { name: 'hub-history', tab: 1, width: 1280, height: 900 },
  { name: 'hub-dict', tab: 2, width: 1280, height: 1100 },
  { name: 'hub-settings', tab: 3, width: 1280, height: 2900 }
];
for (const p of pages) {
  const htmlPath = path.join(work, `${p.name}.html`);
  const html = tpl.replace('__DATAJSON__', safeJSON({ ...data, initialTab: p.tab }));
  fs.writeFileSync(htmlPath, html);
  const shot = path.join(OUT, `${p.name}.png`);
  const r = chrome([
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${p.width},${p.height}`, `--screenshot=${shot}`,
    `--virtual-time-budget=1500`, `file://${htmlPath}`
  ]);
  if (!fs.existsSync(shot)) {
    console.error(`截图失败 ${p.name}：${r.stderr || r.stdout}`);
    process.exit(1);
  }
  console.log(`${p.name}: ${shot} (${(fs.statSync(shot).size / 1024).toFixed(0)} KB)`);
}

// DOM 检查：脚本报错会留下隐藏的 #js-error
const checkHtml = path.join(work, 'hub-check.html');
fs.writeFileSync(checkHtml, tpl.replace('__DATAJSON__', safeJSON(data)));
const dom = chrome([
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--virtual-time-budget=1500', '--dump-dom', `file://${checkHtml}`
]);
const domText = dom.stdout || '';
if (domText.includes('id="js-error"')) {
  const m = domText.match(/id="js-error"[^>]*>([^<]*)</);
  console.error(`hub 脚本报错：${m ? m[1] : '(未知)'}`);
  process.exit(2);
}
console.log('DOM 检查通过：无 js-error');
fs.rmSync(profile, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
