// sayless ASR 适配器：火山方舟 Agent Plan 语音识别（字节 openspeech WebSocket 协议）
// wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream（准确率优先）
// 协议：4字节头[(ver<<4)|1, (type<<4)|flags, (json<<4)|gzip, 0] + BE int32 seq + BE uint32 len + gzip 载荷
// 鉴权（握手头）：X-Api-Key + X-Api-Resource-Id: volc.seedasr.sauc.duration
// 协议细节来源：方舟官方文档《接入语音模型》(agent-plan-personal-voice-model)
import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import crypto from 'node:crypto';

const PROTO_V1 = 0b0001, MSG_FULL = 0b0001, MSG_AUDIO = 0b0010;
const FLAG_POS_SEQ = 0b0001, FLAG_NEG_WITH_SEQ = 0b0011;
const SER_JSON = 0b0001, COMP_GZIP = 0b0001;

const header = (type, flags) =>
  Buffer.from([(PROTO_V1 << 4) | 1, (type << 4) | flags, (SER_JSON << 4) | COMP_GZIP, 0]);
const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const uint32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

// 从 WAV 容器提取 data 块的 PCM（16k/16bit/mono 由调用方保证）
function wavPcm(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let pos = 36;
    while (pos < buf.length - 8) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'data') return buf.subarray(pos + 8, pos + 8 + size);
      pos += 8 + size;
    }
  }
  return buf;
}

function parseResponse(msg) {
  const headerSize = (msg[0] & 0x0f) * 4;
  const msgType = msg[1] >> 4;
  const flags = msg[1] & 0x0f;
  const serialization = msg[2] >> 4;
  const compression = msg[2] & 0x0f;
  let payload = msg.subarray(headerSize);
  let isLast = false, code = 0;
  if (flags & 0x01) payload = payload.subarray(4);
  if (flags & 0x02) isLast = true;
  if (msgType === MSG_FULL) payload = payload.subarray(4);
  else if (msgType === 0b1111) { code = payload.readInt32BE(0); payload = payload.subarray(8); }
  let json = null, rawText = '';
  if (payload.length && compression === COMP_GZIP) {
    try {
      const raw = gunzipSync(payload);
      rawText = raw.toString('utf8');
      if (serialization === SER_JSON) json = JSON.parse(rawText);
    } catch { /* 载荷非 JSON 时保留 rawText */ }
  }
  return { msgType, isLast, code, json, rawText };
}

export function arkAsr({ apiKey, wavPath, wsUrl, onLog = () => {} }) {
  return new Promise((resolve, reject) => {
    const pcm = wavPcm(fs.readFileSync(wavPath));
    const SEG = 6400; // 200ms @16k/16bit/mono
    const segments = [];
    for (let i = 0; i < pcm.length; i += SEG) segments.push(pcm.subarray(i, Math.min(i + SEG, pcm.length)));
    const reqId = crypto.randomUUID();
    const ws = new WebSocket(wsUrl, {
      headers: {
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
        'X-Api-Request-Id': reqId,
        'X-Api-Connect-Id': reqId,
        'X-Api-Sequence': '-1'
      }
    });
    ws.binaryType = 'arraybuffer';
    let seq = 1;
    const texts = [];
    const finish = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch {} fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('ASR 超时（60s 无响应）')), 60000);

    ws.addEventListener('error', (ev) => finish(reject, new Error(`WS 错误: ${ev.message || ev.error?.message || 'unknown'}`)));
    ws.addEventListener('open', () => {
      onLog(`连接成功，音频 ${segments.length} 段`);
      const payload = {
        user: { uid: 'sayless' },
        audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: true, show_utterances: true, enable_nonstream: false }
      };
      const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
      ws.send(Buffer.concat([header(MSG_FULL, FLAG_POS_SEQ), int32(seq), uint32(gz.length), gz]));
      seq++;
      // 音频帧：顺序发送，最后一帧 NEG_WITH_SEQUENCE + 负 seq
      segments.forEach((seg, i) => {
        const last = i === segments.length - 1;
        const s = last ? -seq : seq;
        const flags = last ? FLAG_NEG_WITH_SEQ : FLAG_POS_SEQ;
        const g = gzipSync(seg);
        ws.send(Buffer.concat([header(MSG_AUDIO, flags), int32(s), uint32(g.length), g]));
        seq++;
      });
      if (segments.length === 0) { // 空音频也要给终止帧
        const g = gzipSync(Buffer.alloc(0));
        ws.send(Buffer.concat([header(MSG_AUDIO, FLAG_NEG_WITH_SEQ), int32(-seq), uint32(g.length), g]));
      }
    });
    ws.addEventListener('message', (ev) => {
      const r = parseResponse(Buffer.from(ev.data));
      onLog(`← type=${r.msgType} last=${r.isLast} code=${r.code} raw=${(r.rawText || JSON.stringify(r.json) || '').slice(0, 160)}`);
      if (r.code !== 0) return finish(reject, new Error(`ASR 服务错误 code=${r.code}: ${JSON.stringify(r.json)?.slice(0, 300) || r.rawText?.slice(0, 300) || '(无载荷)'}`));
      const t = r.json?.result?.text
        ?? (r.json?.result?.utterances || []).map(u => u.text || '').join('')
        ?? '';
      if (t) texts.push(t);
      if (r.isLast) {
        onLog(`收包完成，片段 ${texts.length}`);
        return finish(resolve, texts.join('').trim());
      }
    });
    ws.addEventListener('close', () => { clearTimeout(timer); resolve(texts.join('').trim()); });
  });
}
