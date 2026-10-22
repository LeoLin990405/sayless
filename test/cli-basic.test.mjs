import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, runCli, initCli, configPath, dictPath, readJson, patchConfig, makeWav, makeFakeFfmpeg, runCli as run } from './helpers.mjs';

test('init 创建配置与词语库，权限收紧，可重复执行', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await initCli(dir);
  assert.match(r.stdout, /配置就绪/);
  assert.ok(fs.existsSync(configPath(dir)));
  assert.ok(fs.existsSync(dictPath(dir)));
  assert.equal(fs.statSync(configPath(dir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dictPath(dir)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(configPath(dir))).mode & 0o777, 0o700);
  const cfg = readJson(configPath(dir));
  assert.ok(cfg.providers['ark-plan'].baseUrl);
  assert.ok(cfg.workflows.fast && cfg.workflows.quality && cfg.workflows.cloud);
  assert.equal(cfg.llm.retries, 2);
  assert.equal(cfg.insert.restoreClipboard, true);
  // 二次 init 不破坏已有配置
  patchConfig(dir, c => { c.customMarker = 'keep-me'; });
  const r2 = await initCli(dir);
  assert.equal(r2.code, 0);
  assert.equal(readJson(configPath(dir)).customMarker, 'keep-me');
});

test('version / help / 未知命令', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const v = await runCli(['version'], { dir });
  assert.equal(v.code, 0);
  assert.match(v.stdout, /sayless 7\.0\.0/);
  const h = await runCli(['--help'], { dir });
  assert.equal(h.code, 0);
  assert.match(h.stdout, /sayless doctor/);
  const u = await runCli(['nonsense'], { dir });
  assert.equal(u.code, 2);
  assert.match(u.stderr, /未知命令/);
});

test('配置损坏时给出可操作错误，不覆盖文件', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  const p = configPath(dir);
  fs.writeFileSync(p, '{ this is not json');
  const r = await runCli(['polish', 'x', '--dry-run'], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /config\.json 解析失败/);
  assert.equal(fs.readFileSync(p, 'utf8'), '{ this is not json');
});

test('配置迁移补齐新字段但不覆盖用户值', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  patchConfig(dir, c => {
    delete c.llm.retries;
    delete c.rec;
    delete c.recordings;
    c.llm.model = 'my-custom-model';
    c.providers['ark-plan'].apiKey = 'secret-key';
  });
  const r = await runCli(['polish', '测试', '--dry-run'], { dir });
  assert.equal(r.code, 0);
  const cfg = readJson(configPath(dir));
  assert.equal(cfg.llm.retries, 2);
  assert.ok(cfg.rec && cfg.recordings);
  assert.equal(cfg.llm.model, 'my-custom-model');
  assert.equal(cfg.providers['ark-plan'].apiKey, 'secret-key');
});

test('SAYLESS_DIR 隔离数据目录', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const custom = path.join(dir, 'custom-data');
  const r = await runCli(['init'], { dir, env: { SAYLESS_DIR: custom } });
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(custom, 'config.json')));
  assert.ok(!fs.existsSync(configPath(dir)));
});

test('rec 使用可配置 ffmpeg，产物权限 600；run 等录音结束再转写', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  const fixture = makeWav(path.join(dir, 'fixture.wav'));
  const fake = makeFakeFfmpeg(path.join(dir, 'fake-ffmpeg'), fixture);
  patchConfig(dir, c => { c.rec = c.rec || {}; c.rec.ffmpeg = fake; });

  const rec = await runCli(['rec', '--sec', '1', '-o', path.join(dir, 'out.wav')], { dir });
  assert.equal(rec.code, 0, rec.stderr);
  assert.ok(fs.statSync(path.join(dir, 'out.wav')).size > 1000);
  assert.equal(fs.statSync(path.join(dir, 'out.wav')).mode & 0o777, 0o600);

  // 直接调 run：ASR/LLM 指向 mock，确认 run 会等待假 ffmpeg 写完音频
  const { startMockServer, pointAtMock } = await import('./helpers.mjs');
  const mock = await startMockServer();
  t.after(() => mock.close());
  pointAtMock(dir, mock);
  mock.state.chatResponder = () => '我们明天十点开会。';
  const runRes = await runCli(['run', '--sec', '1', '--no-insert'], { dir });
  assert.equal(runRes.code, 0, runRes.stderr);
  assert.equal(mock.state.asrRequests.length, 1);
  assert.match(runRes.stdout, /我们明天十点开会/);
});

test('--workflow 不会被写进 config，也不会污染下一次运行', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  patchConfig(dir, c => {
    c.asr.adapter = 'openai';
    delete c.llm.retries; // 触发一次迁移写入，最容易把 _workflow 一起写进去
  });
  let r = await runCli(['doctor', '--offline', '--json', '--workflow', 'cloud'], { dir });
  assert.equal(r.code, 0, r.stderr);
  let report = JSON.parse(r.stdout);
  assert.equal(report.asr.adapter, 'ark-ws'); // 显式 workflow 当次生效
  let cfg = readJson(configPath(dir));
  assert.equal(Object.prototype.hasOwnProperty.call(cfg, '_workflow'), false);
  assert.equal(cfg.asr.adapter, 'openai');

  r = await runCli(['doctor', '--offline', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  report = JSON.parse(r.stdout);
  assert.equal(report.asr.adapter, 'openai', '下一次运行不能被旧 workflow 改回云端 ASR');
});

test('-- 之后的参数按位置文本处理，不解析旗标', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  const r = await runCli(['polish', '--dry-run', '--', '-dash-text'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '-dash-text');
});

test('rec -o 输出文件在录制期间就已是 0600', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  const fixture = makeWav(path.join(dir, 'fixture.wav'));
  const fake = path.join(dir, 'slow-ffmpeg');
  fs.writeFileSync(fake, `#!/bin/sh\nfor last; do :; done\nsleep 1.5\ncp '${fixture}' "$last"\n`);
  fs.chmodSync(fake, 0o755);
  patchConfig(dir, c => { c.rec = { ...(c.rec || {}), ffmpeg: fake }; });
  const out = path.join(dir, 'shared', 'rec.wav');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const p = runCli(['rec', '--sec', '1', '-o', out], { dir, timeoutMs: 30000 });
  let mode = null;
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 50));
    if (fs.existsSync(out)) { mode = fs.statSync(out).mode & 0o777; break; }
  }
  assert.equal(mode, 0o600, '录制期间文件权限必须是 0600');
  const r = await p;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('未知参数会告警而不是静默忽略', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  const r = await runCli(['polish', '--dry-run', '--no-serach', '文本'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /未知参数/);
  assert.equal(r.stdout.trim(), '文本');
});

test('plugin 命令显示加载失败，而不是误报未安装', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  const pluginDir = path.join(dir, '.sayless', 'plugins');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'broken.mjs'), 'export const x = ;\n');
  const r = await runCli(['plugin'], { dir });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /插件加载失败/);
  assert.match(r.stdout, /broken\.mjs/);
});

test('doctor 显示 effective model 与显式 workflow，不出现 undefined', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  patchConfig(dir, c => {
    c.providers['ark-plan'].model = 'ark-provider-default';
    delete c.llm.model;
    delete c.translate.model;
    delete c.ask.model;
  });
  let r = await runCli(['doctor', '--offline', '--json'], { dir });
  assert.equal(r.code, 0, r.stderr);
  let report = JSON.parse(r.stdout);
  assert.equal(report.pipeline.llm, 'ark-plan/ark-provider-default');
  assert.doesNotMatch(JSON.stringify(report.pipeline), /undefined/);
  assert.equal(report.pipeline.workflow, 'fast');

  r = await runCli(['doctor', '--offline', '--json', '--workflow', 'cloud'], { dir });
  assert.equal(r.code, 0, r.stderr);
  report = JSON.parse(r.stdout);
  assert.equal(report.pipeline.workflow, 'cloud');
  assert.equal(report.pipeline.llm, 'ark-plan/doubao-seed-2-1-pro-260915');
});
