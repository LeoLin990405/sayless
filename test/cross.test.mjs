import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  tempDir, runCli, initCli, startMockServer, patchConfig, lastChat
} from './helpers.mjs';

async function setup(t) {
  const dir = tempDir();
  const mock = await startMockServer();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => mock.close());
  await initCli(dir);
  patchConfig(dir, c => {
    c.providers = {
      m1: { baseUrl: `${mock.base}/v1`, apiKey: 'k' },
      m2: { baseUrl: `${mock.base}/v1`, apiKey: 'k' },
      m3: { baseUrl: `${mock.base}/v1`, apiKey: 'k' },
      m4: { baseUrl: `${mock.base}/v1`, apiKey: 'k' }
    };
    c.llm = { provider: 'm1', model: 'base', temperature: 0, retries: 0, timeoutMs: 5000 };
    c.cross = {
      models: [
        { provider: 'm1', model: 'a' },
        { provider: 'm2', model: 'b' },
        { provider: 'm3', model: 'c' }
      ],
      arbiter: { provider: 'm4', model: 'arb' },
      similarity: 0.82,
      timeoutMs: 5000
    };
  });
  return { dir, mock };
}

test('--cross：多数共识，不发仲裁', async (t) => {
  const { dir, mock } = await setup(t);
  mock.state.chatResponder = (body) => ({
    a: '我们明天十点开会。',
    b: '我们明天十点开会。',
    c: '这完全是另一句话。'
  }[body.model] || '?');
  const r = await runCli(['polish', '那个我们明天十点开会', '--cross'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '我们明天十点开会。');
  assert.equal(mock.state.chatRequests.length, 3);
  assert.doesNotMatch(r.stderr, /仲裁/);
});

test('--cross：全分歧时仲裁模型裁决', async (t) => {
  const { dir, mock } = await setup(t);
  mock.state.chatResponder = (body) => ({
    a: '甲甲甲甲', b: '乙乙乙乙', c: '丙丙丙丙', arb: 'FINAL-ANSWER'
  }[body.model] || '?');
  const r = await runCli(['polish', '原始文本', '--cross'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'FINAL-ANSWER');
  assert.equal(mock.state.chatRequests.length, 4);
  assert.equal(lastChat(mock.state).model, 'arb');
  assert.match(r.stderr, /全分歧/);
});

test('--cross：单模型阵容回退单模型并告警', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => { c.cross.models = [{ provider: 'm1', model: 'a' }]; });
  mock.state.chatResponder = () => '单模型结果';
  const r = await runCli(['polish', '原文', '--cross'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '单模型结果');
  assert.equal(mock.state.chatRequests.length, 1);
  assert.match(r.stderr, /至少 2 个不同模型/);
});

test('LLM 5xx 自动重试并最终成功', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => { c.llm.retries = 2; c.llm.timeoutMs = 5000; });
  mock.state.chatFailures = 2;
  mock.state.chatResponder = () => '重试后成功';
  const r = await runCli(['polish', '原文'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '重试后成功');
  assert.equal(mock.state.chatRequests.length, 3);
  assert.match(r.stderr, /重试/);
});

test('LLM 401 不重试，立即失败', async (t) => {
  const { dir, mock } = await setup(t);
  patchConfig(dir, c => { c.llm.retries = 3; });
  mock.state.chatStatus = 401;
  const r = await runCli(['polish', '原文'], { dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /LLM 401/);
  assert.equal(mock.state.chatRequests.length, 1);
});

test('未知 provider 不发起请求', async (t) => {
  const { dir, mock } = await setup(t);
  const r = await runCli(['polish', '原文', '--provider', 'missing'], { dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /未知 provider 或缺少 baseUrl/);
  assert.equal(mock.state.chatRequests.length, 0);
});

test('插件注册的 --workflow 预设生效', async (t) => {
  const { dir, mock } = await setup(t);
  const pluginDir = `${dir}/.sayless/plugins`;
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(`${pluginDir}/workflow.mjs`, `
export const workflows = { demo: { llm: { provider: 'm1', model: 'plugin-model' }, cross: false } };
`);
  mock.state.chatResponder = () => '插件工作流结果';
  const r = await runCli(['polish', '原文', '--workflow', 'demo'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '插件工作流结果');
  assert.equal(lastChat(mock.state).model, 'plugin-model');
});

test('--workflow quality 显式应用交叉投票预设', async (t) => {
  const { dir, mock } = await setup(t);
  mock.state.chatResponder = () => '一致结果';
  const r = await runCli(['polish', '原文', '--workflow', 'quality'], { dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '一致结果');
  assert.equal(mock.state.chatRequests.length, 3);
});

test('--workflow cloud 显式应用云端 ASR（缺 key 时给出明确错误）', async (t) => {
  const { dir, mock } = await setup(t);
  const wav = `${dir}/a.wav`;
  const { makeWav } = await import('./helpers.mjs');
  makeWav(wav);
  const r = await runCli(['transcribe', wav, '--workflow', 'cloud', '--no-insert'], { dir });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ark-ws 缺 apiKey/);
  assert.equal(mock.state.asrRequests.length, 0);
});

test('显式插件 workflow 不会先套用 activeWorkflow 的 ASR/模型', async (t) => {
  const { dir } = await setup(t);
  const pluginDir = `${dir}/.sayless/plugins`;
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(`${pluginDir}/demo.mjs`, `
export const workflows = { demo: { llm: { model: 'plugin-only-model' }, cross: false } };
`);
  patchConfig(dir, c => {
    c.activeWorkflow = 'cloud';
    c.asr.adapter = 'openai';
  });
  const r = await runCli(['doctor', '--offline', '--json', '--workflow', 'demo'], { dir });
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.asr.adapter, 'openai', 'plugin workflow 不应继承 cloud 的 ark-ws');
  assert.match(report.pipeline.llm, /plugin-only-model/);
});
