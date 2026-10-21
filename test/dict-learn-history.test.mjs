import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  tempDir, runCli, initCli, configPath, dictPath, historyPath, readJson, patchDict,
  seedHistory, readHistory
} from './helpers.mjs';

async function setup(t) {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  return dir;
}

test('dict：替换/热词/风格规则/应用词层管理', async (t) => {
  const dir = await setup(t);
  let r = await runCli(['dict', 'add', '摆链', 'Bailian'], { dir });
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(['dict', 'add-hot', 'ZCode'], { dir });
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(['dict', 'add-rule', '技术名词保留英文'], { dir });
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(['dict', 'app-add-hot', 'Mail', '方舟'], { dir });
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(['dict', 'app-add-replace', 'Mail', '摆链', 'Bailian'], { dir });
  assert.equal(r.code, 0, r.stderr);
  let d = readJson(dictPath(dir));
  assert.ok(d.replacements.some(x => x.from === '摆链' && x.to === 'Bailian'));
  assert.ok(d.hotwords.includes('ZCode'));
  assert.ok(d.styleRules.includes('技术名词保留英文'));
  assert.ok(d.apps.Mail.hotwords.includes('方舟'));
  assert.ok(d.apps.Mail.replacements.some(x => x.from === '摆链'));

  r = await runCli(['dict', 'app-del-hot', 'Mail', '方舟'], { dir });
  assert.equal(r.code, 0, r.stderr);
  r = await runCli(['dict', 'app-del-replace', 'Mail', '摆链'], { dir });
  assert.equal(r.code, 0, r.stderr);
  d = readJson(dictPath(dir));
  assert.ok(!d.apps.Mail.hotwords.includes('方舟'));
  assert.ok(!d.apps.Mail.replacements.some(x => x.from === '摆链'));

  r = await runCli(['dict', 'del-rule', '技术名词保留英文'], { dir });
  assert.equal(r.code, 0, r.stderr);
  d = readJson(dictPath(dir));
  assert.ok(!d.styleRules.includes('技术名词保留英文'));

  r = await runCli(['dict', 'app-del', 'Mail'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!readJson(dictPath(dir)).apps.Mail);
});

test('dict import / export / validate', async (t) => {
  const dir = await setup(t);
  const src = path.join(dir, 'import.txt');
  fs.writeFileSync(src, '摆链 => Bailian\n方舟→Ark\nZCode\n\n');
  let r = await runCli(['dict', 'import', src], { dir });
  assert.equal(r.code, 0, r.stderr);
  const d = readJson(dictPath(dir));
  assert.ok(d.replacements.some(x => x.from === '摆链'));
  assert.ok(d.replacements.some(x => x.from === '方舟'));
  assert.ok(d.hotwords.includes('ZCode'));

  const out = path.join(dir, 'dict-export.json');
  r = await runCli(['dict', 'export', out], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(out));
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);

  patchDict(dir, x => { x.replacements.push({ pattern: '[', to: 'x' }); });
  r = await runCli(['dict', 'validate'], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /无效正则/);
});

test('learn：智能 diff、反馈落盘、--mine --apply', async (t) => {
  const dir = await setup(t);
  let r = await runCli(['learn', '那个我们明天十点开个会', '我们明天十点开会'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /2 处差异/);
  assert.match(r.stdout, /开个会 → 开会/);
  assert.match(r.stdout, /那个 →/);
  const d = readJson(dictPath(dir));
  assert.ok(d.replacements.some(x => x.from === '开个会' && x.to === '开会'));
  assert.ok(d.hotwords.includes('开会'));
  const fb = path.join(dir, '.sayless', 'feedback.jsonl');
  assert.ok(fs.existsSync(fb));
  const feedback = fs.readFileSync(fb, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(feedback.length, 1);
  assert.ok(feedback[0].pairs.length >= 2);

  r = await runCli(['learn', '--mine'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /开个会 → 开会/);
  r = await runCli(['learn', '--mine', '--apply', '--min-count', '1'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已应用/);
  const d2 = readJson(dictPath(dir));
  assert.ok(d2.replacements.some(x => x.from === '开个会' && x.to === '开会'));
});

test('learn --last 取最近一条 raw；--dry-run 不写文件', async (t) => {
  const dir = await setup(t);
  seedHistory(dir, [{
    ts: new Date().toISOString(), mode: 'dictate', raw: '那个我们明天开个会', out: '我们明天开会'
  }]);
  const before = fs.readFileSync(dictPath(dir), 'utf8');
  let r = await runCli(['learn', '--last', '我们明天开会', '--dry-run'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(dictPath(dir), 'utf8'), before);
  assert.match(r.stdout, /dry-run/);
});

test('history：json / search / delete / export / clear', async (t) => {
  const dir = await setup(t);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  seedHistory(dir, [
    { ts: yesterday.toISOString(), mode: 'dictate', out: '昨天的会议纪要', raw: '昨天', app: 'Mail', rec: 'a.wav' },
    { ts: now.toISOString(), mode: 'translate:en', out: 'Today meeting notes', raw: '今天', app: 'WeChat', rec: 'b.wav' }
  ]);
  let r = await runCli(['history', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  let arr = JSON.parse(r.stdout);
  assert.equal(arr.length, 2);
  assert.equal(arr[0].out, 'Today meeting notes'); // 按时间倒序

  r = await runCli(['history', '--search', '昨天'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /昨天的会议纪要/);
  assert.doesNotMatch(r.stdout, /Today meeting notes/);

  const exported = path.join(dir, 'hist.json');
  r = await runCli(['history', '--export', exported], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(exported, 'utf8')).length, 2);

  r = await runCli(['history', '--delete', '1'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readHistory(dir).length, 1);
  assert.equal(readHistory(dir)[0].out, '昨天的会议纪要');

  r = await runCli(['history', '--clear'], { dir });
  assert.equal(r.code, 2);
  r = await runCli(['history', '--clear', '--force'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readHistory(dir).length, 0);
});

test('stats：条数/字数/活跃天/连续天/模式分布', async (t) => {
  const dir = await setup(t);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  seedHistory(dir, [
    { ts: yesterday.toISOString(), mode: 'dictate', out: '一二三', raw: '一二三' },
    { ts: now.toISOString(), mode: 'dictate', out: '四五六', raw: '四五六' },
    { ts: now.toISOString(), mode: 'ask', out: '答案', raw: '问题' }
  ]);
  const r = await runCli(['stats', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.entries, 3);
  assert.equal(s.chars, 8); // 3 + 3 + 2
  assert.equal(s.activeDays, 2);
  assert.equal(s.streak, 2);
  assert.equal(s.longestStreak, 2);
  assert.equal(s.modes.dictate, 2);
  assert.equal(s.modes.ask, 1);
  assert.equal(s.recordings, 0);
});

test('doctor --offline --json 输出结构化体检', async (t) => {
  const dir = await setup(t);
  const r = await runCli(['doctor', '--offline', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.version, '4.9.0');
  assert.equal(report.config.mode, '600');
  assert.equal(report.asr.adapter, 'whisper');
  assert.ok(Array.isArray(report.providers));
  assert.ok(report.providers.length >= 10);
  assert.equal(report.providers[0].status, undefined); // offline 不探测
});

test('doctor --json 对已配 key 的供应商做真实路由探测', async (t) => {
  const dir = await setup(t);
  const { startMockServer, patchConfig } = await import('./helpers.mjs');
  const mock = await startMockServer();
  t.after(() => mock.close());
  patchConfig(dir, c => {
    const ids = Object.keys(c.providers);
    c.providers = Object.fromEntries(ids.map(id => [id, { baseUrl: `${mock.base}/v1`, apiKey: 'test-key' }]));
  });
  const r = await runCli(['doctor', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.ok(report.providers.length >= 10);
  const ark = report.providers.find(p => p.name === 'ark-plan');
  assert.equal(ark.hasKey, true);
  assert.equal(ark.status, 200);
  assert.equal(mock.state.modelRequests.length, report.providers.length);
});

test('history --search 与 --delete 组合不会误删非匹配项', async (t) => {
  const dir = await setup(t);
  const now = new Date();
  seedHistory(dir, [
    { ts: new Date(now.getTime() - 3000).toISOString(), mode: 'dictate', out: 'apple one', raw: 'apple one' },
    { ts: new Date(now.getTime() - 2000).toISOString(), mode: 'dictate', out: 'apple two', raw: 'apple two' },
    { ts: new Date(now.getTime() - 1000).toISOString(), mode: 'dictate', out: 'banana', raw: 'banana' }
  ]);
  const r = await runCli(['history', '--search', 'apple', '--delete', '2'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const left = readHistory(dir);
  assert.equal(left.length, 2);
  assert.ok(left.some(e => e.out === 'apple two'));
  assert.ok(left.some(e => e.out === 'banana'), '非匹配的 banana 必须保留');
  assert.ok(!left.some(e => e.out === 'apple one'));
});

test('history --delete 空参数/越界不会清空历史', async (t) => {
  const dir = await setup(t);
  seedHistory(dir, [
    { ts: new Date().toISOString(), mode: 'dictate', out: 'keep me', raw: 'keep me' }
  ]);
  const before = fs.readFileSync(historyPath(dir), 'utf8');
  let r = await runCli(['history', '--delete='], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--delete 需要一个序号/);
  assert.equal(fs.readFileSync(historyPath(dir), 'utf8'), before);
  r = await runCli(['history', '--delete', '99'], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /超出范围/);
  assert.equal(fs.readFileSync(historyPath(dir), 'utf8'), before);
});

test('learn --mine --apply --dry-run 不改词库', async (t) => {
  const dir = await setup(t);
  await runCli(['learn', '那个我们明天十点开个会', '我们明天十点开会'], { dir });
  const before = fs.readFileSync(dictPath(dir), 'utf8');
  const r = await runCli(['learn', '--mine', '--apply', '--min-count', '1', '--dry-run'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.equal(fs.readFileSync(dictPath(dir), 'utf8'), before);
});

test('history --delete 支持按界面上的本地日期/时间删除', async (t) => {
  const dir = await setup(t);
  seedHistory(dir, [
    { ts: '2026-10-20T17:30:00.000Z', mode: 'dictate', out: 'local day test', raw: 'x' }
  ]);
  const r = await runCli(['history', '--delete', '2026-10-21'], { dir, env: { TZ: 'Asia/Shanghai' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readHistory(dir).length, 0);
});

test('dict validate 会检查分应用词层的替换规则', async (t) => {
  const dir = await setup(t);
  patchDict(dir, d => {
    d.apps = { Mail: { hotwords: [], replacements: [{ pattern: '[', to: 'x' }] } };
  });
  const r = await runCli(['dict', 'validate'], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Mail 替换/);
  assert.match(r.stdout, /无效正则/);
});

test('history --json 默认返回全部（不再静默截断 200）', async (t) => {
  const dir = await setup(t);
  const now = Date.now();
  seedHistory(dir, Array.from({ length: 205 }, (_, i) => ({
    ts: new Date(now - i * 1000).toISOString(), mode: 'dictate', out: `entry ${i}`, raw: `entry ${i}`
  })));
  const r = await runCli(['history', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 205);
});

test('history -n 空值使用默认值而不是 0', async (t) => {
  const dir = await setup(t);
  seedHistory(dir, [
    { ts: '2026-10-20T10:00:00.000Z', mode: 'dictate', out: 'a', raw: 'a' },
    { ts: '2026-10-20T11:00:00.000Z', mode: 'dictate', out: 'b', raw: 'b' }
  ]);
  const r = await runCli(['history', '-n', '', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 2);
});

test('dict import 支持 JSON 词库合并，并拒绝坏 JSON', async (t) => {
  const dir = await setup(t);
  const file = path.join(dir, 'import-dict.json');
  fs.writeFileSync(file, JSON.stringify({
    replacements: [{ from: '甲', to: 'A' }],
    hotwords: ['XCode'],
    styleRules: ['JSON 规则'],
    apps: { Mail: { hotwords: ['MailHot'], replacements: [{ from: '乙', to: 'B' }] } }
  }));
  let r = await runCli(['dict', 'import', file], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /JSON 合并/);
  const d = readJson(dictPath(dir));
  assert.ok(d.replacements.some(x => x.from === '甲' && x.to === 'A'));
  assert.ok(d.hotwords.includes('XCode'));
  assert.ok(d.styleRules.includes('JSON 规则'));
  assert.ok(d.apps.Mail.hotwords.includes('MailHot'));
  assert.ok(d.apps.Mail.replacements.some(x => x.from === '乙' && x.to === 'B'));

  const bad = path.join(dir, 'bad-dict.json');
  fs.writeFileSync(bad, '{bad json');
  r = await runCli(['dict', 'import', bad], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /JSON 解析失败/);
});
