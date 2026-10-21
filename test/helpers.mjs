// 测试工具：临时 SAYLESS_DIR、mock 供应商/ASR 服务、可执行假 ffmpeg、WAV 夹具。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'sayless.mjs');

export function tempDir(prefix = 'sayless-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeEnv(dir, extra = {}) {
  const env = { ...process.env, HOME: dir, SAYLESS_DIR: path.join(dir, '.sayless'), TZ: 'UTC', ...extra };
  delete env.SAYLESS_API_KEY;
  delete env.SAYLESS_FFMPEG;
  delete env.SAYLESS_AUDIO_DEVICE;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

export function runCli(args, { dir, env = {}, input = null, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: makeEnv(dir, env),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`CLI 超时（${args.join(' ')}）\nstdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', (e) => { clearTimeout(timer); if (!finished) { finished = true; reject(e); } });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      resolve({ code, signal, stdout, stderr });
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

export async function initCli(dir, extraArgs = []) {
  const r = await runCli(['init', ...extraArgs], { dir });
  if (r.code !== 0) throw new Error(`init failed: ${r.stderr}`);
  return r;
}

export const configPath = (dir) => path.join(dir, '.sayless', 'config.json');
export const dictPath = (dir) => path.join(dir, '.sayless', 'dictionary.json');
export const historyPath = (dir) => path.join(dir, '.sayless', 'history.jsonl');
export const recordingsDir = (dir) => path.join(dir, '.sayless', 'recordings');

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
export function patchConfig(dir, fn) {
  const p = configPath(dir);
  const cfg = readJson(p);
  fn(cfg);
  writeJson(p, cfg);
  return cfg;
}
export function patchDict(dir, fn) {
  const p = dictPath(dir);
  const d = readJson(p);
  fn(d);
  writeJson(p, d);
  return d;
}
export function readHistory(dir) {
  const p = historyPath(dir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
export function seedHistory(dir, entries) {
  fs.mkdirSync(path.dirname(historyPath(dir)), { recursive: true });
  fs.writeFileSync(historyPath(dir), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

export function makeWav(file, { seconds = 1, sampleRate = 16000 } = {}) {
  const frames = Math.max(1, Math.floor(seconds * sampleRate));
  const dataSize = frames * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(dataSize, 40);
  // 400Hz 正弦，便于肉眼确认文件可播放
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 400 * i) / sampleRate) * 8000);
    b.writeInt16LE(v, 44 + i * 2);
  }
  fs.writeFileSync(file, b);
  return file;
}

export function makeFakeFfmpeg(file, fixture) {
  fs.writeFileSync(file, `#!/bin/sh\n# fake ffmpeg for tests: last arg is output path\nfor last; do :; done\nsleep 0.15\ncp '${fixture}' "$last"\nexit 0\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

export async function startMockServer() {
  const state = {
    chatRequests: [],
    chatHeaders: [],
    asrRequests: [],
    modelRequests: [],
    chatFailures: 0,
    chatStatus: 0,
    asrStatus: 200,
    asrText: '我们明天十点开会',
    chatResponder: null
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const send = (status, obj) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      if (req.url.endsWith('/audio/transcriptions')) {
        state.asrRequests.push({ url: req.url, headers: req.headers, bytes: body.length });
        return send(state.asrStatus, state.asrStatus === 200 ? { text: state.asrText } : { error: 'mock asr error' });
      }
      if (req.url.endsWith('/chat/completions')) {
        let j = {};
        try { j = JSON.parse(body); } catch { /* ignore */ }
        state.chatRequests.push(j);
        state.chatHeaders.push(req.headers);
        if (state.chatStatus) {
          return send(state.chatStatus, { error: { message: `mock status ${state.chatStatus}` } });
        }
        if (state.chatFailures > 0) {
          state.chatFailures--;
          return send(500, { error: { message: 'mock transient failure' } });
        }
        const text = state.chatResponder
          ? state.chatResponder(j)
          : `润色:${j.messages?.at(-1)?.content ?? ''}`;
        return send(200, { choices: [{ message: { content: text } }] });
      }
      if (req.url.endsWith('/models')) {
        state.modelRequests.push({ headers: req.headers });
        return send(200, { data: [] });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

// 让 CLI 指向 mock：ASR 走 openai 兼容端点，LLM 走 ark-plan provider。
export function pointAtMock(dir, mock, { asrAdapter = 'openai', provider = 'ark-plan' } = {}) {
  return patchConfig(dir, cfg => {
    cfg.asr.adapter = asrAdapter;
    cfg.asr.baseUrl = `${mock.base}/v1`;
    cfg.asr.apiKey = 'test-key';
    cfg.asr.model = 'mock-asr';
    cfg.providers[provider] = { ...(cfg.providers[provider] || {}), baseUrl: `${mock.base}/v1`, apiKey: 'test-key' };
    cfg.llm = { ...(cfg.llm || {}), provider, model: 'mock-llm', temperature: 0, retries: 0, timeoutMs: 5000 };
    cfg.translate = { ...(cfg.translate || {}), provider, model: 'mock-llm' };
    cfg.ask = { ...(cfg.ask || {}), provider, model: 'mock-llm', engines: [], maxResults: 3 };
    cfg.cross = { ...(cfg.cross || {}), models: [], timeoutMs: 5000 };
  });
}

export function lastChat(state) {
  return state.chatRequests.at(-1);
}
export function systemOf(req) {
  return req?.messages?.find?.(m => m.role === 'system')?.content || '';
}
export function userOf(req) {
  const msgs = req?.messages?.filter?.(m => m.role === 'user') || [];
  return msgs.at(-1)?.content || '';
}
