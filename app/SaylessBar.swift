// SaylessBar v3 — Typeless 式 UI：菜单栏 + 录音胶囊浮窗（电平动画/计时/模式）+ 结果预览卡 + 历史窗口。
// 设计：暗色 HUD 胶囊 360×64 底部居中；录音=红点呼吸+7 根电平条+计时；处理=旋转指示；完成=✓+文本预览 3.5s 自动消失。
import AppKit
import Carbon.HIToolbox
import AVFoundation
import WebKit

private let hubTemplate = """
<!doctype html><html><head><meta charset="utf-8"><style>
:root{--bg:#0d0d0d;--card:#1c1c1e;--txt:#f2f2f2;--sub:#9a9a9a;--accent:#3b82f6}
*{margin:0;box-sizing:border-box;font-family:-apple-system,"PingFang SC",sans-serif}
body{display:flex;height:100vh;background:var(--bg);color:var(--txt);overflow:hidden}
.side{width:240px;background:#131313;padding:22px 14px;display:flex;flex-direction:column;flex-shrink:0}
.logo{font-size:20px;font-weight:800;display:flex;gap:8px;align-items:center;padding:6px 12px 26px}
.badge{background:#2563eb;color:#fff;font-size:11px;padding:2px 8px;border-radius:6px;font-weight:700}
.nav{display:flex;flex-direction:column;gap:4px}
.nav a{display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:10px;color:var(--sub);text-decoration:none;font-size:14px;cursor:pointer}
.nav a.on{background:#262626;color:var(--txt)}
.nav a:hover{color:var(--txt)}
.spacer{flex:1}
.foot{display:flex;gap:14px;padding:10px 12px;color:var(--sub);font-size:16px}
.main{flex:1;overflow:auto;padding:34px 40px;background-image:radial-gradient(#1c1c1c 1px,transparent 1px);background-size:22px 22px}
h1{font-size:40px;font-weight:800;letter-spacing:1px;margin-bottom:6px}
h2.sec{font-size:19px;color:var(--sub);font-weight:700;margin:28px 0 14px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:560px}
.card{background:var(--card);border-radius:16px;padding:20px;min-height:92px}
.card .v{font-size:22px;font-weight:700}
.card .k{font-size:14px;color:var(--sub);margin-top:10px}
.heatcard{background:var(--card);border-radius:16px;padding:22px;max-width:560px;margin-top:16px}
.hstats{display:grid;grid-template-columns:1fr 1fr 1fr;text-align:center;margin-bottom:16px}
.hstats .v{font-size:18px;font-weight:700}
.hstats .k{font-size:13px;color:var(--sub);margin-top:6px}
.wk{display:flex;gap:3px;margin-bottom:3px}
.wk i{width:11px;height:11px;border-radius:3px;background:#232323;display:block}
.wk i.on{background:#3b82f6}
.wkwrap{display:flex;gap:3px}
.legend{display:flex;align-items:center;gap:4px;margin-top:12px;font-size:12px;color:var(--sub)}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.row{display:flex;gap:14px;padding:10px 0;border-bottom:1px solid #1f1f1f;font-size:13px;align-items:baseline}
.row .ts{color:var(--sub);font-family:Menlo,monospace;font-size:11px;min-width:130px}
.row .md{color:var(--accent);min-width:80px;font-weight:600}
.right{width:250px;flex-shrink:0;padding:34px 20px;display:flex;flex-direction:column;gap:14px;overflow:auto}
.keys{background:var(--card);border-radius:16px;padding:16px}
.keys .k{font-size:13px;color:var(--sub);margin:10px 0 4px}
.keys .k:first-child{margin-top:0}
kbd{display:inline-block;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:6px;padding:3px 9px;font-size:12px;margin:2px;color:var(--txt)}
.grad{border-radius:16px;padding:18px;color:#fff}
.grad.b{background:linear-gradient(135deg,#1d4ed8,#3b82f6)}
.grad.p{background:linear-gradient(135deg,#4c1d95,#7c3aed)}
.grad .t{font-size:15px;font-weight:700;margin-bottom:6px}
.grad .d{font-size:12px;opacity:.85}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:8px 6px;border-bottom:1px solid #1f1f1f;color:var(--txt)}
ul{padding-left:18px;font-size:13px;color:#cfcfcf;line-height:1.9}
.chip{display:inline-block;background:#242424;border:1px solid #333;border-radius:7px;padding:4px 10px;margin:3px;font-size:12px}
.tab{display:none}.tab.on{display:block}
</style></head><body>
<div class="side">
  <div class="logo">Sayless <span class="badge">本地</span></div>
  <div class="nav">
    <a class="__T0__" onclick="go(0,this)">⌂&nbsp; 首页</a>
    <a class="__T1__" onclick="go(1,this)">◷&nbsp; 历史记录</a>
    <a class="__T2__" onclick="go(2,this)">▤&nbsp; 词典</a>
  </div>
  <div class="spacer"></div>
  <div class="foot">◐&nbsp; ◯&nbsp; ⚙&nbsp; ?</div>
</div>
<div class="main">
  <div class="tab __VT0__" id="t0">
    <h1>说话，不要打字</h1>
    <h2 class="sec">洞察</h2>
    <div class="cards">
      <div class="card"><div class="v">__STAT1__</div><div class="k">口述字数</div></div>
      <div class="card"><div class="v">__STAT2__</div><div class="k">听写条数</div></div>
      <div class="card"><div class="v">__STAT3__</div><div class="k">活跃天数</div></div>
      <div class="card"><div class="v">__STAT4__</div><div class="k">当前连续天数</div></div>
    </div>
    <div class="heatcard">
      <div class="hstats">
        <div><div class="v">__STAT3__</div><div class="k">活跃天数</div></div>
        <div><div class="v">__STAT4__</div><div class="k">当前连续天数</div></div>
        <div><div class="v">__STAT4__</div><div class="k">最长连续天数</div></div>
      </div>
      <div class="wkwrap">__HEAT__</div>
      <div class="legend">更少 <i style="background:#232323"></i><i style="background:#1e3a8a"></i><i style="background:#2563eb"></i><i style="background:#60a5fa"></i> 更多</div>
    </div>
  </div>
  <div class="tab __VT1__" id="t1">
    <h1 style="font-size:28px">历史记录</h1>
    <h2 class="sec">最近 60 条</h2>
    __HISTROWS__
  </div>
  <div class="tab __VT2__" id="t2">
    <h1 style="font-size:28px">词典</h1>
    <h2 class="sec">确定性替换（编辑 ~/.sayless/dictionary.json 生效）</h2>
    <table><tr><td><b>来源</b></td><td></td><td><b>目标</b></td></tr>__DICTROWS__</table>
    <h2 class="sec">专有名词热词</h2>
    <div>__HOTCHIPS__</div>
    <h2 class="sec">风格规则</h2>
    <ul>__RULES__</ul>
  </div>
</div>
<div class="right">
  <div class="keys">
    <div class="k">听写</div><kbd>⌥</kbd><kbd>Space</kbd>
    <div class="k">翻译</div><kbd>⌥</kbd><kbd>T</kbd>
    <div class="k">问任何问题</div><kbd>⌥</kbd><kbd>Q</kbd>
  </div>
  <div class="keys">
    <div class="k">交叉加强</div><kbd>--cross</kbd>
    <div style="font-size:12px;color:var(--sub);margin-top:6px">glm-5-turbo + deepseek-flash + MiniMax-M3 三家共识</div>
  </div>
  <div class="grad b"><div class="t">本地优先</div><div class="d">ASR 走本地 whisper.cpp，语音不出机器。</div></div>
  <div class="grad p"><div class="t">自己的套餐</div><div class="d">润色与翻译走你的方舟 / 智谱 / DeepSeek / MiniMax 套餐。</div></div>
</div>
<script>
function go(i, el){
  document.querySelectorAll('.tab').forEach((t,idx)=>t.classList.toggle('on', idx===i));
  document.querySelectorAll('.nav a').forEach(a=>a.classList.remove('on'));
  (el||document.querySelectorAll('.nav a')[i]).classList.add('on');
}
</script>
</body></html>
"""

let logPath = NSHomeDirectory() + "/.sayless/saylessbar.log"
let histPath = NSHomeDirectory() + "/.sayless/history.jsonl"
func logLine(_ s: String) {
    let line = "\(Date().description) \(s)\n"
    if !FileManager.default.fileExists(atPath: logPath) { FileManager.default.createFile(atPath: logPath, contents: nil) }
    if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
}

final class HotkeyBox {
    init(id: Int, action: @escaping (Int) -> Void) { self.action = action }
    let action: (Int) -> Void
    func dispatch(_ id: Int) { action(id) }
}

func fourCC(_ s: String) -> FourCharCode {
    var v: FourCharCode = 0
    for b in s.utf8.prefix(4) { v = (v << 8) &+ FourCharCode(b) }
    return v
}

// ---------- 麦克风电平表（仅测 RMS，录音文件仍由 ffmpeg 写） ----------
final class AudioMeter {
    private let engine = AVAudioEngine()
    private var onLevel: ((Float) -> Void)?
    func start(onLevel: @escaping (Float) -> Void) {
        self.onLevel = onLevel
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self, let ch = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            var sum: Float = 0
            for i in stride(from: 0, to: n, by: 4) { let v = ch[i]; sum += v * v }
            let rms = sqrt(sum / Float(n / 4))
            let db = 20 * log10(max(rms, 1e-6))
            let level = min(1, max(0, (db + 50) / 45)) // -50dB..+5dB 归一
            DispatchQueue.main.async { self.onLevel?(level) }
        }
        do { try engine.start() } catch { logLine("meter start fail: \(error.localizedDescription)") }
    }
    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

// ---------- 录音胶囊浮窗 ----------
final class CapsulePanel {
    private var panel: NSPanel?
    private var dot: NSView!
    private var bars: [NSView] = []
    private var modeLabel: NSTextField!
    private var timeLabel: NSTextField!
    private var statusLabel: NSTextField! // 处理中/结果预览
    private var previewLabel: NSTextField!
    private var spinner: NSProgressIndicator!
    private var stack: NSStackView!
    private var levels: [Float] = Array(repeating: 0, count: 7)
    private var smooth: Float = 0
    private var tick: Timer?
    private var startDate = Date()
    private var hideWork: DispatchWorkItem?


    func show(mode: Int) {
        let names = ["听写 ⌥Space", "翻译 ⌥T", "问答 ⌥Q"]
        ensurePanel()
        modeLabel.stringValue = names[mode]
        timeLabel.stringValue = "0.0s"
        statusLabel.stringValue = ""
        statusLabel.textColor = NSColor.secondaryLabelColor
        previewLabel.stringValue = ""
        previewLabel.isHidden = true
        for b in bars { b.isHidden = false }
        spinner.stopAnimation(nil); spinner.isHidden = true
        dot.isHidden = false
        startDate = Date()
        tick?.invalidate()
        tick = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in self?.heartbeats() }
        panel?.orderFrontRegardless()
    }
    func setLevel(_ l: Float) {
        smooth = smooth * 0.65 + l * 0.35
    }
    func setProcessing() {
        tick?.invalidate()
        dot.isHidden = true
        spinner.isHidden = false; spinner.startAnimation(nil)
        statusLabel.stringValue = "识别润色中…"
        for b in bars { b.layer?.backgroundColor = NSColor.systemGray.withAlphaComponent(0.5).cgColor }
        for i in bars.indices { bars[i].animator().frame = NSRect(x: bars[i].frame.origin.x, y: 0, width: 4, height: 6) }
    }
    func setResult(text: String, ok: Bool, inserted: Bool) {
        tick?.invalidate()
        spinner.stopAnimation(nil); spinner.isHidden = true
        dot.isHidden = true
        statusLabel.stringValue = ok ? (inserted ? "✓ 已粘贴" : "✓ 完成") : "✗ 失败"
        statusLabel.textColor = ok ? NSColor.systemGreen : NSColor.systemRed
        previewLabel.stringValue = String(text.prefix(90))
        previewLabel.isHidden = text.isEmpty
        for b in bars { b.isHidden = true }
        hideAfter(3.5)
    }
    func hide() {
        tick?.invalidate()
        panel?.orderOut(nil)
    }
    private func hideAfter(_ s: TimeInterval) {
        hideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.hide() }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: w)
    }
    private func heartbeats() {
        // 计时
        let el = Date().timeIntervalSince(startDate)
        timeLabel.stringValue = String(format: "%.1fs", el)
        // 红点呼吸
        let a = 0.45 + 0.55 * abs(sin(el * 3.5))
        dot.layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(a).cgColor
        // 电平条
        for i in bars.indices {
            let jitter = Float.random(in: 0.55...1.0)
            let h = 6 + smooth * 34 * jitter
            let target = CGFloat(max(6, min(34, h)))
            bars[i].animator().frame = NSRect(x: bars[i].frame.origin.x, y: (36 - target) / 2, width: 4, height: target)
        }
    }
    private func ensurePanel() {
        if panel != nil { for i in bars.indices { bars[i].isHidden = false }; statusLabel.textColor = NSColor.secondaryLabelColor; return }
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 64),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true

        let fx = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 380, height: 64))
        fx.material = .popover            // Typeless 式浅色磨砂
        fx.blendingMode = .behindWindow
        fx.state = .active
        fx.appearance = NSAppearance(named: .aqua)
        fx.wantsLayer = true
        fx.layer?.cornerRadius = 22
        fx.layer?.masksToBounds = true

        dot = NSView(frame: NSRect(x: 20, y: 28, width: 9, height: 9))
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4.5
        dot.layer?.backgroundColor = NSColor.systemRed.cgColor

        stack = NSStackView(frame: NSRect(x: 44, y: 14, width: 180, height: 36))
        stack.orientation = .horizontal
        stack.spacing = 5
        for _ in 0..<7 {
            let b = NSView(frame: NSRect(x: 0, y: 15, width: 4, height: 6))
            b.wantsLayer = true
            b.layer?.cornerRadius = 2
            b.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.75).cgColor
            stack.addArrangedSubview(b)
            bars.append(b)
        }
        spinner = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
        spinner.style = .spinning
        spinner.isHidden = true
        stack.addArrangedSubview(spinner)

        let mic = NSImageView()
        mic.image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "mic")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 13, weight: .medium))
        mic.contentTintColor = NSColor.systemRed
        mic.frame = NSRect(x: 0, y: 0, width: 18, height: 20)
        stack.addArrangedSubview(mic)
        modeLabel = NSTextField(labelWithString: "听写")
        modeLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        modeLabel.textColor = NSColor.labelColor

        timeLabel = NSTextField(labelWithString: "0.0s")
        timeLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        timeLabel.textColor = NSColor.secondaryLabelColor

        statusLabel = NSTextField(labelWithString: "")
        statusLabel.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        statusLabel.textColor = NSColor.secondaryLabelColor

        previewLabel = NSTextField(labelWithString: "")
        previewLabel.font = NSFont.systemFont(ofSize: 12)
        previewLabel.textColor = NSColor.labelColor
        previewLabel.lineBreakMode = .byTruncatingTail
        previewLabel.cell?.truncatesLastVisibleLine = true
        previewLabel.maximumNumberOfLines = 2

        let info = NSStackView(views: [modeLabel, timeLabel, statusLabel, previewLabel])
        info.orientation = .horizontal
        info.spacing = 10
        info.alignment = .centerY
        info.frame = NSRect(x: 236, y: 14, width: 134, height: 36)

        fx.addSubview(dot)
        fx.addSubview(stack)
        fx.addSubview(info)
        p.contentView = fx
        if let screen = NSScreen.main {
            let f = screen.frame
            p.setFrameOrigin(NSPoint(x: f.midX - 190, y: f.origin.y + 96))
        }
        panel = p
    }
}

// ---------- 历史窗口 ----------
final class HistoryWindow {
    private var window: NSWindow?
    private var text: NSTextView?
    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 580),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable],
                             backing: .buffered, defer: false)
            w.title = "Sayless 听写历史"
            w.center()
            let tv = NSTextView(frame: NSRect(x: 0, y: 0, width: 460, height: 580))
            tv.isEditable = false
            tv.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            tv.autoresizingMask = [.width]
            tv.textContainer?.widthTracksTextView = true
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 460, height: 580))
            scroll.documentView = tv
            scroll.hasVerticalScroller = true
            scroll.autoresizingMask = [.width, .height]
            w.contentView = scroll
            text = tv
            window = w
        }
        refresh()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    private func refresh() {
        guard let tv = text else { return }
        let ms = NSMutableAttributedString()
        let head: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .bold), .foregroundColor: NSColor.labelColor
        ]
        let body: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor
        ]
        if let raw = try? String(contentsOfFile: histPath, encoding: .utf8) {
            let entries = raw.split(separator: "\n").suffix(100).reversed()
            for line in entries {
                guard let d = line.data(using: .utf8),
                      let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
                let ts = (o["ts"] as? String ?? "").replacingOccurrences(of: "T", with: " ").prefix(19)
                let mode = o["mode"] as? String ?? "-"
                let out = o["out"] as? String ?? ""
                ms.append(NSAttributedString(string: "\(ts)  [\(mode)]\n", attributes: head))
                ms.append(NSAttributedString(string: "\(out)\n\n", attributes: body))
            }
        }
        if ms.length == 0 { ms.append(NSAttributedString(string: "（暂无历史）", attributes: body)) }
        tv.textStorage?.setAttributedString(ms)
    }
}



// ---------- 主面板（Typeless Hub 1:1） ----------
// 不可成为 key window：防止 WKWebView 吞掉键盘事件导致 Carbon 全局热键失效（鼠标操作不受影响）
final class NonKeyWindow: NSWindow {
    override var canBecomeKey: Bool { false }
}
final class HubWindow {
    private var window: NSWindow?
    private var web: WKWebView?
    func show(tab: Int = 0) {
        if window == nil {
            let w = NonKeyWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 750),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable],
                             backing: .buffered, defer: false)
            w.title = "Sayless"
            w.center()
            w.appearance = NSAppearance(named: .darkAqua)
            w.backgroundColor = NSColor(red: 0.05, green: 0.05, blue: 0.05, alpha: 1)
            let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1080, height: 750))
            wv.autoresizingMask = [.width, .height]
            wv.setValue(false, forKey: "drawsBackground")
            w.contentView = wv
            web = wv
            window = w
        }
        let html = buildHubHTML(tab: tab)
        logLine("hub html len=\(html.count) tab=\(tab)")
        try? html.write(toFile: "/tmp/hub-debug.html", atomically: true, encoding: .utf8)
        web?.loadHTMLString(html, baseURL: nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    private func buildHubHTML(tab: Int = 0) -> String {
        let histFile = NSHomeDirectory() + "/.sayless/history.jsonl"
        var entries: [[String: String]] = []
        var days: Set<String> = []
        var totalChars = 0
        if let raw = try? String(contentsOfFile: histFile, encoding: .utf8) {
            for line in raw.split(separator: "\n") {
                guard let d = line.data(using: .utf8),
                      let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
                let ts = o["ts"] as? String ?? ""
                let day = String(ts.prefix(10))
                let out = o["out"] as? String ?? ""
                totalChars += out.count
                days.insert(day)
                entries.append(["ts": ts, "mode": o["mode"] as? String ?? "-", "out": out])
            }
        }
        entries.reverse()
        // 连续天数
        var streak = 0
        var day = Calendar.current.startOfDay(for: Date())
        while days.contains(DateFormatter.iso(day)) { streak += 1; day = Calendar.current.date(byAdding: .day, value: -1, to: day)! }
        let dictFile = NSHomeDirectory() + "/.sayless/dictionary.json"
        var dictRows = "", hotChips = "", rules = ""
        if let raw = try? String(contentsOfFile: dictFile, encoding: .utf8),
           let dj = try? JSONSerialization.jsonObject(with: raw.data(using: .utf8)!) as? [String: Any] {
            for r in (dj["replacements"] as? [[String: Any]]) ?? [] {
                let f = r["from"] as? String ?? r["pattern"] as? String ?? "-"
                let t = r["to"] as? String ?? "-"
                dictRows += "<tr><td>\(f)</td><td>→</td><td><b>\(t)</b></td></tr>"
            }
            for h in (dj["hotwords"] as? [String]) ?? [] { hotChips += "<span class='chip'>\(h)</span>" }
            for r in (dj["styleRules"] as? [String]) ?? [] { rules += "<li>\(r)</li>" }
        }
        let heat = buildHeat(days)
        let histRows = entries.prefix(60).map { e -> String in
            let ts = (e["ts"] ?? "").replacingOccurrences(of: "T", with: " ").prefix(19)
            let out = (e["out"] ?? "").replacingOccurrences(of: "<", with: "&lt;")
            return "<div class='row'><span class='ts'>\(ts)</span><span class='md'>\(e["mode"] ?? "")</span><span class='ot'>\(out)</span></div>"
        }.joined()
        var html = hubTemplate
        html = html.replacingOccurrences(of: "__STAT1__", with: "\(totalChars)")
        html = html.replacingOccurrences(of: "__STAT2__", with: "\(entries.count)")
        html = html.replacingOccurrences(of: "__STAT3__", with: "\(days.count)")
        html = html.replacingOccurrences(of: "__STAT4__", with: "\(streak)")
        html = html.replacingOccurrences(of: "__HISTROWS__", with: histRows)
        html = html.replacingOccurrences(of: "__DICTROWS__", with: dictRows)
        html = html.replacingOccurrences(of: "__HOTCHIPS__", with: hotChips)
        html = html.replacingOccurrences(of: "__RULES__", with: rules)
        html = html.replacingOccurrences(of: "__HEAT__", with: heat)
        for i in 0...2 {
            let onCls = i == tab ? "on" : ""
            html = html.replacingOccurrences(of: "__T\(i)__", with: onCls)
            html = html.replacingOccurrences(of: "__VT\(i)__", with: i == tab ? "on" : "")
        }
        return html
    }
    private func buildHeat(_ days: Set<String>) -> String {
        var cells = ""
        let cal = Calendar.current
        var d = cal.date(byAdding: .day, value: -139, to: cal.startOfDay(for: Date()))!
        let fmt = { (d: Date) -> String in DateFormatter.yyyymmdd(d) }
        var weeks: [[String]] = []
        var cur: [String] = []
        for _ in 0...140 {
            let dow = cal.component(.weekday, from: d)
            let on = days.contains(fmt(d))
            let cls = on ? "on" : ""
            cur.append("<i class='" + cls + "' title='" + fmt(d) + "'></i>")
            if cur.count == 7 { weeks.append(cur); cur = [] }
            d = cal.date(byAdding: .day, value: 1, to: d)!
        }
        for w in weeks.reversed() { cells += "<div class='wk'>" + w.joined() + "</div>" }
        return cells
    }
}

extension DateFormatter {
    static func iso(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
    static func yyyymmdd(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
}

// ---------- 主应用 ----------
final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var hotkeyRef: EventHandlerRef?
    var handlerRef: EventHandlerRef?
    var ffmpeg: Process?
    var busy = false
    var pendingMode = 0 // 0=听写 1=翻译 2=问答
    let capsule = CapsulePanel()
    let hub = HubWindow()
    let meter = AudioMeter()
    let ffmpegPath = "/opt/homebrew/bin/ffmpeg"
    let saylessPath = "/opt/homebrew/bin/sayless"
    var wavPath: String { NSHomeDirectory() + "/.sayless/last-utterance.wav" }
    var childEnv: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        return env
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🎙"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "听写（⌥Space）", action: #selector(toggle), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "听写并翻译（⌥T）", action: #selector(translateToggle), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "语音问答（⌥Q）", action: #selector(askToggle), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "打开主面板…", action: #selector(showHub), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "听写历史…", action: #selector(showHistoryTab), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开词语库…", action: #selector(openDict), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "查看日志…", action: #selector(openLog), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出 SaylessBar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        registerHotkeys()
        logLine("launched v3")
    }

    func registerHotkeys() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let box = Unmanaged.passRetained(HotkeyBox(id: -1) { [weak self] id in self?.hotkey(id) }).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            var hkID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            let hb = Unmanaged<HotkeyBox>.fromOpaque(userData!.assumingMemoryBound(to: HotkeyBox.self)).takeUnretainedValue()
            logLine("hotkey event id=\(hkID.id)")
            hb.dispatch(Int(hkID.id))
            return noErr
        }, 1, &spec, box, &handlerRef)
        let keys: [(UInt32, Int)] = [(UInt32(kVK_Space), 0), (17, 1), (12, 2)]
        for (keyCode, id) in keys {
            var ref: EventHotKeyRef?
            RegisterEventHotKey(keyCode, UInt32(optionKey), EventHotKeyID(signature: fourCC("sayl"), id: UInt32(id)), GetApplicationEventTarget(), 0, &ref)
        }
    }

    @objc func toggle() { hotkey(0) }
    @objc func translateToggle() { hotkey(1) }
    @objc func askToggle() { hotkey(2) }
    @objc func transcribeOnly() { if !busy { transcribe(insert: false, mode: 0) } }
    @objc func showHub() { hub.show(tab: 0) }
    @objc func showHistoryTab() { hub.show(tab: 1) }
    @objc func openDict() { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/.sayless/dictionary.json")) }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }

    static var lastFire = Date.distantPast
    func hotkey(_ id: Int) {
        let now = Date()
        guard now.timeIntervalSince(AppDelegate.lastFire) > 0.25 else { return }
        AppDelegate.lastFire = now
        if busy { stopAndTranscribe(); return }
        pendingMode = id
        capsule.show(mode: id)
        startRecording()
    }

    func startRecording() {
        guard FileManager.default.fileExists(atPath: ffmpegPath) else { notify("找不到 ffmpeg", ffmpegPath); capsule.hide(); return }
        busy = true
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ffmpegPath)
        p.arguments = ["-f", "avfoundation", "-i", ":0", "-ar", "16000", "-ac", "1", "-y", wavPath]
        p.environment = childEnv
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        ffmpeg = p
        meter.start { [weak self] lvl in self?.capsule.setLevel(lvl) }
        do { try p.run(); logLine("recording start mode=\(pendingMode)") } catch {
            meter.stop(); busy = false; capsule.hide(); notify("录音启动失败", error.localizedDescription)
        }
    }

    func stopAndTranscribe() {
        guard let p = ffmpeg, p.isRunning else { busy = false; capsule.hide(); return }
        capsule.setProcessing()
        meter.stop()
        DispatchQueue.global().async { [weak self] in
            p.interrupt()
            p.waitUntilExit()
            DispatchQueue.main.async { self?.ffmpeg = nil; self?.transcribe(insert: true) }
        }
    }

    func transcribe(insert: Bool, mode: Int? = nil) {
        let m = mode ?? pendingMode
        pendingMode = 0
        var args = [saylessPath, "transcribe", wavPath]
        if m == 1 { args += ["--translate"] }
        if m == 2 { args += ["--ask"] }
        if !insert { args += ["--no-insert"] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/node")
        p.arguments = args
        p.environment = childEnv
        p.standardOutput = FileHandle.nullDevice
        let errPipe = Pipe()
        p.standardError = errPipe
        p.terminationHandler = { [weak self] proc in
            let data = errPipe.fileHandleForReading.readDataToEndOfFile()
            let errText = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                if proc.terminationStatus == 0 {
                    let finalText = errText.split(separator: "\n")
                        .first(where: { $0.hasPrefix("结果: ") })
                        .map { String($0.dropFirst("结果: ".count)) } ?? ""
                    self.capsule.setResult(text: finalText, ok: true, inserted: insert)
                    logLine("ok mode=\(m) text=\(finalText.prefix(80))")
                } else {
                    self.capsule.setResult(text: String(errText.suffix(160)), ok: false, inserted: false)
                    self.notify("听写失败（exit \(proc.terminationStatus)）", String(errText.suffix(160)))
                    logLine("failed: \(errText.suffix(160))")
                }
            }
        }
        do { try p.run() } catch { busy = false; capsule.hide(); notify("管线启动失败", error.localizedDescription) }
    }

    func notify(_ title: String, _ body: String) {
        let n = NSUserNotification()
        n.title = title
        n.informativeText = body
        NSUserNotificationCenter.default.deliver(n)
        logLine("notify: \(title) \(body)")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
