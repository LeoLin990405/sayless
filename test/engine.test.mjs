// v7 长驻引擎 / Action Pipeline 测试：不经过 App，直接用 JSON 行驱动
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  CLI, tempDir, makeEnv, initCli, patchConfig, makeWav, startMockServer, pointAtMock
} from './helpers.mjs';

function seedWav(dir) {
  const file = path.join(dir, 'utterance.wav');
  makeWav(file, { seconds: 1 });
  return file;
}

function engineRequest(dir, request, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'engine', '--stdio'], {
      cwd: path.dirname(CLI),
      env: makeEnv(dir),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = '', stderr = '', settled = false;
    const events = [];
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      if (err) reject(Object.assign(err, { stderr, events }));
      else resolve({ ...value, events, stderr });
    };
    const timer = setTimeout(() => finish(new Error(`engine 超时\nstdout=${buffer}\nstderr=${stderr}`)), timeoutMs);
    child.stdout.on('data', (d) => {
      buffer += d;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { finish(new Error(`engine 输出不是 JSON：${line}`)); return; }
        events.push(evt);
        if (evt.event === 'done' || evt.event === 'error') finish(null, evt);
      }
    });
    child.stderr.on('data', (d) => stderr += d);
    child.on('error', (e) => finish(e));
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

test('engine 用内置 action 跑完 asr→dict→llm→dict', async (t) => {
  const dir = tempDir('sayless-engine-');
  const mock = await startMockServer();
  t.after(async () => { await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await initCli(dir);
  pointAtMock(dir, mock);
  const wav = seedWav(dir);
  const { event, ok, result, events } = await engineRequest(dir, {
    id: 'j1', action: 'dictate', wav, app: 'TestApp'
  }, 30000);
  assert.equal(event, 'done');
  assert.equal(ok, true);
  assert.equal(result.action, 'dictate');
  assert.equal(result.mode, 'dictate');
  assert.match(result.out, /润色:/);
  assert.match(result.raw, /我们明天十点开会/);
  assert.equal(result.inserted, false);
  assert.equal(result.entry.inserted, false);
  const stages = events.filter(e => e.event === 'stage').map(e => e.stage);
  assert.deepEqual(stages, ['asr', 'dict', 'llm', 'dict']);
  assert.ok(fs.existsSync(result.entry.rec ? path.join(dir, '.sayless', 'recordings', result.entry.rec) : ''));
});

test('engine 支持用户自定义 action，且可对纯文本执行 pipeline', async (t) => {
  const dir = tempDir('sayless-engine-');
  const mock = await startMockServer();
  t.after(async () => { await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await initCli(dir);
  pointAtMock(dir, mock);
  patchConfig(dir, cfg => {
    cfg.actions.rewrite = { label: '改写', pipeline: ['llm', 'dict'], output: 'none' };
    cfg.actions.rawCopy = { label: '原样', pipeline: ['dict'], output: 'none' };
  });
  const { event, ok, result, events } = await engineRequest(dir, {
    id: 'j2', action: 'rewrite', text: '把  这段 话改顺'
  });
  assert.equal(event, 'done');
  assert.equal(ok, true);
  assert.equal(result.mode, 'dictate');
  assert.match(result.out, /润色:/);
  assert.deepEqual(events.filter(e => e.event === 'stage').map(e => e.stage), ['llm', 'dict']);
  assert.deepEqual(events.filter(e => e.event === 'accepted').map(e => e.action), ['rewrite']);
});

test('engine 未知 action 返回结构化 error，不崩进程', async (t) => {
  const dir = tempDir('sayless-engine-');
  const mock = await startMockServer();
  t.after(async () => { await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await initCli(dir);
  pointAtMock(dir, mock);
  const { event, ok, error } = await engineRequest(dir, { id: 'j3', action: 'nope' });
  assert.equal(event, 'error');
  assert.equal(ok, false);
  assert.match(error, /未知 action/);
});
