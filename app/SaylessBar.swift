// SaylessBar v3 — Typeless 式 UI：菜单栏 + 录音胶囊浮窗（电平动画/计时/模式）+ 结果预览卡 + 历史窗口。
// 设计：暗色 HUD 胶囊 360×64 底部居中；录音=红点呼吸+7 根电平条+计时；处理=旋转指示；完成=✓+文本预览 3.5s 自动消失。
import AppKit
import Carbon.HIToolbox
import AVFoundation
import WebKit
import ApplicationServices
import ServiceManagement
import ApplicationServices



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

// ---------- 录音器：AVAudioEngine 直录（~100ms 启动，无 ffmpeg 延迟）+ 电平表 ----------
final class AudioRecorder {
    private let engine = AVAudioEngine()
    private var onData: ((Float) -> Void)?
    private var converter: AVAudioConverter?
    private var pcm = Data()
    private var peak: Float = 0
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    var lastPeak: Float { peak }

    func start(onLevel: @escaping (Float) -> Void) {
        self.onData = onLevel
        pcm = Data()
        peak = 0
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let conv = self.converter else { return }
            if let ch = buffer.floatChannelData?[0] {
                let n = Int(buffer.frameLength)
                if n > 0 {
                    var sum: Float = 0
                    for i in stride(from: 0, to: n, by: 4) {
                        let v = ch[i]
                        sum += v * v
                    }
                    let rms = sqrt(sum / Float(n / 4))
                    let db = 20 * log10(max(rms, 1e-6))
                    let level = min(1, max(0, (db + 50) / 45)) // -50dB..+5dB
                    DispatchQueue.main.async { self.onData?(level) }
                    if level > self.peak { self.peak = level }
                }
            }
            let ratio = self.targetFormat.sampleRate / inputFormat.sampleRate
            let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
            if let out = AVAudioPCMBuffer(pcmFormat: self.targetFormat, frameCapacity: cap) {
                var err: NSError?
                var fed = false
                let st = conv.convert(to: out, error: &err) { _, st in
                    if fed {
                        st.pointee = .noDataNow
                        return nil
                    }
                    fed = true
                    st.pointee = .haveData
                    return buffer
                }
                if err == nil && st != .error, let ch = out.int16ChannelData?[0] {
                    self.pcm.append(Data(bytes: ch, count: Int(out.frameLength) * 2))
                }
            }
        }
        do {
            try engine.start()
        } catch {
            logLine("recorder start fail: \(error.localizedDescription)")
        }
    }

    /// stop and write PCM as 16k mono WAV; returns (peak, ok)
    func stopWrite(to url: URL) -> (peak: Float, ok: Bool) {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        let data = pcm
        pcm = Data()
        guard data.count > 3200 else { return (peak, false) } // <0.1s invalid
        var wav = Data()
        let dt = UInt32(data.count)
        func le32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        func le16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        wav.append("RIFF".data(using: .ascii)!)
        wav.append(le32(36 + dt))
        wav.append("WAVE".data(using: .ascii)!)
        wav.append("fmt ".data(using: .ascii)!)
        wav.append(le32(16))
        wav.append(le16(1))
        wav.append(le16(1))
        wav.append(le32(16000))
        wav.append(le32(32000))
        wav.append(le16(2))
        wav.append(le16(16))
        wav.append("data".data(using: .ascii)!)
        wav.append(le32(dt))
        wav.append(data)
        try? wav.write(to: url)
        return (peak, true)
    }
}
final class CapsulePanel {
    private var panel: NSPanel?
    private var xButton: NSButton!
    private var checkButton: NSButton!
    private var bars: [NSView] = []
    private var barContainer: NSView!
    private var thinkingLabel: NSTextField!
    private var level: Float = 0
    private var levelSmooth: Float = 0
    private var tick: Timer?
    private var hideWork: DispatchWorkItem?

    func show(mode: Int) {
        ensurePanel()
        setRecordingUI()
        tick?.invalidate()
        tick = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
            guard let self else { return }
            for (i, b) in self.bars.enumerated() {
                let phase = sin(Date().timeIntervalSince1970 * 7 + Double(i) * 0.9)
                let h = 8 + CGFloat(self.levelSmooth) * 18 * CGFloat(0.4 + 0.6 * abs(phase)) + CGFloat(abs(phase)) * 4
                b.animator().frame = NSRect(x: b.frame.origin.x, y: (24 - h) / 2, width: 3, height: max(3, h))
            }
        }
        panel?.orderFrontRegardless()
    }
    func setLevel(_ l: Float) {
        levelSmooth = levelSmooth * 0.65 + l * 0.35
    }
    func setProcessing() {
        tick?.invalidate()
        xButton.isHidden = true
        checkButton.isHidden = true
        barContainer.isHidden = true
        thinkingLabel.isHidden = false
        thinkingLabel.stringValue = "Thinking"
    }
    func setResult(text: String, ok: Bool, inserted: Bool) {
        tick?.invalidate()
        if ok { hide() } else {
            thinkingLabel.stringValue = "✗ " + text.prefix(50)
            thinkingLabel.font = NSFont.systemFont(ofSize: 13)
            hideAfter(3.5)
        }
    }
    func hide() {
        tick?.invalidate()
        panel?.orderOut(nil)
    }
    private func hideAfter(_ sec: TimeInterval) {
        hideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.hide() }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + sec, execute: w)
    }
    private func setRecordingUI() {
        xButton.isHidden = false
        checkButton.isHidden = false
        barContainer.isHidden = false
        thinkingLabel.isHidden = true
    }
    private func pillButton(_ title: String, _ x: CGFloat) -> NSButton {
        let btn = NSButton(frame: NSRect(x: x, y: 12, width: 28, height: 28))
        btn.wantsLayer = true
        btn.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.12).cgColor
        btn.layer?.cornerRadius = 6
        btn.isBordered = false
        btn.title = title
        btn.font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        btn.contentTintColor = NSColor.white
        return btn
    }
    private func ensurePanel() {
        if panel != nil {
            setRecordingUI()
            return
        }
        // Typeless 精确 token：440 宽 / #1d1a1a / radius 8 / 1px 边框 / shadow 0 0 20
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 52),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true

        let root = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 52))
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor(red: 0x1d/255.0, green: 0x1a/255.0, blue: 0x1a/255.0, alpha: 1).cgColor
        root.layer?.cornerRadius = 8
        root.layer?.borderWidth = 1
        root.layer?.borderColor = NSColor.white.withAlphaComponent(0.28).cgColor
        root.layer?.shadowColor = NSColor.black.cgColor
        root.layer?.shadowOpacity = 0.5
        root.layer?.shadowRadius = 10

        xButton = pillButton("✕", 10)
        xButton.target = self
        xButton.action = #selector(xClicked)

        barContainer = NSView(frame: NSRect(x: 158, y: 14, width: 124, height: 24))
        var bx: CGFloat = 0
        for _ in 0..<15 {
            let bar = NSView(frame: NSRect(x: bx, y: 5, width: 3, height: 14))
            bar.wantsLayer = true
            bar.layer?.cornerRadius = 1.5
            bar.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.92).cgColor
            barContainer.addSubview(bar)
            bars.append(bar)
            bx += 8
        }
        barContainer.wantsLayer = true

        checkButton = pillButton("✓", 402)
        checkButton.target = self
        checkButton.action = #selector(checkClicked)

        thinkingLabel = NSTextField(labelWithString: "Thinking")
        thinkingLabel.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        thinkingLabel.textColor = NSColor(white: 0.62, alpha: 1)
        thinkingLabel.alignment = .center
        thinkingLabel.frame = NSRect(x: 0, y: 12, width: 440, height: 28)
        thinkingLabel.isHidden = true

        root.addSubview(barContainer)
        root.addSubview(xButton)
        root.addSubview(checkButton)
        root.addSubview(thinkingLabel)
        p.contentView = root
        if let screen = NSScreen.main {
            let f = screen.frame
            p.setFrameOrigin(NSPoint(x: f.midX - 220, y: f.origin.y + 130))
        }
        panel = p
    }
    @objc func xClicked() { (NSApp.delegate as? AppDelegate)?.cancelRecording() }
    @objc func checkClicked() { (NSApp.delegate as? AppDelegate)?.stopFromUI() }
}


final class NonKeyWindow: NSWindow {
    override var canBecomeKey: Bool { false }
}
final class HubWindow: NSObject {
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
            w.backgroundColor = NSColor(red: 0.12, green: 0.12, blue: 0.12, alpha: 1)
            let cfg = WKWebViewConfiguration()
            cfg.userContentController.add(self, name: "dict")
            let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1080, height: 750), configuration: cfg)
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
        let tplPath = Bundle.main.path(forResource: "hub", ofType: "html") ?? "(nil)"
        logLine("hub tpl: \(tplPath)")
        guard tplPath != "(nil)",
              let tpl = try? String(contentsOfFile: tplPath, encoding: .utf8) else {
            return "<meta charset='utf-8'><body style='background:#1f1f1f;color:#bbb'>hub.html missing in bundle</body>"
        }
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
        // 连续天数：当前（今天或昨天起算，今天还没听写不清零）+ 历史最长
        var curStreak = 0, longest = 0
        var run = 0
        var prevIso: String?
        for dIso in days.sorted() {
            if let p = prevIso, let pd = DateFormatter.date(p + "T00:00:00Z"),
               let dd = DateFormatter.date(dIso + "T00:00:00Z"),
               let next = Calendar.current.date(byAdding: .day, value: 1, to: pd),
               Calendar.current.isDate(dd, inSameDayAs: next) {
                run += 1
            } else { run = 1 }
            longest = max(longest, run)
            prevIso = dIso
        }
        var probe = Calendar.current.startOfDay(for: Date())
        if !days.contains(DateFormatter.iso(probe)) {
            probe = Calendar.current.date(byAdding: .day, value: -1, to: probe)!
        }
        while days.contains(DateFormatter.iso(probe)) {
            curStreak += 1
            probe = Calendar.current.date(byAdding: .day, value: -1, to: probe)!
        }
        let streak = curStreak
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
        // 词典数据：替换行（可删）、热词 chips（可删）、词频、分应用层
        var dictRowsEdit = "", hotChipsEdit = "", appPlayers = ""
        var wordFreq: [String: Int] = [:]
        let esc = { (t: String) -> String in
            t.replacingOccurrences(of: "\\", with: "\\\\")
             .replacingOccurrences(of: "'", with: "\\'")
             .replacingOccurrences(of: "<", with: "&lt;")
        }
        if let raw = try? String(contentsOfFile: dictFile, encoding: .utf8),
           let djData = raw.data(using: .utf8),
           let dj = try? JSONSerialization.jsonObject(with: djData) as? [String: Any] {
            let hotwords = (dj["hotwords"] as? [String]) ?? []
            for e in entries {
                let out = e["out"] ?? ""
                for w in hotwords where out.contains(w) { wordFreq[w, default: 0] += 1 }
            }
            for r in (dj["replacements"] as? [[String: Any]]) ?? [] {
                let f = esc(r["from"] as? String ?? "-")
                let t = esc(r["to"] as? String ?? "-")
                dictRowsEdit += "<tr><td>\(f)</td><td>→</td><td><b>\(t)</b></td><td><a style=\"color:#f87171;cursor:pointer\" onclick=\"dictPost({action:'delReplace',from:'\(f)'})\">✕</a></td></tr>"
            }
            for w in hotwords {
                let c = wordFreq[w] ?? 0
                hotChipsEdit += "<span class=\"chip\">\(esc(w)) · \(c)次 <a style=\"color:#f87171;cursor:pointer\" onclick=\"dictPost({action:'delHot',word:'\(esc(w))'})\">✕</a></span>"
            }
            if let apps = dj["apps"] as? [String: [String: Any]] {
                for (name, layer) in apps {
                    let hw = (layer["hotwords"] as? [String]) ?? []
                    let rp = (layer["replacements"] as? [[String: Any]]) ?? []
                    appPlayers += "<div class=\"card\" style=\"margin-bottom:12px\"><div style=\"font-weight:700\">\(esc(name))</div>"
                    appPlayers += "<div style=\"font-size:12px;color:#999;margin:6px 0\">热词 \(hw.count) 个 · 替换 \(rp.count) 条</div>"
                    if !hw.isEmpty { appPlayers += "<div style=\"font-size:12px\">" + hw.map { esc($0) }.joined(separator: "、") + "</div>" }
                    appPlayers += "</div>"
                }
            }
            if (dj["apps"] as? [String: Any])?.isEmpty ?? true {
                appPlayers = "<div style=\"font-size:13px;color:#999\">尚未配置。在 dictionary.json 加 \"apps\": {\"微信\": {\"hotwords\": [...]}}，热键按下时按前台应用自动叠加。</div>"
            }
            if wordFreq.isEmpty {
                wordFreq["（暂无命中，多听写几条后回来看）"] = 0
            }
        }
        let wordStats = wordFreq.sorted { $0.value > $1.value }
            .map { "<span class=\"chip\">\(esc($0.key)) · \($0.value)次</span>" }.joined(separator: " ")
        let heat = buildHeat(days)
        let histRows = entries.prefix(60).map { e -> String in
            let ts = (e["ts"] ?? "").replacingOccurrences(of: "T", with: " ").prefix(19)
            let out = (e["out"] ?? "").replacingOccurrences(of: "<", with: "&lt;")
            return "<div class='row'><span class='ts'>\(ts)</span><span class='md'>\(e["mode"] ?? "")</span><span class='ot'>\(out)</span></div>"
        }.joined()
        var html = tpl
        html = html.replacingOccurrences(of: "__STAT1__", with: "\(totalChars)")
        html = html.replacingOccurrences(of: "__STAT2__", with: "\(entries.count)")
        html = html.replacingOccurrences(of: "__STAT3__", with: "\(days.count)")
        html = html.replacingOccurrences(of: "__STAT4__", with: "\(streak)")
        html = html.replacingOccurrences(of: "__STAT5__", with: "\(longest)")
        html = html.replacingOccurrences(of: "__HISTROWS__", with: histRows)
        html = html.replacingOccurrences(of: "__DICTROWS__", with: dictRows)
        html = html.replacingOccurrences(of: "__HOTCHIPS__", with: hotChips)
        html = html.replacingOccurrences(of: "__HOTCHIPS_EDIT__", with: hotChipsEdit)
        html = html.replacingOccurrences(of: "__DICTROWS_EDIT__", with: dictRowsEdit)
        html = html.replacingOccurrences(of: "__APPLAYERS__", with: appPlayers)
        html = html.replacingOccurrences(of: "__WORDSTATS__", with: wordStats)
        html = html.replacingOccurrences(of: "__RULES__", with: rules)
        html = html.replacingOccurrences(of: "__HEAT__", with: heat)
        for i in 0...3 {
            let onCls = i == tab ? "on" : ""
            html = html.replacingOccurrences(of: "__T\(i)__", with: onCls)
            html = html.replacingOccurrences(of: "__VT\(i)__", with: i == tab ? "on" : "")
        }
        // 设置页注入：providers id 列表 + 脱敏后的完整配置（apiKey 一律不出 config.json）
        let cfgFile = NSHomeDirectory() + "/.sayless/config.json"
        var cfgObj: [String: Any] = [:]
        if let raw = try? String(contentsOfFile: cfgFile, encoding: .utf8),
           let j = try? JSONSerialization.jsonObject(with: raw.data(using: .utf8)!) as? [String: Any] {
            cfgObj = j
        }
        func sanitized(_ o: Any) -> Any {
            if let d = o as? [String: Any] {
                var out: [String: Any] = [:]
                for (k, v) in d where k != "apiKey" { out[k] = sanitized(v) }
                return out
            }
            if let a = o as? [Any] { return a.map { sanitized($0) } }
            return o
        }
        let providerIds = ((cfgObj["providers"] as? [String: Any]) ?? [:]).keys.sorted()
        var cfgJson = "{}"
        if let d = try? JSONSerialization.data(withJSONObject: sanitized(cfgObj)) {
            cfgJson = String(data: d, encoding: .utf8) ?? "{}"
        }
        html = html.replacingOccurrences(of: "__CFGJSON__", with: cfgJson.replacingOccurrences(of: "</", with: "<\\/"))
        html = html.replacingOccurrences(of: "__PROVIDERS__", with: providerIds.map { "\"\($0)\"" }.joined(separator: ","))
        return html
    }
    private func buildHeat(_ days: Set<String>) -> String {
        var cells = ""
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        // 网格从 ~20 周前所在周的周日开始（weekday: 1=周日），保证每列 = 一个日历周
        let start = cal.date(byAdding: .day, value: -139, to: today)!
        let dow = cal.component(.weekday, from: start)
        var d = cal.date(byAdding: .day, value: -(dow - 1), to: start)!
        // 周为列、从旧到新自左向右；当前周只画到今天，未来日子留透明占位
        while d <= today {
            var col = ""
            for _ in 0..<7 {
                if d > today {
                    col += "<i style='opacity:0'></i>"
                } else {
                    let iso = DateFormatter.yyyymmdd(d)
                    col += "<i class='" + (days.contains(iso) ? "on" : "") + "' title='" + iso + "'></i>"
                }
                d = cal.date(byAdding: .day, value: 1, to: d)!
            }
            cells += "<div class='wk'>" + col + "</div>"
        }
        return cells
    }
}
    // 设置保存走 userContentController 的 "saveCfg" case（深合并进 config.json，保留 0600 权限）

extension HubWindow: WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "dict",
              let body = message.body as? String,
              let j = try? JSONSerialization.jsonObject(with: body.data(using: .utf8)!) as? [String: Any],
              let action = j["action"] as? String else { return }
        let dictFile = NSHomeDirectory() + "/.sayless/dictionary.json"
        guard let raw = try? String(contentsOfFile: dictFile, encoding: .utf8),
              var d = (try? JSONSerialization.jsonObject(with: raw.data(using: .utf8)!)) as? [String: Any] else { return }
        var dirty = false
        switch action {
        case "addReplace":
            let from = j["from"] as? String ?? "", to = j["to"] as? String ?? ""
            if !from.isEmpty && !to.isEmpty {
                var reps = (d["replacements"] as? [[String: Any]]) ?? []
                reps = reps.filter { ($0["from"] as? String) != from }
                reps.append(["from": from, "to": to])
                d["replacements"] = reps; dirty = true
            }
        case "delReplace":
            let from = j["from"] as? String ?? ""
            var reps = (d["replacements"] as? [[String: Any]]) ?? []
            reps = reps.filter { ($0["from"] as? String) != from }
            d["replacements"] = reps; dirty = true
        case "addHot":
            let w = j["word"] as? String ?? ""
            if !w.isEmpty {
                var hot = (d["hotwords"] as? [String]) ?? []
                if !hot.contains(w) { hot.append(w); d["hotwords"] = hot; dirty = true }
            }
        case "delHot":
            let w = j["word"] as? String ?? ""
            var hot = (d["hotwords"] as? [String]) ?? []
            hot.removeAll { $0 == w }
            d["hotwords"] = hot; dirty = true
        case "saveCfg":
            // 深合并：表单只提交它有的字段，key 等其余字段原样保留
            if let cfgNew = j["config"] as? [String: Any] {
                let cfgFile = NSHomeDirectory() + "/.sayless/config.json"
                if let raw = try? String(contentsOfFile: cfgFile, encoding: .utf8),
                   var cfg = (try? JSONSerialization.jsonObject(with: raw.data(using: .utf8)!)) as? [String: Any] {
                    for (k, v) in cfgNew {
                        if let sub = v as? [String: Any], let dstSub = cfg[k] as? [String: Any] {
                            var merged = dstSub
                            for (kk, vv) in sub { merged[kk] = vv }
                            cfg[k] = merged
                        } else { cfg[k] = v }
                    }
                    if let out = try? JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted]) {
                        try? out.write(to: URL(fileURLWithPath: cfgFile))
                        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cfgFile)
                    }
                    logLine("cfg saved from hub")
                }
            }
        default: break
        }
        if dirty {
            try? JSONSerialization.data(withJSONObject: d, options: [.prettyPrinted])
                .write(to: URL(fileURLWithPath: dictFile))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                self?.web?.reload()
            }
        }
    }
}

extension DateFormatter {
    static func iso(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }
    static func date(_ s: String) -> Date? {
        ISO8601DateFormatter().date(from: s)
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
    var ptt = false        // 按住说话模式
    var soundOn = true
    var savedClipboard: String?
    var targetApp = ""     // 按热键时的前台应用名，用于分应用词层
    // 键位注册表：slot -> (keyCode, 修饰键名)；改这里或 config 即改键
    var hotkeys: [String: (key: UInt32, mods: String)] = [
        "dictate": (49, "option"), "translate": (17, "option"), "ask": (12, "option")
    ]
    var hotkeyMap: [UInt32: (mods: CGEventFlags, id: Int)] = [:]
    func refreshHotkeyMap() {
        hotkeyMap = [:]
        let ids = ["dictate": 0, "translate": 1, "ask": 2]
        for (slot, def) in hotkeys {
            if let id = ids[slot] { hotkeyMap[def.key] = (flagName(def.mods), id) }
        }
    }
    static let modMap: [String: CGEventFlags] = [
        "option": .maskAlternate, "command": .maskCommand, "control": .maskControl,
        "shift": .maskShift, "none": []
    ]
    var stopWork: DispatchWorkItem?
    let capsule = CapsulePanel()
    let hub = HubWindow()
    let recorder = AudioRecorder()
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
        menu.addItem(NSMenuItem(title: "紧急停止录音", action: #selector(forceStop), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "请求辅助功能授权…", action: #selector(requestAX), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "登录时启动", action: #selector(toggleLoginItem), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "听写历史…", action: #selector(showHistoryTab), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "设置…", action: #selector(showSettingsTab), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开词语库…", action: #selector(openDict), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "查看日志…", action: #selector(openLog), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出 SaylessBar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        loadAppConfig()
        registerHotkeys()
        checkAX()
        logLine("launched v4.4 ptt=\(ptt)")
        // 调试/自动化口子：SAYLESS_SHOW_HUB=<tab> 启动即开面板（0首页 1历史 2词典 3设置）
        if let hubArg = ProcessInfo.processInfo.environment["SAYLESS_SHOW_HUB"], let t = Int(hubArg) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.hub.show(tab: t) }
        }
    }

    func loadAppConfig() {
        let f = NSHomeDirectory() + "/.sayless/config.json"
        if let raw = try? String(contentsOfFile: f, encoding: .utf8),
           let d = raw.data(using: .utf8),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            ptt = j["ptt"] as? Bool ?? false
            soundOn = j["sound"] as? Bool ?? true
            if let hk = j["hotkeys"] as? [String: [String: Any]] {
                for (slot, def) in hk {
                    if let k = def["key"] as? Int {
                        hotkeys[slot] = (key: UInt32(k), mods: def["modifier"] as? String ?? "option")
                    }
                }
            }
            refreshHotkeyMap()
            logLine("hotkeyMap entries: \(hotkeyMap.count) -> \(hotkeyMap.keys.sorted())")
        }
    }
    func flagName(_ f: String) -> CGEventFlags {
        switch f {
        case "command": return .maskCommand
        case "control": return .maskControl
        case "shift": return .maskShift
        case "none": return []
        default: return .maskAlternate
        }
    }
    func beep(_ name: String) {
        if soundOn { NSSound(named: name)?.play() }
    }
    /// 保存剪贴板 → 粘贴 → 1.6s 后恢复
    func pasteText(_ text: String) {
        let old = runTool("/usr/bin/pbpaste", [])
        runTool("/usr/bin/pbcopy", [], input: text)
        runTool("/usr/bin/osascript", ["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.6) {
            if !old.isEmpty { self.runTool("/usr/bin/pbcopy", [], input: old) }
        }
    }
    func runTool(_ path: String, _ args: [String], input: String? = nil) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.environment = childEnv
        if let input { p.standardInput = Pipe(); }
        let outPipe = Pipe(); p.standardOutput = outPipe
        do { try p.run() } catch { logLine("run \(path) fail: \(error.localizedDescription)"); return "" }
        if let input { (p.standardInput as? Pipe)?.fileHandleForWriting.write(input.data(using: .utf8)!); (p.standardInput as? Pipe)?.fileHandleForWriting.closeFile() }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func checkAX() {
        if AXIsProcessTrusted() {
            logLine("AX trusted")
            installCGEventTap()
            return
        }
        logLine("AX NOT trusted")
        installCGEventTap() // 未授权时创建失败，但保留重试入口
        let flag = NSHomeDirectory() + "/.sayless/.ax-prompted"
        if !FileManager.default.fileExists(atPath: flag) {
            // 仅首次弹系统授权框，之后永不自动弹
            try? "".write(toFile: flag, atomically: true, encoding: .utf8)
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }
    }
    @objc func stopFromUI() {
        guard busy else { return }
        stopAndTranscribe()
    }
    @objc func forceStop() {
        recorder.stopWrite(to: URL(fileURLWithPath: wavPath))
        busy = false
        capsule.hide()
        logLine("force stopped")
    }

    static var captureSlot: String?
    static var lastFire = Date.distantPast
    func hotkey(_ id: Int, keyUp: Bool = false) {
        if ptt { // 按住说话：按下开始，松开结束
            if keyUp { if busy { stopAndTranscribe() } }
            else if !busy { pendingMode = id; capsule.show(mode: id); startRecording(); beep("Tink") }
            return
        }
        let now = Date()
        guard now.timeIntervalSince(AppDelegate.lastFire) > 0.25 else { return }
        AppDelegate.lastFire = now
        if busy { stopAndTranscribe(); beep("Pop"); return }
        pendingMode = id
        capsule.show(mode: id)
        startRecording()
        beep("Tink")
    }
    func cancelRecording() {
        stopWork?.cancel()
        busy = false
        recorder.stopWrite(to: URL(fileURLWithPath: wavPath)) // 覆盖即丢弃
        capsule.hide()
        beep("Basso")
        logLine("cancelled")
    }

    var tapPort: CFMachPort?
    var tapSource: CFRunLoopSource?
    func installCGEventTap() {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
                   | (1 << CGEventType.tapDisabledByTimeout.rawValue)
        let cb: CGEventTapCallBack = { _, type, event, _ in
            guard let app = NSApp.delegate as? AppDelegate else { return Unmanaged.passUnretained(event) }
            if type == .tapDisabledByTimeout {
                if let port = app.tapPort { CGEvent.tapEnable(tap: port, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            let isUp = type == .keyUp
            if code == 53 && app.busy { // Esc 取消录音
                DispatchQueue.main.async { app.cancelRecording() }
                return Unmanaged.passUnretained(event)
            }
            if let h = app.hotkeyMap[UInt32(code)] {
                let mods = event.flags
                let need = h.mods
                let ok = need.isEmpty ? mods.isEmpty : mods.isSuperset(of: need)
                if ok { DispatchQueue.main.async { app.hotkey(h.id, keyUp: isUp) } }
            }
            return Unmanaged.passUnretained(event)
        }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                           options: .listenOnly, eventsOfInterest: CGEventMask(mask),
                                           callback: cb, userInfo: nil) else {
            logLine("CGEventTap 未创建（待辅助功能授权），Carbon 兜底中")
            return
        }
        tapPort = port
        CGEvent.tapEnable(tap: port, enable: true)
        tapSource = CFMachPortCreateRunLoopSource(nil, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .defaultMode)
        logLine("CGEventTap 已启用（热键走 tap，先于输入法拦截）")
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
        let idByCode = ["dictate": 0, "translate": 1, "ask": 2]
        let keys: [(UInt32, Int)] = hotkeys.compactMap { slot, def in
            guard let id = idByCode[slot] else { return nil }
            return (def.key, id)
        }
        for (keyCode, id) in keys {
            var ref: EventHotKeyRef?
            RegisterEventHotKey(keyCode, UInt32(optionKey), EventHotKeyID(signature: fourCC("sayl"), id: UInt32(id)), GetApplicationEventTarget(), 0, &ref)
        }
        Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] t in
            guard let self, self.tapPort == nil else { t.invalidate(); return }
            if AXIsProcessTrusted() { logLine("AX trusted（授权翻转）"); self.installCGEventTap(); t.invalidate() }
        }
    }

    @objc func toggle() { hotkey(0) }
    @objc func translateToggle() { hotkey(1) }
    @objc func askToggle() { hotkey(2) }
    @objc func transcribeOnly() { if !busy { transcribe(insert: false, mode: 0) } }
    @objc func toggleLoginItem() {
        do { try SMAppService.mainApp.register() } catch {
            logLine("login item: \(error.localizedDescription)")
            do { try SMAppService.mainApp.unregister() } catch {}
        }
    }
    @objc func showHub() { hub.show(tab: 0) }
    @objc func requestAX() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }
    @objc func showHistoryTab() { hub.show(tab: 1) }
    @objc func showSettingsTab() { hub.show(tab: 3) }
    @objc func openDict() { NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/.sayless/dictionary.json")) }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }



    func startRecording() {
        busy = true
        targetApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        recorder.start { [weak self] lvl in self?.capsule.setLevel(lvl) }
        logLine("recording start mode=\(pendingMode)")
        stopWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self, self.busy else { return }
            logLine("max duration reached, auto stop")
            self.stopAndTranscribe()
        }
        stopWork = w
        DispatchQueue.global().asyncAfter(deadline: .now() + 90, execute: w)
    }

    func stopAndTranscribe() {
        capsule.setProcessing()
        stopWork?.cancel()
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let (pk, ok) = self.recorder.stopWrite(to: URL(fileURLWithPath: self.wavPath))
            DispatchQueue.main.async {
                if !ok || pk < 0.05 {
                    self.busy = false
                    self.capsule.setResult(text: "未检测到语音（音量过低）", ok: false, inserted: false)
                    logLine("no speech, peak=\(pk)")
                    return
                }
                logLine("recording peak=\(pk)")
                self.transcribe(insert: true, force: true)
            }
        }
    }

    func transcribe(insert: Bool, mode: Int? = nil, force: Bool = false) {
        let m = mode ?? pendingMode
        pendingMode = 0
        var args = [saylessPath, "transcribe", wavPath, "--no-insert"]
        if m == 1 { args += ["--translate"] }
        if m == 2 { args += ["--ask"] }
        if !targetApp.isEmpty { args += ["--app", targetApp] }
        if force { args += ["--force"] }
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
                    if insert && !finalText.isEmpty { self.pasteText(finalText) }
                    self.capsule.setResult(text: finalText, ok: true, inserted: insert && !finalText.isEmpty)
                    self.beep("Pop")
                    logLine("ok mode=\(m) text=\(finalText.prefix(80))")
                } else {
                    self.capsule.setResult(text: String(errText.suffix(160)), ok: false, inserted: false)
                    self.beep("Basso")
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
