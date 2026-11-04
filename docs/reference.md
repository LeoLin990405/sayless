# Sayless reference

Full CLI, configuration, provider, and troubleshooting reference. The README keeps the
short version; this file is the complete one.

Related documents: [ARCHITECTURE.md](../ARCHITECTURE.md) (engine topology, action/stage semantics,
JSONL protocol), [PLUGINS.md](../PLUGINS.md) (plugin recipes and module contract),
[CHANGELOG.md](../CHANGELOG.md) (release history).

## CLI reference

| Command | What it does |
|---|---|
| `sayless run` | Record → transcribe → polish → paste. Transcription starts only after recording really ended; `--sec N` fixed length, `--raw` skips the LLM, `--no-insert` prints only, `--translate en` translate mode, `--ask` ask mode, `--workflow quality` temporary workflow |
| `sayless rec --sec 5 -o a.wav` | Record only (16 kHz mono WAV, `0600`); `SAYLESS_FFMPEG` / `rec.device` select the recorder |
| `sayless asr <file.wav>` | Transcribe only through the current ASR adapter; `--app` selects an app dictionary layer |
| `sayless polish "<text>"` | Polish only; `--dry-run` applies the dictionary only, `--cross` forces voting, `-` reads from stdin |
| `sayless translate "<text>" --to ja` | Translate into one of 10 languages; `--say` records first |
| `sayless ask "<question>"` | Search Bing CN + DuckDuckGo then answer with `[n]` citations; `--say` records first, `--no-search` skips the web |
| `sayless engine --stdio` | Long-lived engine with a JSON Lines protocol; the menu-bar app uses this channel |
| `sayless actions` | List the configured actions with their stage pipeline and output adapter |
| `sayless action <id> [wav]` | Run one action; `--say` records first, `--app` selects an app dictionary layer |
| `sayless transcribe <wav>` | Legacy client path: transcribe → polish → paste; `--force` bypasses the short-audio guard |
| `sayless insert "<text>"` | Paste arbitrary text into the focused app (clipboard restored after 1.6 s by default) |
| `sayless dict add\|del\|add-hot\|del-hot\|import\|stats\|export\|validate` | Dictionary management; `import` accepts `a=>b` lines, plain hotwords, or JSON from `dict export` |
| `sayless learn "<original>" "<edited>"` | LCS diff → replacement rules; `--last` compares with the last entry, `--mine [--apply]` mines corrections, `--dry-run` writes nothing |
| `sayless history [-n 20] [--json] [--search q] [--delete n\|ts] [--clear --force] [--export file]` | View, search, delete, clear, or export history |
| `sayless stats [--json]` | Dictated characters/entries/active days/streaks, mode and app distribution, recording archive size |
| `sayless plugin` | List loaded plugins and their hooks |
| `sayless doctor [--offline] [--json]` | Health check: ASR, Node, ffmpeg, permissions, provider round-trips, recording devices |
| `sayless devices` | List `avfoundation` input devices (audio segment only) |

Global flags: `--provider <id>`, `--model <id>` (one-shot provider/model override), `--cross`
(force cross-vote), `--workflow <id>` (explicitly apply a full preset), `--json`, `--force`,
`--no-insert`, `--app <name>`. Text starting with `-` needs a `--` separator, e.g.
`sayless polish -- "-dash-text"`.

Environment variables: `SAYLESS_DIR` (data directory), `SAYLESS_API_KEY` (fallback key when a
provider has no key configured), `SAYLESS_FFMPEG`, `SAYLESS_AUDIO_DEVICE`, `SAYLESS_CLI` (app-side
CLI path override), `SAYLESS_SHOW_HUB`, `SAYLESS_DUMP_HUB`, `SAYLESS_DUMP_PANEL`.

## Actions and stages

An action is an ordered list of stages plus an output adapter:

- stages: `asr`, `dict`, `llm`, `translate`, `ask`;
- outputs: `paste`, `clipboard`, `stdout`, `file`, `none`;
- built-ins: `dictate`, `translate`, `ask`; users may add any action in `config.json`.

```jsonc
"actions": {
  "dictate":   { "pipeline": ["asr","dict","llm","dict"], "output": "paste" },
  "translate": { "pipeline": ["asr","dict","translate","dict"], "output": "paste" },
  "ask":       { "pipeline": ["asr","dict","ask","dict"], "output": "paste" }
}
```

The engine speaks JSON Lines on stdin/stdout: the app sends a WAV path plus an action id and
receives `accepted / stage / done / error` events. Engine stdout carries protocol JSON only; plugin
and library `console.log` output is redirected to stderr. Protocol details: [ARCHITECTURE.md](../ARCHITECTURE.md).

## Providers

`config.json → providers` registers any OpenAI-compatible endpoint (`baseUrl`, `apiKey`, `model`,
optional `chatPath`). Built-in presets:

| Provider | Endpoint | Notes |
|---|---|---|
| `ark-plan` | `ark.cn-beijing.volces.com/api/plan/v3` | Volcengine Ark Agent Plan (Doubao models) |
| `deepseek` | `api.deepseek.com/v1` | |
| `zai` | `open.bigmodel.cn/api/coding/paas/v4` | Z.ai GLM Coding Plan |
| `minimax` | `api.minimaxi.com/v1` | non-standard path `chatPath=/text/chatcompletion_v2` |
| `kimi` | `api.kimi.com/coding/v1` | Kimi for Coding (`sk-kimi-` keys) |
| `qwen-plan` | `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | Alibaba Token Plan (`sk-sp-` keys) |
| `bailian-ws` | workspace gateway | Bailian workspace; models must be enabled in the console |
| `stepfun` / `stepfun-plan` | `api.stepfun.com/v1` / `/step_plan/v1` | plan quota uses `/step_plan`; requires real-name verification |
| `mimo` / `mimo-plan` | `api.xiaomimimo.com/v1` / `token-plan-sgp.xiaomimimo.com/v1` | MiMo Token Plan `tp-` keys use the regional domain |
| `dashscope` / `siliconflow` / `moonshot` / `zhipu` | — | presets ready; add a key |

Rule of thumb: a vendor's subscription plan and pay-as-you-go quota are usually two different
endpoints and two different balances — on 402/403 check the channel first (`sayless doctor` groups
the results).

## Cross-vote and workflows

`--cross` runs every `cross.models` entry in parallel with a 30 s per-model timeout, normalises the
drafts, clusters them by character bigram Dice similarity (threshold `cross.similarity`, default
`0.82`), and takes the largest cluster if it holds at least two drafts. Full disagreement goes to
`cross.arbiter`.

Workflows are presets that combine ASR/model/vote policy; `activeWorkflow` is the default:

- `fast` — single model (recommended for daily dictation, 2–3 s);
- `quality` — cross-vote (~15 s);
- `cloud` — cloud ASR + voting.

A persistent `activeWorkflow` only decides policy such as whether to vote; it does not override the
ASR engine and model chosen in settings. Only an explicit `--workflow <id>` applies a whole preset
temporarily (including cloud ASR for `cloud`).

## ASR adapters

| Adapter | Description |
|---|---|
| `whisper` (default) | Local whisper.cpp + ggml model, offline, zero cost; hallucinated bracketed output is filtered |
| `mimo-asr` | MiMo-V2.5-ASR cloud: bilingual + dialects + punctuation; billed per second by Token Plan; uses `providers.mimo-plan` |
| `ark-ws` | Volcengine Ark streaming speech recognition (Agent Plan pay-as-you-go) |
| `openai` | Any OpenAI-compatible `/audio/transcriptions` endpoint |

## Dictionary and learning loop

```jsonc
{
  "replacements": [{ "from": "摆链", "to": "Bailian" }],
  "hotwords": ["ZCode", "Bailian"],
  "styleRules": ["删除语气词", "技术名词保留英文"],
  "apps": { "微信": { "hotwords": ["方舟"] } }
}
```

`sayless learn` diffs original and corrected text with LCS (Chinese segmented by
`Intl.Segmenter`), writes rules to `feedback.jsonl`, `--mine` finds frequent patterns,
`--mine --apply --min-count 2` writes them back, and the hub manages them visually.

## Configuration reference (`~/.sayless/config.json`, `0600`)

```jsonc
{
  "providers": { "<id>": { "baseUrl": "...", "apiKey": "...", "model": "...", "chatPath": "..." } },
  "asr":     { "adapter": "whisper", "whisperBin": "/opt/homebrew/bin/whisper-cli",
               "whisperModel": "~/.sayless/ggml-base.bin", "language": "zh",
               "filterHallucinations": true },
  "llm":       { "provider": "ark-plan", "model": "...", "temperature": 0, "retries": 2, "timeoutMs": 45000 },
  "translate": { "to": "en", "provider": "ark-plan", "model": "..." },
  "ask":       { "provider": "ark-plan", "model": "...", "engines": ["bing", "ddg"],
                 "maxResults": 5, "proxy": "http://127.0.0.1:7897" },
  "cross":     { "models": [{ "provider": "...", "model": "..." }],
                 "arbiter": { "provider": "deepseek", "model": "..." },
                 "similarity": 0.82, "timeoutMs": 30000 },
  "rec":       { "ffmpeg": "", "device": ":0" },
  "recordings":{ "keep": 200 },
  "insert":    { "mode": "paste", "restoreClipboard": true },
  "sound": true, "ptt": false,
  "hotkeys":   { "dictate": { "key": 49, "modifier": "option", "label": "Space" },
                 "translate": { "key": 17, "modifier": "option", "label": "T" },
                 "ask": { "key": 12, "modifier": "option", "label": "Q" } },
  "workflows": { "fast": {}, "quality": { "cross": true }, "cloud": { "cross": true } },
  "activeWorkflow": "fast",
  "actions": {
    "dictate":   { "pipeline": ["asr","dict","llm","dict"], "output": "paste" },
    "translate": { "pipeline": ["asr","dict","translate","dict"], "output": "paste" },
    "ask":       { "pipeline": ["asr","dict","ask","dict"], "output": "paste" }
  }
}
```

Data directory layout: `config.json` (0600, contains keys, not committed), `dictionary.json`
(0600), `history.jsonl` (0600), `feedback.jsonl` (0600), `recordings/` (audio archive, last 200),
`last-utterance.wav` (0600, git-ignored), `plugins/`, `ggml-base.bin`. `SAYLESS_DIR` overrides the
directory. `history.jsonl` caps `out` at 1,000 chars and `raw` at 500 to control file size; entries
keep full `chars` / `rawChars` counts, so `stats` and the hub are unaffected.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Paste error 1002 / paste does nothing | Accessibility permission was lost (ad-hoc re-signing always loses it) → toggle it again; a persistent certificate fixes it permanently |
| `no speech, peak=0.0` | Mic captured nothing: check SaylessBar holds Microphone permission, run exactly one instance, check input level |
| Key auth 402/403 | Wrong channel: StepFun needs `/step_plan/v1` and real-name verification; `sk-sp-` / `sk-kimi-` / `tp-` keys only work on their own domains; `sayless doctor` groups the checks |
| Hotkeys do nothing | Accessibility not granted (tap disabled, Carbon fallback) → menu "request Accessibility" or re-enable in System Settings |
| Hub does not open / renders wrong | Check `~/.sayless/saylessbar.log`; template is `app/hub.html`, rebuild with `build.sh`; export HTML with `SAYLESS_DUMP_HUB` |
| ASR/model changes in settings have no effect | Top-level `asr` / `llm` / `translate` / `ask` take priority; persistent `activeWorkflow` only affects voting policy. `--workflow` applies a full preset temporarily |
| App reports "sayless CLI not found" | Rebuild `app/build.sh` (embeds the CLI), or symlink `sayless.mjs`, or set `SAYLESS_CLI` |
| Hub input or search does not work | Fixed in v4.5 (focusable window + history search class); make sure you run a fresh build |
| `sayless run` transcribes before you finish | Fixed in v4.5: `rec` is a Promise and waits for ffmpeg to exit |
