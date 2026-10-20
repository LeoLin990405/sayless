import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  tempDir, runCli, initCli, pointAtMock, startMockServer, makeWav, makeFakeFfmpeg,
  patchConfig, patchDict, readHistory, readJson, configPath, dictPath, lastChat, systemOf, userOf
} from './helpers.mjs';

async function setup(t, { asrText = '那个我们明天十点开会' } = {}) {
  const dir = tempDir();
  const mock = await startMockServer();
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  t.after(() => mock.close());
  await initCli(dir);
  pointAtMock(dir, mock);
  mock.state.asrText = asrText;
  mock.state.chatResponder = () => '我们明天十点开会。';
  const wav = makeWav(path.join(dir, 'input.wav'));
  return { dir, mock, wav };
}

test('transcribe：ASR → 润色 → 历史 → 录音归档', async (t) => {
  const { dir, mock, wav } = await setup(t);
  const r = await runCli(['transcribe', wav, '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /我们明天十点开会。/);
  assert.match(r.stderr, /RESULT_JSON:/);
  const jsonLine = r.stderr.split('\n').find(l => l.startsWith('RESULT_JSON:'));
  const result = JSON.parse(jsonLine.slice('RESULT_JSON:'.length));
  assert.equal(result.out, '我们明天十点开会。');
  assert.equal(result.mode, 'dictate');
  assert.ok(result.ts, 'RESULT_JSON 必须带 ts，App 才能精确更新 inserted');
  assert.ok(result.rec.endsWith('.wav'));
  assert.equal(mock.state.asrRequests.length, 1);
  assert.equal(mock.state.chatRequests.length, 1);
  const hist = readHistory(dir);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].mode, 'dictate');
  assert.equal(hist[0].inserted, false);
  assert.ok(hist[0].timings.asr >= 0);
  const recDir = path.join(dir, '.sayless', 'recordings');
  const files = fs.readdirSync(recDir);
  assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(recDir, files[0])).mode & 0o777, 0o600);
});

test('transcribe：空 ASR / 静音 → 非零退出且不写历史', async (t) => {
  const { dir, wav } = await setup(t, { asrText: '' });
  const r = await runCli(['transcribe', wav, '--no-insert'], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /语音识别结果为空/);
  assert.equal(readHistory(dir).length, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.sayless', 'recordings', 'x')));
});

test('transcribe --raw：跳过 LLM，只过词语库', async (t) => {
  const { dir, mock, wav } = await setup(t, { asrText: '方舟和百炼' });
  mock.state.chatResponder = () => { throw new Error('raw 模式不应该调用 LLM'); };
  const r = await runCli(['transcribe', wav, '--raw', '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.state.chatRequests.length, 0);
  assert.match(r.stdout, /Ark和Bailian/);
  assert.equal(readHistory(dir)[0].mode, 'raw');
});

test('transcribe：分应用词层注入 system prompt', async (t) => {
  const { dir, mock, wav } = await setup(t, { asrText: '方舟' });
  patchDict(dir, d => {
    d.apps = { Mail: { hotwords: ['方舟', 'Bailian'], replacements: [{ from: '方舟', to: 'Ark' }] } };
  });
  mock.state.chatResponder = () => 'Ark';
  const r = await runCli(['transcribe', wav, '--no-insert', '--app', 'Mail'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const sys = systemOf(lastChat(mock.state));
  assert.match(sys, /方舟/);
  assert.match(sys, /Bailian/);
  const hist = readHistory(dir);
  assert.equal(hist[0].app, 'Mail');
  assert.equal(hist[0].raw, '方舟'); // raw 记录 ASR 原文，不做词典替换
});

test('插件 onPolish 钩子生效', async (t) => {
  const { dir, wav } = await setup(t);
  const pluginDir = path.join(dir, '.sayless', 'plugins');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'suffix.mjs'), `
export const name = 'test suffix';
export async function onPolish(text) { return text + '【插件】'; }
`);
  const r = await runCli(['transcribe', wav, '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /我们明天十点开会。 【插件】|我们明天十点开会。 【插件】|【插件】/);
  assert.match(r.stderr, /已加载 1 个插件/);
});

test('translate 命令：目标语言提示正确', async (t) => {
  const { dir, mock } = await setup(t);
  mock.state.chatResponder = () => 'Hello, world.';
  const r = await runCli(['translate', '你好，世界', '--to', 'en'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Hello, world\./);
  assert.match(systemOf(lastChat(mock.state)), /英语/);
});

test('ask --no-search：不联网，提示模型标注未核实', async (t) => {
  const { dir, mock } = await setup(t);
  mock.state.chatResponder = () => '答案';
  const r = await runCli(['ask', '今天汇率', '--no-search'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /答案/);
  assert.match(userOf(lastChat(mock.state)), /未联网/);
});

test('transcribe --translate：模式与输出正确', async (t) => {
  const { dir, mock, wav } = await setup(t, { asrText: '你好世界' });
  mock.state.chatResponder = () => 'Hello world';
  const r = await runCli(['transcribe', wav, '--translate', 'en', '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Hello world');
  assert.equal(readHistory(dir)[0].mode, 'translate:en');
  assert.match(systemOf(lastChat(mock.state)), /英语/);
});

test('--workflow fast 不再覆盖用户选择的 ASR 引擎', async (t) => {
  const { dir, mock, wav } = await setup(t);
  const r = await runCli(['transcribe', wav, '--workflow', 'fast', '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.state.asrRequests.length, 1);
});

test('polish --dry-run：词典替换中的 $ 原样保留', async (t) => {
  const dir = tempDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await initCli(dir);
  patchDict(dir, d => { d.replacements = [{ from: '价格', to: '$100' }]; });
  const r = await runCli(['polish', '价格', '--dry-run'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '$100');
  assert.equal(r.stderr.trim(), '');
});

test('无效正则只告警，不阻塞听写', async (t) => {
  const { dir, wav } = await setup(t);
  patchDict(dir, d => { d.replacements = [{ pattern: '[', to: 'x' }]; });
  const r = await runCli(['transcribe', wav, '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /无效正则/);
});

test('留空模型不会被 fillDefaults 填回，实际请求使用 provider 默认模型', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => {
    c.llm.model = '';
    c.providers['ark-plan'].model = 'provider-default-model';
  });
  mock.state.chatResponder = () => '默认模型结果';
  const r = await runCli(['polish', '原文'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '默认模型结果');
  assert.equal(lastChat(mock.state).model, 'provider-default-model');
  assert.equal(readJson(configPath(dir)).llm.model, '');
});

test('translate 空 model 使用翻译 provider 自己的默认模型', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => {
    c.providers.p2 = { baseUrl: `${mock.base}/v1`, apiKey: 'k', model: 'p2-default' };
    c.translate = { to: 'en', provider: 'p2', model: '' };
  });
  mock.state.chatResponder = () => 'translated';
  const r = await runCli(['translate', '你好', '--to', 'en'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'translated');
  assert.equal(lastChat(mock.state).model, 'p2-default');
  assert.equal(readJson(configPath(dir)).translate.model, '');
});

test('transcribe --translate 后直接跟 --app 时仍能定位音频', async (t) => {
  const { dir, mock, wav } = await setup(t, { asrText: '你好世界' });
  mock.state.chatResponder = () => 'Hello world';
  const r = await runCli(['transcribe', '--translate', '--app', 'Mail', wav, '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Hello world');
  const hist = readHistory(dir);
  assert.equal(hist[0].mode, 'translate:en');
  assert.equal(hist[0].app, 'Mail');
});

test('translate 使用分应用词层的热词注入', async (t) => {
  const { dir, mock, wav } = await setup(t, { asrText: '你好' });
  patchDict(dir, d => {
    d.apps = { Mail: { hotwords: ['Bailian'], replacements: [] } };
  });
  mock.state.chatResponder = () => 'hello';
  const r = await runCli(['transcribe', wav, '--translate', 'en', '--app', 'Mail', '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(systemOf(lastChat(mock.state)), /Bailian/);
});

test('ASR 网络失败以 exit 3 报告，而不是通用 exit 1', async (t) => {
  const { dir, wav } = await setup(t);
  patchConfig(dir, c => { c.asr.baseUrl = 'http://127.0.0.1:1/v1'; });
  const r = await runCli(['transcribe', wav, '--no-insert'], { dir });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /ASR 网络错误/);
  assert.equal(readHistory(dir).length, 0);
});

test('SAYLESS_API_KEY 只做兜底，配置里的 provider key 优先', async (t) => {
  const { dir, mock } = await setup(t);
  mock.state.chatResponder = () => 'ok';
  const r = await runCli(['polish', '原文'], { dir, env: { SAYLESS_API_KEY: 'env-key' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.state.chatHeaders.at(-1).authorization, 'Bearer test-key');
});

test('删除 translate.model 后不会被 fillDefaults 填回，使用 provider 默认', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => {
    c.providers.p2 = { baseUrl: `${mock.base}/v1`, apiKey: 'k', model: 'p2-default' };
    c.translate = { to: 'en', provider: 'p2' };
    c.llm.model = 'llm-model-should-not-leak';
  });
  mock.state.chatResponder = () => 'translated';
  const r = await runCli(['translate', '你好', '--to', 'en'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastChat(mock.state).model, 'p2-default');
  assert.equal(readJson(configPath(dir)).translate.model, undefined);
});

test('删除 llm.model 后使用 provider 默认模型', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => {
    c.providers['ark-plan'].model = 'ark-provider-default';
    delete c.llm.model;
  });
  mock.state.chatResponder = () => 'ok';
  const r = await runCli(['polish', '原文'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(lastChat(mock.state).model, 'ark-provider-default');
  assert.equal(readJson(configPath(dir)).llm.model, undefined);
});

test('分应用替换在 LLM 输出之后仍然生效', async (t) => {
  const { dir, mock, wav } = await setup(t, { asrText: '源词' });
  patchDict(dir, d => {
    d.apps = { Mail: { hotwords: [], replacements: [{ from: '源词', to: '目标词' }] } };
  });
  mock.state.chatResponder = () => '源词';
  const r = await runCli(['transcribe', wav, '--app', 'Mail', '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '目标词');
});

test('insert.mode=none 时历史与 RESULT_JSON 的 inserted 为 false', async (t) => {
  const { dir, mock, wav } = await setup(t);
  patchConfig(dir, c => { c.insert = { ...(c.insert || {}), mode: 'none' }; });
  mock.state.chatResponder = () => '只输出不粘贴';
  const r = await runCli(['transcribe', wav], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /只输出不粘贴/);
  const jsonLine = r.stderr.split('\n').find(l => l.startsWith('RESULT_JSON:'));
  assert.equal(JSON.parse(jsonLine.slice('RESULT_JSON:'.length)).inserted, false);
  assert.equal(readHistory(dir)[0].inserted, false);
});

test('--translate 接受 en-US 并归一化为 en', async (t) => {
  const { dir, mock, wav } = await setup(t, { asrText: '你好' });
  mock.state.chatResponder = () => 'Hello';
  const r = await runCli(['transcribe', '--translate', 'en-US', wav, '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Hello');
  assert.equal(readHistory(dir)[0].mode, 'translate:en');
});

test('未知 ASR adapter 直接失败，不会回落到云端端点', async (t) => {
  const { dir, mock, wav } = await setup(t);
  patchConfig(dir, c => { c.asr.adapter = 'lokcal-whisper-typo'; });
  const r = await runCli(['asr', wav], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知 ASR adapter/);
  assert.equal(mock.state.asrRequests.length, 0);
});

test('cross 行内空 model 使用该 provider 的默认模型', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => {
    c.providers.p2 = { baseUrl: `${mock.base}/v1`, apiKey: 'k', model: 'p2-default' };
    c.providers.p3 = { baseUrl: `${mock.base}/v1`, apiKey: 'k', model: 'p3-default' };
    c.llm = { provider: 'm1', model: 'base-model', temperature: 0, retries: 0, timeoutMs: 5000 };
    c.cross.models = [
      { provider: 'p2', model: '' },
      { provider: 'p3' }
    ];
  });
  mock.state.chatResponder = () => '一致结果';
  const r = await runCli(['polish', '原文', '--cross'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const models = mock.state.chatRequests.map(x => x.model).sort();
  assert.deepEqual(models, ['p2-default', 'p3-default']);
  assert.equal(r.stdout.trim(), '一致结果');
});

test('stats 使用完整字符数，不受历史 out 截断影响', async (t) => {
  const { dir, mock, wav } = await setup(t);
  mock.state.chatResponder = () => '长'.repeat(1500);
  const r = await runCli(['transcribe', wav, '--no-insert'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const h = readHistory(dir).at(-1);
  assert.equal(h.out.length, 1000);
  assert.equal(h.chars, 1500);
  const s = JSON.parse((await runCli(['stats', '--json'], { dir })).stdout);
  assert.equal(s.chars, 1500);
});
