import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = fs.readFileSync(path.join(ROOT, 'app', 'hub.html'), 'utf8');
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

function demoData() {
  return {
    version: '4.7.0',
    dataDir: '/tmp/sayless-demo',
    initialTab: 0,
    stats: {
      chars: 42, entries: 2, activeDays: 2, streak: 2, longestStreak: 2, avgChars: 21,
      today: '2026-10-20', recordings: 1, recordingsBytes: 2000,
      modes: { dictate: 1, 'translate:en': 1 }, apps: { Mail: 1 }
    },
    days: ['2026-10-19', '2026-10-20'],
    history: [
      { ts: '2026-10-20T12:00:00.000Z', mode: 'dictate', out: '第一条 <script>alert(1)</script>', raw: '第一条原始 ASR', app: 'Mail', rec: 'a.wav', inserted: true, timings: { asr: 12, llm: 34, total: 50 } },
      { ts: '2026-10-19T11:00:00.000Z', mode: 'translate:en', out: 'Second entry', raw: '第二条原始', app: 'Slack', rec: '', inserted: false, timings: { asr: 8, llm: 20, total: 30 } }
    ],
    dict: {
      replacements: [{ from: '摆链', to: 'Bailian' }],
      hotwords: ['ZCode'],
      styleRules: ['删除语气词'],
      apps: { Mail: { hotwords: ['方舟'], replacements: [{ from: '摆链', to: 'Bailian' }] } }
    },
    cfg: {
      providers: { 'ark-plan': { baseUrl: 'https://example.invalid/v1' }, deepseek: { baseUrl: 'https://example.invalid/v1' } },
      asr: { adapter: 'whisper', language: 'zh', whisperBin: '/opt/homebrew/bin/whisper-cli', whisperModel: '/tmp/ggml.bin', filterHallucinations: true },
      llm: { provider: 'ark-plan', model: 'mock-model', temperature: 0, retries: 2 },
      translate: { to: 'en', provider: 'deepseek', model: 'mock-tr' },
      ask: { provider: 'ark-plan', model: 'mock-model', engines: ['bing', 'ddg'], maxResults: 5, proxy: '' },
      cross: { models: [{ provider: 'ark-plan', model: 'a' }, { provider: 'deepseek', model: 'b' }], arbiter: { provider: 'deepseek', model: 'arb' }, similarity: 0.82, timeoutMs: 30000 },
      insert: { mode: 'paste', restoreClipboard: true },
      sound: true, ptt: false,
      hotkeys: { dictate: { key: 49, modifier: 'option', label: 'Space' }, translate: { key: 17, modifier: 'option', label: 'T' }, ask: { key: 12, modifier: 'option', label: 'Q' } },
      workflows: { fast: {}, quality: {}, cloud: {} },
      activeWorkflow: 'fast'
    },
    providers: ['ark-plan', 'deepseek'],
    providerKeys: { 'ark-plan': true, deepseek: false },
    env: { node: 'v22.0.0', whisperBinExists: true, whisperModelExists: true, ffmpegExists: true, configMode: '600', configExists: true, dictExists: true, plugins: [] }
  };
}

test('hub 模板只有一个数据占位符，注入后是合法 JS', () => {
  const placeholders = TPL.match(/__[A-Z0-9_]+__/g) || [];
  assert.deepEqual([...new Set(placeholders)], ['__DATAJSON__']);
  assert.equal(placeholders.length, 1);
  const script = TPL.match(/<script>([\s\S]*)<\/script>/)[1];
  const safe = JSON.stringify(demoData()).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const js = script.replace('__DATAJSON__', safe);
  assert.doesNotThrow(() => new Function(js));
});

test('hub 注入 JSON 不会闭合 script 标签', () => {
  const evil = demoData();
  evil.history[0].out = '</script><script>window.pwned=1</script>';
  const safe = JSON.stringify(evil).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const html = TPL.replace('__DATAJSON__', safe);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(safe.includes('\\u003c/script\\u003e'));
});

test('hub 在 Chrome 中渲染且无 JS 错误', { skip: !fs.existsSync(CHROME) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayless-hub-test-'));
  try {
    const data = demoData();
    const safe = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const htmlPath = path.join(dir, 'hub.html');
    fs.writeFileSync(htmlPath, TPL.replace('__DATAJSON__', safe));
    const r = spawnSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=1500',
      '--dump-dom', `file://${htmlPath}`
    ], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const dom = r.stdout || '';
    assert.doesNotMatch(dom, /id="js-error"/);
    assert.match(dom, /第一条/);
    assert.match(dom, /Bailian/);
    assert.match(dom, /Home|首页|说话，不要打字/);
    assert.match(dom, /运行状态/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub 空配置（无 config/hotkeys/providers）也能正常渲染', { skip: !fs.existsSync(CHROME) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayless-hub-empty-'));
  try {
    const empty = {
      version: '4.7.0', dataDir: '/tmp/fresh', initialTab: 0,
      stats: {}, days: [], history: [],
      dict: { replacements: [], hotwords: [], styleRules: [], apps: {} },
      cfg: {}, providers: [], providerKeys: {}, env: { configExists: false, dictExists: false }
    };
    const safe = JSON.stringify(empty).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const htmlPath = path.join(dir, 'hub.html');
    fs.writeFileSync(htmlPath, TPL.replace('__DATAJSON__', safe));
    const r = spawnSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=1500',
      '--dump-dom', `file://${htmlPath}`
    ], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const dom = r.stdout || '';
    assert.doesNotMatch(dom, /id="js-error"/);
    assert.match(dom, /说话，不要打字/);
    assert.match(dom, /class="tab on"/);
    assert.match(dom, /尚未初始化配置/);
    assert.match(dom, /id="setup-banner"/);
    assert.doesNotMatch(dom, /id="setup-banner" hidden/);
    assert.match(dom, /data-act="init-config"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub 的模型留空提交空字符串（配合 CLI 的 provider 默认模型）', () => {
  assert.match(TPL, /var modelValue = function \(id\)/);
  assert.doesNotMatch(TPL, /modelOrNull|model: .*null/);
  assert.match(TPL, /model: modelValue\('#s-llm-model'\)/);
});


test('hub 设置页展示 provider key 状态，历史页展示详情入口', { skip: !fs.existsSync(CHROME) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayless-hub-features-'));
  try {
    const render = (tab) => {
      const data = demoData();
      data.initialTab = tab;
      const safe = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
      const p = path.join(dir, `hub-${tab}.html`);
      fs.writeFileSync(p, TPL.replace('__DATAJSON__', safe));
      const r = spawnSync(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(dir, `profile-${tab}`)}`, '--virtual-time-budget=1500',
        '--dump-dom', `file://${p}`
      ], { encoding: 'utf8', timeout: 60000 });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout || '';
    };
    const settings = render(3);
    assert.doesNotMatch(settings, /id="js-error"/);
    assert.match(settings, /provider-status/);
    assert.match(settings, /已配置/);
    const history = render(1);
    assert.doesNotMatch(history, /id="js-error"/);
    assert.match(history, /data-act="toggle-detail"/);
    assert.match(history, /ASR 原文/);
    assert.match(history, /第一条原始 ASR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('hub 写操作使用 native 结果回调，不先报成功', () => {
  assert.match(TPL, /window\.hubActionResult/);
  assert.match(TPL, /postWithCallback/);
  assert.match(TPL, /id="home-status"/);
  assert.doesNotMatch(TPL, /toast\('已添加替换'\)/);
  assert.doesNotMatch(TPL, /toast\('已删除记录'\)/);
});
