#!/usr/bin/env python3
"""用演示数据渲染 hub 设置页截图（不触碰真实听写数据）。

用法：
  python3 tools/gen-hub-demo.py [hub.html 路径] [输出目录]
默认：app/hub.html → /tmp/hub-demo
依赖：playwright（pip install playwright && playwright install chromium）
流程：本脚本生成含演示数据的 HTML → playwright 全页截图 → sips 竖切上下两半
产出：docs/screenshots/hub-settings-top.png / hub-settings-bottom.png
"""
import datetime, json, os, random, re, sys

TPL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'app', 'hub.html')
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/hub-demo'

TPL = open(TPL).read()
random.seed(42)

# ---- 演示热力图（20 周列、周日对齐，与 Swift buildHeat 同构）----
today = datetime.date.today()
start = today - datetime.timedelta(days=139)
grid_start = start - datetime.timedelta(days=(start.weekday() + 1) % 7)
cells_html = ""
d = grid_start
while d <= today:
    col = ""
    for _ in range(7):
        if d > today:
            col += "<i style='opacity:0'></i>"
        else:
            cls = "on" if random.random() < 0.55 else ""
            col += f"<i class='{cls}' title='{d.isoformat()}'></i>"
        d += datetime.timedelta(days=1)
    cells_html += f"<div class='wk'>{col}</div>"

hist = [
    ("2026-10-19T09:12:04", "dictate", "把明天的站会改到十点，记得同步进度。"),
    ("2026-10-19T08:40:51", "translate:en", "Please send the revised proposal to the client by Friday."),
    ("2026-10-18T21:03:22", "ask", "对比一下 S3 和 OSS 的冷存储单价，按 10TB 算。"),
    ("2026-10-18T16:27:40", "dictate", "这个 bug 的根因是连接池没有释放，我先写个回归测试。"),
    ("2026-10-18T10:15:09", "dictate", "中午和小王约了产品评审，带上最新的原型图。"),
]
histrows = "".join(
    f"<div class='row'><span class='ts'>{ts}</span><span class='md'>{md}</span><span class='ot'>{out}</span></div>"
    for ts, md, out in hist)

dictrows = "".join(
    f"<tr><td>{f}</td><td>→</td><td><b>{t}</b></td><td><a style=\"color:#f87171;cursor:pointer\">✕</a></td></tr>"
    for f, t in [("摆链", "Bailian"), ("方舟", "Ark"), ("C Code", "ZCode"), ("机光", "极光")])
hot = ["ZCode", "Bailian", "Ark", "MiniMax", "whisper", "Tingting"]
hotchips = "".join(
    f"<span class=\"chip\">{w} · {random.randint(3, 40)}次 <a style=\"color:#f87171;cursor:pointer\">✕</a></span>"
    for w in hot)
wordstats = "".join(f"<span class=\"chip\">{w} · {c}次</span>" for w, c in
                    [("Bailian", 38), ("ZCode", 31), ("方舟", 22), ("MiniMax", 17), ("whisper", 12)])
appplayers = "".join(
    f"<div class=\"card\" style=\"margin-bottom:12px\"><div style=\"font-weight:700\">{name}</div>"
    f"<div style=\"font-size:12px;color:#999;margin:6px 0\">热词 {n} 个 · 替换 {m} 条</div></div>"
    for name, n, m in [("微信", 2, 1), ("Mail", 4, 2), ("VS Code", 6, 3)])
rules = "".join(f"<li>{r}</li>" for r in
                ["删除语气词（嗯、呃、就是说）", "技术名词保留英文原文", "标点规范：中文全角", "统一简体", "纠正同音错别字"])

cfg = {
    "providers": {p: {"baseUrl": "https://example/v1"} for p in
                  ["ark-plan", "deepseek", "zai", "minimax", "kimi", "mimo-plan", "stepfun-plan"]},
    "asr": {"adapter": "whisper", "language": "zh"},
    "llm": {"provider": "ark-plan", "model": "doubao-seed-2-1-turbo-260628"},
    "translate": {"to": "en"},
    "cross": {"models": [{"provider": p, "model": m} for p, m in
                          [("zai", "glm-5-turbo"), ("deepseek", "deepseek-flash"),
                           ("minimax", "MiniMax-M3"), ("ark-plan", "doubao-turbo"),
                           ("mimo-plan", "mimo-v2.6-flash")]],
              "arbiter": {"provider": "deepseek", "model": "deepseek-v4-flash"}},
    "insert": {"mode": "paste"}, "sound": True, "ptt": False,
    "hotkeys": {"dictate": {"key": 49, "modifier": "option", "label": "Space"},
                "translate": {"key": 17, "modifier": "option", "label": "T"},
                "ask": {"key": 12, "modifier": "option", "label": "Q"}},
    "workflows": {"fast": {}, "quality": {}, "cloud": {}},
    "activeWorkflow": "fast",
}
providers = sorted(cfg["providers"].keys())
cfg_json = json.dumps(cfg, ensure_ascii=False).replace("</", "<\\/")

def render(tab, stats):
    h = TPL
    for i in range(4):
        h = h.replace(f"__T{i}__", "on" if i == tab else "").replace(f"__VT{i}__", "on" if i == tab else "")
    repl = {
        "__STAT1__": str(stats[0]), "__STAT2__": str(stats[1]), "__STAT3__": str(stats[2]),
        "__STAT4__": str(stats[3]), "__STAT5__": str(stats[4]),
        "__HISTROWS__": histrows, "__DICTROWS_EDIT__": dictrows, "__DICTROWS__": dictrows,
        "__HOTCHIPS_EDIT__": hotchips, "__HOTCHIPS__": hotchips,
        "__APPLAYERS__": appplayers, "__WORDSTATS__": wordstats, "__RULES__": rules,
        "__HEAT__": cells_html, "__CFGJSON__": cfg_json,
        "__PROVIDERS__": ",".join(f'"{p}"' for p in providers),
    }
    for k, v in repl.items():
        h = h.replace(k, v)
    leftovers = re.findall(r"__[A-Z0-9]+__", h)
    assert not leftovers, f"placeholders left: {leftovers}"
    return h

os.makedirs(OUT, exist_ok=True)
for name, tab in [("home", 0), ("dict", 2), ("settings", 3)]:
    html = render(tab, (12480, 326, 47, 6, 12))
    path = os.path.join(OUT, f"{name}.html")
    open(path, "w").write(html)
    print(path, len(html))
