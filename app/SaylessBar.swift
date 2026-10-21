// SaylessBar v4.6 — Typeless 式 UI：菜单栏 + 录音胶囊浮窗 + 数据驱动 hub（首页/历史/词典/设置）。
// 设计：暗色 HUD 胶囊 440×52 底部居中；录音=实时 15 根电平条；处理=Thinking；完成=✓+文本预览自隐。
import AppKit
import Carbon.HIToolbox
import AVFoundation
import WebKit
import ApplicationServices
import ServiceManagement



let saylessDataDir: String = {
    if let p = ProcessInfo.processInfo.environment["SAYLESS_DIR"], !p.isEmpty {
        let expanded = (p as NSString).expandingTildeInPath
        return expanded.hasPrefix("/") ? expanded : (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(expanded)
    }
    return NSHomeDirectory() + "/.sayless"
}()
let logPath = saylessDataDir + "/saylessbar.log"

func logLine(_ s: String) {
    let line = "\(Date().description) \(s)\n"
    if !FileManager.default.fileExists(atPath: logPath) {
        FileManager.default.createFile(atPath: logPath, contents: nil)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logPath)
    }
    if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
}

final class HotkeyBox {
    init(id: Int, action: @escaping (Int, Bool) -> Void) { self.action = action }
    let action: (Int, Bool) -> Void
    func dispatch(_ id: Int, keyUp: Bool = false) { action(id, keyUp) }
}

func fourCC(_ s: String) -> FourCharCode {
    var v: FourCharCode = 0
    for b in s.utf8.prefix(4) { v = (v << 8) &+ FourCharCode(b) }
    return v
}

// ---------- 录音器：AVAudioEngine 直录（~100ms 启动，无 ffmpeg 延迟）+ 电平表 ----------
final class AudioRecorder {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private let engineQueue = DispatchQueue(label: "io.leo.sayless.recorder")
    private var onData: ((Float) -> Void)?
    private var converter: AVAudioConverter?
    private var pcm = Data()
    private var peak: Float = 0
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    var lastPeak: Float { lock.lock(); defer { lock.unlock() }; return peak }

    /// 返回 false 表示麦克风/引擎启动失败（权限、无输入设备、格式异常）
    @discardableResult
    func start(onLevel: @escaping (Float) -> Void) -> Bool {
        engineQueue.sync { self.startLocked(onLevel: onLevel) }
    }

    private func startLocked(onLevel: @escaping (Float) -> Void) -> Bool {
        self.onData = onLevel
        lock.lock()
        pcm = Data()
        peak = 0
        lock.unlock()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            logLine("recorder: invalid input format rate=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount)（麦克风权限/设备？）")
            return false
        }
        guard let conv = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            logLine("recorder: converter init fail")
            return false
        }
        converter = conv
        input.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
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
                    self.lock.lock()
                    if level > self.peak { self.peak = level }
                    self.lock.unlock()
                    DispatchQueue.main.async { self.onData?(level) }
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
                    self.lock.lock()
                    self.pcm.append(Data(bytes: ch, count: Int(out.frameLength) * 2))
                    self.lock.unlock()
                }
            }
        }
        do {
            try engine.start()
            return true
        } catch {
            logLine("recorder start fail: \(error.localizedDescription)")
            input.removeTap(onBus: 0)
            return false
        }
    }

    /// stop and write PCM as 16k mono WAV; reason: tooShort | write | nil
    func stopWrite(to url: URL) -> (peak: Float, ok: Bool, reason: String?) {
        engineQueue.sync { self.stopWriteLocked(to: url) }
    }

    private func stopWriteLocked(to url: URL) -> (peak: Float, ok: Bool, reason: String?) {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        onData = nil
        lock.lock()
        let data = pcm
        let pk = peak
        pcm = Data()
        lock.unlock()
        guard data.count > 3200 else { return (pk, false, "tooShort") } // <0.1s invalid
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
        do {
            // 先建 0600 文件再写，避免共享目录里出现短暂的 0644 录音
            try? FileManager.default.removeItem(at: url)
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
            try wav.write(to: url)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            return (pk, true, nil)
        } catch {
            logLine("write wav fail: \(error.localizedDescription)")
            return (pk, false, "write")
        }
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
        hideWork?.cancel()
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
        hideWork?.cancel()
        ensurePanel()
        panel?.orderFrontRegardless()
        tick?.invalidate()
        xButton.isHidden = true
        checkButton.isHidden = true
        barContainer.isHidden = true
        thinkingLabel.isHidden = false
        thinkingLabel.textColor = NSColor(white: 0.62, alpha: 1)
        thinkingLabel.stringValue = "Thinking"
    }
    func setResult(text: String, ok: Bool, inserted: Bool) {
        ensurePanel()
        panel?.orderFrontRegardless()
        tick?.invalidate()
        xButton.isHidden = true
        checkButton.isHidden = true
        barContainer.isHidden = true
        thinkingLabel.isHidden = false
        thinkingLabel.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        thinkingLabel.textColor = ok ? NSColor(white: 0.88, alpha: 1) : NSColor(red: 0.98, green: 0.62, blue: 0.62, alpha: 1)
        let preview = String(text.prefix(72)).replacingOccurrences(of: "\n", with: " ")
        thinkingLabel.stringValue = (ok ? "✓ " : "✗ ") + preview
        hideAfter(ok ? 2.2 : 3.5)
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


// ---------- 共享路径 / 工具 ----------
let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "4.6.0"
let functionKeyCodes: Set<UInt32> = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111] // F1-F12
let saylessConfigFile = saylessDataDir + "/config.json"
let saylessDictFile = saylessDataDir + "/dictionary.json"
let saylessHistoryFile = saylessDataDir + "/history.jsonl"
let saylessFeedbackFile = saylessDataDir + "/feedback.jsonl"
let saylessRecordingsDir = saylessDataDir + "/recordings"

func jsonObject(at path: String) -> [String: Any]? {
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func writeData(_ data: Data, to path: String, mode: Int = 0o600) -> Bool {
    let url = URL(fileURLWithPath: path)
    do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.deletingLastPathComponent().path)
        try data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: path)
        return true
    } catch {
        logLine("write \(path) fail: \(error.localizedDescription)")
        return false
    }
}

func writeJSONObject(_ obj: [String: Any], to path: String, mode: Int = 0o600) -> Bool {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) else {
        return false
    }
    return writeData(data, to: path, mode: mode)
}

func readHistoryObjects() -> [[String: Any]] {
    guard let raw = try? String(contentsOfFile: saylessHistoryFile, encoding: .utf8) else { return [] }
    var out: [[String: Any]] = []
    for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
        guard let data = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        out.append(obj)
    }
    return out
}

func parseISODate(_ s: String) -> Date? {
    guard !s.isEmpty else { return nil }
    let frac = ISO8601DateFormatter()
    frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = frac.date(from: s) { return d }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let d = plain.date(from: s) { return d }
    return nil
}

func localDayString(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
}

func dayStart(_ day: String) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: day)
}

func expandTilde(_ path: String) -> String {
    (path as NSString).expandingTildeInPath
}

func whichTool(_ name: String) -> String? {
    let env = ProcessInfo.processInfo.environment
    let envPath = env["PATH"] ?? ""
    var dirs = envPath.split(separator: ":").map(String.init)
    let home = NSHomeDirectory()
    var extras = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
                  "\(home)/.volta/bin", "\(home)/.local/bin", "\(home)/.asdf/shims", "\(home)/.nodenv/shims"]
    if let nvmBin = env["NVM_BIN"], !nvmBin.isEmpty { extras.insert(nvmBin, at: 0) }
    // Finder 启动的 App 看不到 nvm/fnm 的 shell 初始化；补上常见版本管理器目录
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/.nvm/versions/node") {
        for v in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) { extras.append("\(home)/.nvm/versions/node/\(v)/bin") }
    }
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/.local/share/fnm/node-versions") {
        for v in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) { extras.append("\(home)/.local/share/fnm/node-versions/\(v)/installation/bin") }
    }
    for extra in extras where !dirs.contains(extra) { dirs.append(extra) }
    for dir in dirs {
        let p = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
}

func resolveRecordingURL(_ file: String) -> URL? {
    let name = (file as NSString).lastPathComponent
    guard !name.isEmpty, name.hasSuffix(".wav"), !name.contains("..") else { return nil }
    let dir = URL(fileURLWithPath: saylessRecordingsDir, isDirectory: true).standardizedFileURL
    let url = dir.appendingPathComponent(name).standardizedFileURL
    guard url.deletingLastPathComponent().standardizedFileURL.path == dir.path,
          FileManager.default.fileExists(atPath: url.path) else { return nil }
    return url
}

func saylessCLIPath() -> String? {
    var candidates: [String] = []
    if let env = ProcessInfo.processInfo.environment["SAYLESS_CLI"], !env.isEmpty { candidates.append(env) }
    if let bundled = Bundle.main.path(forResource: "sayless", ofType: "mjs") { candidates.append(bundled) }
    candidates.append(contentsOf: [
        "/opt/homebrew/bin/sayless",
        "/usr/local/bin/sayless",
        NSHomeDirectory() + "/.local/bin/sayless",
        NSHomeDirectory() + "/bin/sayless"
    ])
    for c in candidates {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: c, isDirectory: &isDir), !isDir.boolValue { return c }
    }
    return nil
}

func runProcess(_ executable: String, _ args: [String], env extra: [String: String] = [:]) -> (stdout: String, stderr: String, code: Int32) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: executable)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    for (k, v) in extra { env[k] = v }
    p.environment = env
    let outPipe = Pipe()
    let errPipe = Pipe()
    p.standardOutput = outPipe
    p.standardError = errPipe
    do { try p.run() } catch {
        return ("", error.localizedDescription, -1)
    }
    let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
    let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (String(data: outData, encoding: .utf8) ?? "", String(data: errData, encoding: .utf8) ?? "", p.terminationStatus)
}

let cachedNodeVersion: String = {
    guard let node = whichTool("node") else { return "未安装" }
    let r = runProcess(node, ["--version"])
    let v = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    return v.isEmpty ? r.stderr.trimmingCharacters(in: .whitespacesAndNewlines) : v
}()

func configFileMode() -> String? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: saylessConfigFile),
          let n = attrs[.posixPermissions] as? NSNumber else { return nil }
    return String(format: "%o", n.intValue & 0o777)
}

func jsStringLiteral(_ s: String) -> String {
    var out = s
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\r", with: "\\r")
        .replacingOccurrences(of: "\t", with: "\\t")
    out = out.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
             .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    return "\"\(out)\""
}

func jsonForHTML(_ obj: Any) -> String {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj),
          var s = String(data: data, encoding: .utf8) else { return "{}" }
    s = s.replacingOccurrences(of: "<", with: "\\u003c")
         .replacingOccurrences(of: ">", with: "\\u003e")
         .replacingOccurrences(of: "&", with: "\\u0026")
         .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
         .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    return s
}

func sanitizedConfig(_ any: Any) -> Any {
    if let dict = any as? [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in dict where k != "apiKey" {
            out[k] = sanitizedConfig(v)
        }
        return out
    }
    if let arr = any as? [Any] {
        return arr.map(sanitizedConfig)
    }
    return any
}

func deepMergeConfig(_ dst: inout [String: Any], _ src: [String: Any]) {
    for (k, v) in src {
        if v is NSNull {
            dst.removeValue(forKey: k)
            continue
        }
        if let sub = v as? [String: Any] {
            var existing = (dst[k] as? [String: Any]) ?? [:]
            deepMergeConfig(&existing, sub)
            dst[k] = existing
        } else {
            dst[k] = v
        }
    }
}

func intValue(_ any: Any?) -> Int? {
    if let n = any as? Int { return n }
    if let n = any as? NSNumber { return n.intValue }
    if let s = any as? String { return Int(s) }
    return nil
}

func stringValue(_ any: Any?) -> String {
    guard let any = any else { return "" }
    if let s = any as? String { return s }
    if any is NSNull { return "" }
    if let n = any as? NSNumber { return n.stringValue }
    return ""
}

// ---------- Hub 窗口 ----------
final class HubWindow: NSObject {
    private var window: NSWindow?
    private var web: WKWebView?
    private var currentTab = 0
    private var initializingConfig = false

    func show(tab: Int = 0) {
        currentTab = tab
        ensureWindow()
        let html = buildHubHTML(tab: tab)
        if ProcessInfo.processInfo.environment["SAYLESS_DEBUG_HUB"] == "1" {
            try? html.write(toFile: "/tmp/hub-debug.html", atomically: true, encoding: .utf8)
        }
        web?.loadHTMLString(html, baseURL: URL(fileURLWithPath: saylessDataDir))
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func refresh() {
        show(tab: currentTab)
    }

    func cancelCaptureUI() {
        web?.evaluateJavaScript("window.stopCapture && window.stopCapture()")
    }

    /// 从 hub 直接开始听写时：收起面板并让出焦点，避免把文本粘回 hub。
    func dismissForRecording() {
        window?.orderOut(nil)
        NSApp.deactivate()
    }

    /// 无 GUI 的调试口子：把注入好数据的 hub HTML 写盘，供自动化检查。
    func dumpHTML(tab: Int, to path: String) -> Bool {
        let html = buildHubHTML(tab: tab)
        do {
            try html.write(toFile: path, atomically: true, encoding: .utf8)
            return true
        } catch {
            logLine("dump hub failed: \(error.localizedDescription)")
            return false
        }
    }

    private func ensureWindow() {
        if window != nil { return }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "Sayless"
        w.minSize = NSSize(width: 980, height: 620)
        w.center()
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = NSColor(red: 0x17 / 255.0, green: 0x16 / 255.0, blue: 0x16 / 255.0, alpha: 1)
        w.isReleasedWhenClosed = false
        w.titlebarAppearsTransparent = true
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "dict")
        let wv = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: cfg)
        wv.autoresizingMask = [.width, .height]
        wv.setValue(false, forKey: "drawsBackground")
        w.contentView = wv
        window = w
        web = wv
    }

    private func buildHubHTML(tab: Int) -> String {
        guard let tplPath = Bundle.main.path(forResource: "hub", ofType: "html"),
              let tpl = try? String(contentsOfFile: tplPath, encoding: .utf8) else {
            logLine("hub.html missing in bundle")
            return "<meta charset='utf-8'><body style='background:#171616;color:#bbb;font-family:-apple-system;padding:40px'>hub.html missing in bundle. 重新运行 app/build.sh 后重试。</body>"
        }
        return tpl.replacingOccurrences(of: "__DATAJSON__", with: jsonForHTML(buildHubData(tab: tab)))
    }

    private func buildHubData(tab: Int) -> [String: Any] {
        let cfg = jsonObject(at: saylessConfigFile) ?? [:]
        let dictRaw = jsonObject(at: saylessDictFile) ?? [:]
        let raw = readHistoryObjects()
        let parsed: [(obj: [String: Any], ts: String, date: Date?, day: String)] = raw.map { o in
            let ts = (o["ts"] as? String) ?? ""
            let date = parseISODate(ts)
            let day = date.map(localDayString) ?? String(ts.prefix(10))
            return (o, ts, date, day)
        }
        let sorted = parsed.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }

        var days = Set<String>()
        var modes: [String: Int] = [:]
        var apps: [String: Int] = [:]
        var chars = 0
        var rawChars = 0
        var first: Date?
        var last: Date?
        for p in sorted {
            let o = p.obj
            let out = (o["out"] as? String) ?? ""
            let rawText = (o["raw"] as? String) ?? ""
            chars += (o["chars"] as? Int) ?? out.count
            rawChars += (o["rawChars"] as? Int) ?? rawText.count
            if !p.day.isEmpty { days.insert(p.day) }
            let mode = (o["mode"] as? String) ?? "-"
            modes[mode, default: 0] += 1
            if let app = o["app"] as? String, !app.isEmpty { apps[app, default: 0] += 1 }
            if let d = p.date {
                first = first.map { min($0, d) } ?? d
                last = last.map { max($0, d) } ?? d
            }
        }
        let streaks = computeStreaks(days)
        let recStats = recordingStats()
        var stats: [String: Any] = [
            "entries": sorted.count,
            "chars": chars,
            "rawChars": rawChars,
            "avgChars": sorted.isEmpty ? 0 : ((Double(chars) / Double(sorted.count)) * 10).rounded() / 10,
            "activeDays": days.count,
            "streak": streaks.streak,
            "longestStreak": streaks.longest,
            "today": localDayString(Date()),
            "modes": modes,
            "apps": apps,
            "recordings": recStats.count,
            "recordingsBytes": recStats.bytes
        ]
        if let f = first { stats["first"] = ISO8601DateFormatter().string(from: f) }
        if let l = last { stats["last"] = ISO8601DateFormatter().string(from: l) }

        let hist: [[String: Any]] = sorted.prefix(1000).map { p in
            let o = p.obj
            var e: [String: Any] = [
                "ts": p.ts,
                "day": p.day,
                "mode": (o["mode"] as? String) ?? "-",
                "out": (o["out"] as? String) ?? "",
                "inserted": (o["inserted"] as? Bool) ?? false
            ]
            if let rawText = o["raw"] as? String, !rawText.isEmpty { e["raw"] = String(rawText.prefix(500)) }
            if let app = o["app"] as? String, !app.isEmpty { e["app"] = app }
            if let rec = o["rec"] as? String, !rec.isEmpty { e["rec"] = (rec as NSString).lastPathComponent }
            if let timings = o["timings"] as? [String: Any] { e["timings"] = timings }
            return e
        }

        let providerMap = (cfg["providers"] as? [String: Any]) ?? [:]
        var providerKeys: [String: Bool] = [:]
        for (id, p) in providerMap {
            if let d = p as? [String: Any], let key = d["apiKey"] as? String, !key.isEmpty {
                providerKeys[id] = true
            }
        }

        let asr = (cfg["asr"] as? [String: Any]) ?? [:]
        let whisperBin = (asr["whisperBin"] as? String) ?? ""
        let whisperModel = expandTilde((asr["whisperModel"] as? String) ?? "")
        let whisperBinExists = whisperBin.isEmpty ? (whichTool("whisper-cli") != nil) : FileManager.default.isExecutableFile(atPath: expandTilde(whisperBin))
        let whisperModelExists = !whisperModel.isEmpty && FileManager.default.fileExists(atPath: whisperModel)
        let pluginNames: [String] = {
            guard let files = try? FileManager.default.contentsOfDirectory(atPath: saylessDataDir + "/plugins") else { return [] }
            return files.filter { $0.hasSuffix(".mjs") }.sorted()
        }()

        let dict: [String: Any] = [
            "replacements": dictRaw["replacements"] as? [[String: Any]] ?? [],
            "hotwords": dictRaw["hotwords"] as? [String] ?? [],
            "styleRules": dictRaw["styleRules"] as? [String] ?? [],
            "apps": dictRaw["apps"] as? [String: Any] ?? [:]
        ]

        let env: [String: Any] = [
            "node": cachedNodeVersion,
            "whisperBinExists": whisperBinExists,
            "whisperModelExists": whisperModelExists,
            "ffmpegExists": whichTool("ffmpeg") != nil,
            "configMode": configFileMode() ?? "—",
            "configExists": FileManager.default.fileExists(atPath: saylessConfigFile),
            "dictExists": FileManager.default.fileExists(atPath: saylessDictFile),
            "plugins": pluginNames
        ]

        return [
            "version": appVersion,
            "dataDir": saylessDataDir,
            "initialTab": tab,
            "stats": stats,
            "days": days.sorted(),
            "history": hist,
            "dict": dict,
            "cfg": sanitizedConfig(cfg),
            "providers": providerMap.keys.sorted(),
            "providerKeys": providerKeys,
            "env": env
        ]
    }

    private func computeStreaks(_ days: Set<String>) -> (streak: Int, longest: Int) {
        let sorted = days.sorted()
        var longest = 0
        var run = 0
        var prev: Date?
        for day in sorted {
            guard let date = dayStart(day) else { continue }
            if let p = prev,
               let next = Calendar.current.date(byAdding: .day, value: 1, to: p),
               Calendar.current.isDate(date, inSameDayAs: next) {
                run += 1
            } else {
                run = 1
            }
            longest = max(longest, run)
            prev = date
        }
        let cal = Calendar.current
        var probe = cal.startOfDay(for: Date())
        if !days.contains(localDayString(probe)) {
            probe = cal.date(byAdding: .day, value: -1, to: probe) ?? probe
        }
        var streak = 0
        while days.contains(localDayString(probe)) {
            streak += 1
            guard let next = cal.date(byAdding: .day, value: -1, to: probe) else { break }
            probe = next
        }
        return (streak, longest)
    }

    private func recordingStats() -> (count: Int, bytes: Int64) {
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: saylessRecordingsDir) else { return (0, 0) }
        var count = 0
        var bytes: Int64 = 0
        for f in files where f.hasSuffix(".wav") {
            count += 1
            let path = saylessRecordingsDir + "/" + f
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let n = attrs[.size] as? NSNumber {
                bytes += n.int64Value
            }
        }
        return (count, bytes)
    }

    private func writableJSON(_ path: String) -> [String: Any]? {
        // 文件不存在 → 空对象（可创建）；存在但解析失败 → nil（绝不覆盖损坏文件）
        if !FileManager.default.fileExists(atPath: path) { return [:] }
        return jsonObject(at: path)
    }

    private func mutateDict(_ body: (inout [String: Any]) -> Bool) -> Bool {
        var d: [String: Any]
        if FileManager.default.fileExists(atPath: saylessDictFile) {
            guard let existing = jsonObject(at: saylessDictFile) else {
                logLine("dictionary.json 解析失败，拒绝覆盖")
                return false
            }
            d = existing
        } else {
            d = [
                "replacements": [[String: Any]](),
                "hotwords": [String](),
                "styleRules": [String](),
                "apps": [String: Any]()
            ]
        }
        if !body(&d) { return false }
        return writeJSONObject(d, to: saylessDictFile)
    }

    private func writeHistoryLines(_ lines: [String]) -> Bool {
        let text = lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
        return writeData(Data(text.utf8), to: saylessHistoryFile)
    }

    private func deleteHistory(ts: String) -> Int {
        guard !ts.isEmpty else { return 0 }
        guard let raw = try? String(contentsOfFile: saylessHistoryFile, encoding: .utf8) else { return 0 }
        var kept: [String] = []
        var removed = 0
        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            if let data = line.data(using: .utf8),
               let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               (obj["ts"] as? String) == ts {
                removed += 1
                continue
            }
            kept.append(String(line))
        }
        if removed > 0 { _ = writeHistoryLines(kept) }
        return removed
    }

    /// 首次使用：在 App 内运行内置 CLI 的 init，生成 config.json / dictionary.json
    private func runInitConfig() {
        guard !initializingConfig else { return }
        guard let cli = saylessCLIPath() else {
            web?.evaluateJavaScript("window.initConfigDone && window.initConfigDone(false, '找不到 sayless CLI')")
            return
        }
        guard let node = whichTool("node") else {
            web?.evaluateJavaScript("window.initConfigDone && window.initConfigDone(false, '找不到 Node.js，请先安装 Node 18+')")
            return
        }
        initializingConfig = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let r = runProcess(node, [cli, "init"], env: ["SAYLESS_DIR": saylessDataDir])
            let text = [r.stdout, r.stderr].filter { !$0.isEmpty }.joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                guard let self else { return }
                self.initializingConfig = false
                let ok = r.code == 0
                let msg = text.isEmpty ? (ok ? "配置已生成" : "初始化失败") : text
                self.web?.evaluateJavaScript("window.initConfigDone && window.initConfigDone(\(ok ? "true" : "false"), \(jsStringLiteral(msg)))")
                if ok {
                    // 让页面先显示成功提示，再重载为初始化后的配置
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { self.refresh() }
                }
            }
        }
    }

    private func runDoctor() {
        guard let cli = saylessCLIPath() else {
            doctorDone("找不到 sayless CLI。\n\n请先安装：\n  ln -sf \"$PWD/sayless.mjs\" /opt/homebrew/bin/sayless\n或在环境变量 SAYLESS_CLI 指定路径。")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var result: (stdout: String, stderr: String, code: Int32)
            if let node = whichTool("node") {
                result = runProcess(node, [cli, "doctor"], env: ["SAYLESS_DIR": saylessDataDir])
            } else if FileManager.default.isExecutableFile(atPath: cli) {
                result = runProcess(cli, ["doctor"], env: ["SAYLESS_DIR": saylessDataDir])
            } else {
                result = ("", "找不到 node", -1)
            }
            var text = result.stdout
            if !result.stderr.isEmpty {
                text += (text.isEmpty ? "" : "\n") + result.stderr
            }
            if result.code != 0 {
                text += "\n(exit \(result.code))"
            }
            let final = text.trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                self?.doctorDone(final.isEmpty ? "（体检无输出）" : final)
            }
        }
    }

    private func doctorDone(_ text: String) {
        logLine("doctor done len=\(text.count)")
        web?.evaluateJavaScript("window.doctorDone && window.doctorDone(\(jsStringLiteral(text)))")
    }

    private func triggerDictate() {
        dismissForRecording()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            (NSApp.delegate as? AppDelegate)?.toggle()
        }
    }
}

extension HubWindow: WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "dict",
              let body = message.body as? String,
              let data = body.data(using: .utf8),
              let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let action = j["action"] as? String else { return }

        var dictChanged = false

        switch action {
        case "setTab":
            currentTab = intValue(j["index"]) ?? currentTab

        case "setCaptureMode":
            let enabled = (j["enabled"] as? Bool) ?? false
            (NSApp.delegate as? AppDelegate)?.setCaptureMode(enabled)

        case "saveCfg":
            guard let incoming = j["config"] as? [String: Any] else { break }
            guard var cfg = writableJSON(saylessConfigFile) else {
                web?.evaluateJavaScript("window.hubActionDone && window.hubActionDone('config.json 已损坏，未写入。请先修复或备份该文件')")
                break
            }
            deepMergeConfig(&cfg, incoming)
            if writeJSONObject(cfg, to: saylessConfigFile) {
                logLine("cfg saved from hub")
                (NSApp.delegate as? AppDelegate)?.loadAppConfig()
                web?.evaluateJavaScript("window.settingsSaved && window.settingsSaved()")
            } else {
                web?.evaluateJavaScript("window.hubActionDone && window.hubActionDone('保存失败：检查 config.json 权限')")
            }

        case "setKey":
            let prov = stringValue(j["provider"])
            let key = stringValue(j["key"])
            if !prov.isEmpty && !key.isEmpty {
                guard var cfg = writableJSON(saylessConfigFile) else {
                    web?.evaluateJavaScript("window.hubActionDone && window.hubActionDone('config.json 已损坏，未写入 Key')")
                    break
                }
                var providers = (cfg["providers"] as? [String: Any]) ?? [:]
                var entry = (providers[prov] as? [String: Any]) ?? [:]
                entry["apiKey"] = key
                providers[prov] = entry
                cfg["providers"] = providers
                if writeJSONObject(cfg, to: saylessConfigFile) {
                    logLine("apiKey written for \(prov)")
                    web?.evaluateJavaScript("window.keySaved && window.keySaved()")
                } else {
                    web?.evaluateJavaScript("window.hubActionDone && window.hubActionDone('Key 写入失败')")
                }
            }

        case "addReplace":
            let from = stringValue(j["from"]).trimmingCharacters(in: .whitespacesAndNewlines)
            let to = stringValue(j["to"])
            if !from.isEmpty {
                dictChanged = mutateDict { d in
                    var reps = (d["replacements"] as? [[String: Any]]) ?? []
                    reps.removeAll { ($0["from"] as? String) == from }
                    reps.append(["from": from, "to": to])
                    d["replacements"] = reps
                    return true
                }
            }

        case "delReplaceIdx":
            let idx = intValue(j["index"]) ?? -1
            dictChanged = mutateDict { d in
                var reps = (d["replacements"] as? [[String: Any]]) ?? []
                guard idx >= 0 && idx < reps.count else { return false }
                reps.remove(at: idx)
                d["replacements"] = reps
                return true
            }

        case "addHot":
            let word = stringValue(j["word"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !word.isEmpty {
                dictChanged = mutateDict { d in
                    var hot = (d["hotwords"] as? [String]) ?? []
                    guard !hot.contains(word) else { return false }
                    hot.append(word)
                    d["hotwords"] = hot
                    return true
                }
            }

        case "delHot":
            let word = stringValue(j["word"])
            dictChanged = mutateDict { d in
                var hot = (d["hotwords"] as? [String]) ?? []
                let before = hot.count
                hot.removeAll { $0 == word }
                guard hot.count != before else { return false }
                d["hotwords"] = hot
                return true
            }

        case "addRule":
            let rule = stringValue(j["rule"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !rule.isEmpty {
                dictChanged = mutateDict { d in
                    var rules = (d["styleRules"] as? [String]) ?? []
                    guard !rules.contains(rule) else { return false }
                    rules.append(rule)
                    d["styleRules"] = rules
                    return true
                }
            }

        case "delRuleIdx":
            let idx = intValue(j["index"]) ?? -1
            dictChanged = mutateDict { d in
                var rules = (d["styleRules"] as? [String]) ?? []
                guard idx >= 0 && idx < rules.count else { return false }
                rules.remove(at: idx)
                d["styleRules"] = rules
                return true
            }

        case "addApp":
            let app = stringValue(j["app"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !app.isEmpty {
                dictChanged = mutateDict { d in
                    var apps = (d["apps"] as? [String: Any]) ?? [:]
                    guard apps[app] == nil else { return false }
                    apps[app] = ["hotwords": [String](), "replacements": [[String: Any]]()]
                    d["apps"] = apps
                    return true
                }
            }

        case "delApp":
            let app = stringValue(j["app"])
            dictChanged = mutateDict { d in
                var apps = (d["apps"] as? [String: Any]) ?? [:]
                guard apps[app] != nil else { return false }
                apps.removeValue(forKey: app)
                d["apps"] = apps
                return true
            }

        case "addAppHot", "delAppHot":
            let app = stringValue(j["app"])
            let word = stringValue(j["word"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if !app.isEmpty && !word.isEmpty {
                dictChanged = mutateDict { d in
                    var apps = (d["apps"] as? [String: Any]) ?? [:]
                    var layer = (apps[app] as? [String: Any]) ?? [:]
                    var hot = (layer["hotwords"] as? [String]) ?? []
                    if action == "addAppHot" {
                        guard !hot.contains(word) else { return false }
                        hot.append(word)
                    } else {
                        let before = hot.count
                        hot.removeAll { $0 == word }
                        guard hot.count != before else { return false }
                    }
                    layer["hotwords"] = hot
                    apps[app] = layer
                    d["apps"] = apps
                    return true
                }
            }

        case "addAppReplace":
            let app = stringValue(j["app"])
            let from = stringValue(j["from"]).trimmingCharacters(in: .whitespacesAndNewlines)
            let to = stringValue(j["to"])
            if !app.isEmpty && !from.isEmpty {
                dictChanged = mutateDict { d in
                    var apps = (d["apps"] as? [String: Any]) ?? [:]
                    var layer = (apps[app] as? [String: Any]) ?? [:]
                    var reps = (layer["replacements"] as? [[String: Any]]) ?? []
                    reps.removeAll { ($0["from"] as? String) == from }
                    reps.append(["from": from, "to": to])
                    layer["replacements"] = reps
                    apps[app] = layer
                    d["apps"] = apps
                    return true
                }
            }

        case "delAppReplaceIdx":
            let app = stringValue(j["app"])
            let idx = intValue(j["index"]) ?? -1
            if !app.isEmpty {
                dictChanged = mutateDict { d in
                    var apps = (d["apps"] as? [String: Any]) ?? [:]
                    var layer = (apps[app] as? [String: Any]) ?? [:]
                    var reps = (layer["replacements"] as? [[String: Any]]) ?? []
                    guard idx >= 0 && idx < reps.count else { return false }
                    reps.remove(at: idx)
                    layer["replacements"] = reps
                    apps[app] = layer
                    d["apps"] = apps
                    return true
                }
            }

        case "copyText":
            let text = stringValue(j["text"])
            if !text.isEmpty {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }

        case "playAudio", "retranscribe":
            let name = stringValue(j["file"])
            guard let url = resolveRecordingURL(name) else { break }
            if action == "playAudio" {
                (NSApp.delegate as? AppDelegate)?.playArchived(url.path)
            } else {
                (NSApp.delegate as? AppDelegate)?.retranscribeArchived(url.path)
            }

        case "delHistory":
            let ts = stringValue(j["ts"])
            let removed = deleteHistory(ts: ts)
            logLine("history delete ts=\(ts) removed=\(removed)")
            if removed > 0 { refresh() }

        case "clearHistory":
            _ = writeHistoryLines([])
            logLine("history cleared")
            refresh()

        case "runDoctor":
            runDoctor()

        case "initConfig":
            runInitConfig()

        case "openDataDir":
            try? FileManager.default.createDirectory(atPath: saylessDataDir, withIntermediateDirectories: true)
            NSWorkspace.shared.open(URL(fileURLWithPath: saylessDataDir))

        case "triggerDictate":
            triggerDictate()

        default:
            break
        }

        if dictChanged { refresh() }
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
    var recordingActive = false  // 正在录音（busy 还包括处理阶段）
    var processingActive = false // 子进程正在转写/润色
    var activeTranscribe: Process?
    var insertMode = "paste"     // paste | none（App 自己粘贴时的行为）
    var restoreClipboard = true
    var savedClipboard: String?
    var targetApp = ""     // 按热键时的前台应用名，用于分应用词层
    // 键位注册表：slot -> (keyCode, 修饰键名)；改这里或 config 即改键
    var hotkeys: [String: (key: UInt32, mods: String)] = [
        "dictate": (49, "option"), "translate": (17, "option"), "ask": (12, "option")
    ]
    var hotkeyMap: [UInt32: [(mods: CGEventFlags, id: Int)]] = [:]
    var carbonHotkeyRefs: [EventHotKeyRef] = []
    var carbonHandlerInstalled = false
    var captureMode = false
    var captureResetWork: DispatchWorkItem?
    func refreshHotkeyMap() {
        hotkeyMap = [:]
        let ids = ["dictate": 0, "translate": 1, "ask": 2]
        var seen = Set<String>()
        for (slot, def) in hotkeys {
            guard let id = ids[slot] else { continue }
            if def.mods == "none" && !functionKeyCodes.contains(def.key) {
                logLine("refusing bare printable hotkey: \(slot) key=\(def.key)")
                continue
            }
            let mods = flagName(def.mods)
            let sig = "\(def.key):\(mods.rawValue)"
            if seen.contains(sig) {
                logLine("duplicate hotkey ignored: \(slot) key=\(def.key) mod=\(def.mods)")
                continue
            }
            seen.insert(sig)
            hotkeyMap[def.key, default: []].append((mods: mods, id: id))
        }
        for key in Array(hotkeyMap.keys) {
            hotkeyMap[key]?.sort { $0.id < $1.id }
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
    var wavPath: String { saylessDataDir + "/last-utterance.wav" }
    var childEnv: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["SAYLESS_DIR"] = saylessDataDir
        return env
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMainMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🎙"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "听写", action: #selector(toggle), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "听写并翻译", action: #selector(translateToggle), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "语音问答", action: #selector(askToggle), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "打开主面板…", action: #selector(showHub), keyEquivalent: ","))
        menu.addItem(NSMenuItem(title: "紧急停止录音", action: #selector(forceStop), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "请求辅助功能授权…", action: #selector(requestAX), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "登录时启动", action: #selector(toggleLoginItem), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "听写历史…", action: #selector(showHistoryTab), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "设置…", action: #selector(showSettingsTab), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开词语库…", action: #selector(openDict), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开数据目录…", action: #selector(openDataDir), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "查看日志…", action: #selector(openLog), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出 SaylessBar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        loadAppConfig()
        registerHotkeys()
        checkAX()
        logLine("launched v\(appVersion) ptt=\(ptt) insert=\(insertMode)")
        // 调试/自动化口子：SAYLESS_SHOW_HUB=<tab> 启动即开面板（0首页 1历史 2词典 3设置）
        if let hubArg = ProcessInfo.processInfo.environment["SAYLESS_SHOW_HUB"], let t = Int(hubArg) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.hub.show(tab: t) }
        }
    }

    /// 无菜单的 accessory App 里 Cmd+C/V/A 往往不生效；补一个最小 Edit 菜单，
    /// 让 hub 设置页的输入框、API Key 粘贴等正常走响应链。
    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(title: "SaylessBar", action: nil, keyEquivalent: "")
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 SaylessBar", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 SaylessBar", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 SaylessBar", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        main.addItem(editItem)
        let edit = NSMenu(title: "编辑")
        editItem.submenu = edit
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: Selector(("cut:")), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: Selector(("copy:")), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: Selector(("paste:")), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: Selector(("selectAll:")), keyEquivalent: "a")
        NSApp.mainMenu = main
    }

    func loadAppConfig() {
        // config 不存在/损坏时保留默认设置，但一定要用默认热键填充 map，
        // 否则 CGEventTap 启用后 Carbon 兜底被抑制，热键会整个失效。
        if let raw = try? String(contentsOfFile: saylessConfigFile, encoding: .utf8),
           let d = raw.data(using: .utf8),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            ptt = j["ptt"] as? Bool ?? false
            soundOn = j["sound"] as? Bool ?? true
            if let ins = j["insert"] as? [String: Any] {
                insertMode = ins["mode"] as? String ?? "paste"
                restoreClipboard = ins["restoreClipboard"] as? Bool ?? true
            }
            if let hk = j["hotkeys"] as? [String: [String: Any]] {
                for (slot, def) in hk {
                    if let k = intValue(def["key"]), k >= 0, k <= 127, let key = UInt32(exactly: k) {
                        hotkeys[slot] = (key: key, mods: (def["modifier"] as? String) ?? "option")
                    } else {
                        logLine("invalid hotkey for \(slot): \(String(describing: def["key"]))")
                    }
                }
            }
        }
        refreshHotkeyMap()
        if carbonHandlerInstalled && !captureMode { registerCarbonHotkeys() }
        logLine("hotkeyMap entries: \(hotkeyMap.count) -> \(hotkeyMap.keys.sorted())")
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

    /// 完整快照（文本/图片/文件等多 pasteboard item），粘贴后原样恢复
    func snapshotPasteboard() -> [[NSPasteboard.PasteboardType: Data]] {
        guard let items = NSPasteboard.general.pasteboardItems else { return [] }
        return items.map { item in
            var dict: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) { dict[type] = data }
            }
            return dict
        }
    }
    func restorePasteboard(_ snapshot: [[NSPasteboard.PasteboardType: Data]]) {
        let pb = NSPasteboard.general
        pb.clearContents()
        guard !snapshot.isEmpty else { return }
        let items = snapshot.map { dict -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in dict { item.setData(data, forType: type) }
            return item
        }
        pb.writeObjects(items)
    }

    /// 保存剪贴板（任意类型）→ 粘贴 → 1.6s 后恢复
    /// 返回是否真正完成了自动粘贴（失败时文本仍在剪贴板）
    @discardableResult
    func pasteText(_ text: String) -> Bool {
        let snapshot = restoreClipboard ? snapshotPasteboard() : []
        let pb = NSPasteboard.general
        pb.clearContents()
        guard pb.setString(text, forType: .string) else {
            notify("复制到剪贴板失败", "NSPasteboard.setString 返回 false")
            return false
        }
        let pasteChangeCount = pb.changeCount
        guard AXIsProcessTrusted() else {
            logLine("paste skipped: AX not trusted")
            notify("粘贴需要辅助功能授权", "文本已复制到剪贴板，可在系统设置→隐私与安全性→辅助功能 授权 SaylessBar")
            return false
        }
        let paste = runToolResult("/usr/bin/osascript", ["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
        guard paste.status == 0 else {
            logLine("paste failed status=\(paste.status) err=\(paste.err)")
            notify("自动粘贴失败", "文本已复制到剪贴板，请手动 ⌘V；若使用 System Events 请检查 隐私与安全性→自动化")
            return false
        }
        if restoreClipboard {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
                // 用户在这 1.6s 内又复制了别的东西时，不要用旧快照覆盖新内容
                guard NSPasteboard.general.changeCount == pasteChangeCount else {
                    logLine("clipboard changed, skip restore")
                    return
                }
                self?.restorePasteboard(snapshot)
            }
        }
        return true
    }
    func runToolResult(_ path: String, _ args: [String], input: String? = nil) -> (out: String, err: String, status: Int32) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.environment = childEnv
        if input != nil { p.standardInput = Pipe() }
        let outPipe = Pipe(); p.standardOutput = outPipe
        let errPipe = Pipe(); p.standardError = errPipe
        do { try p.run() } catch { logLine("run \(path) fail: \(error.localizedDescription)"); return ("", error.localizedDescription, -1) }
        if let input { (p.standardInput as? Pipe)?.fileHandleForWriting.write(input.data(using: .utf8)!); (p.standardInput as? Pipe)?.fileHandleForWriting.closeFile() }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let out = String(data: data, encoding: .utf8) ?? ""
        let err = String(data: errData, encoding: .utf8) ?? ""
        if p.terminationStatus != 0, !path.contains("pbpaste") {
            logLine("run \(path) exit=\(p.terminationStatus) err=\(err)")
        }
        return (out, err, p.terminationStatus)
    }
    func runTool(_ path: String, _ args: [String], input: String? = nil) -> String {
        runToolResult(path, args, input: input).out
    }

    func checkAX() {
        if AXIsProcessTrusted() {
            logLine("AX trusted")
            installCGEventTap()
            return
        }
        logLine("AX NOT trusted")
        installCGEventTap() // 未授权时创建失败，但保留重试入口
        let flag = saylessDataDir + "/.ax-prompted"
        try? FileManager.default.createDirectory(atPath: saylessDataDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: flag) {
            // 仅首次弹系统授权框，之后永不自动弹
            try? "".write(toFile: flag, atomically: true, encoding: .utf8)
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
        }
    }
    @objc func stopFromUI() {
        guard recordingActive else { return }
        stopAndTranscribe()
    }
    @objc func forceStop() {
        stopWork?.cancel()
        if recordingActive {
            recordingActive = false
            _ = recorder.stopWrite(to: URL(fileURLWithPath: wavPath))
        }
        if let p = activeTranscribe {
            activeTranscribe = nil
            p.terminate()
        }
        processingActive = false
        busy = false
        capsule.hide()
        logLine("force stopped")
    }

    static var captureSlot: String?
    static var lastFire = Date.distantPast
    static var tapActive = false // tap 启用后 Carbon 兜底退场，避免一次按键双派发
    func hotkey(_ id: Int, keyUp: Bool = false) {
        if captureMode { return } // 快捷键录制中，全局热键让位给 hub 页面
        if ptt { // 按住说话：按下开始，松开结束
            if keyUp {
                if recordingActive { stopAndTranscribe() }
            } else if !busy {
                pendingMode = id
                capsule.show(mode: id)
                startRecording()
                beep("Tink")
            }
            return
        }
        if keyUp { return } // toggle 模式只认按下，松开不算第二次
        let now = Date()
        guard now.timeIntervalSince(AppDelegate.lastFire) > 0.25 else { return }
        AppDelegate.lastFire = now
        if busy {
            if recordingActive {
                stopAndTranscribe()
                beep("Pop")
                logLine("hotkey stop recording")
            } else {
                // 处理中（转写/润色）不再重复 stop，也不会清掉 busy 导致并发录音
                beep("Basso")
                logLine("hotkey ignored while processing")
            }
            return
        }
        pendingMode = id
        capsule.show(mode: id)
        startRecording()
        beep("Tink")
        logLine("hotkey start id=\(id)")
    }
    func cancelRecording() {
        guard busy || recordingActive || activeTranscribe != nil else { return }
        stopWork?.cancel()
        if recordingActive {
            recordingActive = false
            _ = recorder.stopWrite(to: URL(fileURLWithPath: wavPath)) // 覆盖即丢弃
        }
        if let p = activeTranscribe {
            activeTranscribe = nil
            p.terminate()
            logLine("terminated in-flight transcribe")
        }
        processingActive = false
        busy = false
        capsule.hide()
        beep("Basso")
        logLine("cancelled")
    }

    var tapPort: CFMachPort?
    var tapSource: CFRunLoopSource?
    func installCGEventTap() {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
                   | (1 << CGEventType.tapDisabledByTimeout.rawValue)
                   | (1 << CGEventType.tapDisabledByUserInput.rawValue)
        let cb: CGEventTapCallBack = { _, type, event, _ in
            guard let app = NSApp.delegate as? AppDelegate else { return Unmanaged.passUnretained(event) }
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let port = app.tapPort { CGEvent.tapEnable(tap: port, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            // 长按产生的自动重复不参与热键状态机（否则会立刻把录音停掉）
            if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) != 0 {
                return Unmanaged.passUnretained(event)
            }
            let code = event.getIntegerValueField(.keyboardEventKeycode)
            let isUp = type == .keyUp
            if code == 53 { // Esc 取消录音/处理（busy 的读取放到主线程）
                DispatchQueue.main.async { if app.busy { app.cancelRecording() } }
                return Unmanaged.passUnretained(event)
            }
            if let bindings = app.hotkeyMap[UInt32(code)] {
                let mods = event.flags
                let matched = bindings.first { $0.mods.isEmpty ? mods.isEmpty : mods.isSuperset(of: $0.mods) }
                if isUp {
                    // PTT 常见操作是先松开 Option 再松开 Space；keyUp 不能再要求修饰键仍按住
                    if let h = matched ?? bindings.first {
                        DispatchQueue.main.async { app.hotkey(h.id, keyUp: true) }
                    }
                } else if let h = matched {
                    DispatchQueue.main.async { app.hotkey(h.id) }
                }
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
        AppDelegate.tapActive = true
        CGEvent.tapEnable(tap: port, enable: true)
        tapSource = CFMachPortCreateRunLoopSource(nil, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .defaultMode)
        logLine("CGEventTap 已启用（热键走 tap，先于输入法拦截）")
    }

    func installCarbonHandler() {
        guard !carbonHandlerInstalled else { return }
        carbonHandlerInstalled = true
        let box = Unmanaged.passRetained(HotkeyBox(id: -1) { [weak self] id, isUp in self?.hotkey(id, keyUp: isUp) }).toOpaque()
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))
        ]
        _ = specs.withUnsafeBufferPointer { buf in
            InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
                var hkID = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
                let hb = Unmanaged<HotkeyBox>.fromOpaque(userData!.assumingMemoryBound(to: HotkeyBox.self)).takeUnretainedValue()
                guard !AppDelegate.tapActive else { return noErr } // tap 已接管，Carbon 不再派发
                let isUp = GetEventKind(event) == UInt32(kEventHotKeyReleased)
                logLine("hotkey event id=\(hkID.id) up=\(isUp)")
                hb.dispatch(Int(hkID.id), keyUp: isUp)
                return noErr
            }, buf.count, buf.baseAddress, box, &handlerRef)
        }
    }

    func unregisterCarbonHotkeys() {
        for ref in carbonHotkeyRefs { _ = UnregisterEventHotKey(ref) }
        carbonHotkeyRefs.removeAll()
    }

    func registerCarbonHotkeys() {
        unregisterCarbonHotkeys()
        let idByCode = ["dictate": 0, "translate": 1, "ask": 2]
        let carbonMods: [String: Int] = ["option": optionKey, "command": cmdKey, "control": controlKey, "shift": shiftKey, "none": 0]
        var seen = Set<String>()
        for (slot, def) in hotkeys {
            guard let id = idByCode[slot] else { continue }
            if def.mods == "none" && !functionKeyCodes.contains(def.key) {
                logLine("refusing bare printable hotkey: \(slot)")
                continue
            }
            let mod = UInt32(carbonMods[def.mods] ?? optionKey)
            let sig = "\(def.key):\(mod)"
            if seen.contains(sig) {
                logLine("duplicate hotkey ignored: \(slot)")
                continue
            }
            seen.insert(sig)
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(def.key, mod, EventHotKeyID(signature: fourCC("sayl"), id: UInt32(id)), GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref = ref {
                carbonHotkeyRefs.append(ref)
            } else {
                logLine("RegisterEventHotKey failed slot=\(slot) status=\(status)")
            }
        }
    }

    func registerHotkeys() {
        installCarbonHandler()
        registerCarbonHotkeys()
        Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] t in
            guard let self, self.tapPort == nil else { t.invalidate(); return }
            if AXIsProcessTrusted() { logLine("AX trusted（授权翻转）"); self.installCGEventTap(); t.invalidate() }
        }
    }

    func setCaptureMode(_ enabled: Bool) {
        captureMode = enabled
        captureResetWork?.cancel()
        if enabled {
            unregisterCarbonHotkeys()
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.captureMode else { return }
                self.captureMode = false
                self.registerCarbonHotkeys()
                self.hub.cancelCaptureUI()
                logLine("capture mode timeout, hotkeys restored")
            }
            captureResetWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
        } else {
            registerCarbonHotkeys()
        }
    }

    @objc func toggle() { hotkey(0) }
    @objc func translateToggle() { hotkey(1) }
    @objc func askToggle() { hotkey(2) }
    @objc func transcribeOnly() { if !busy { transcribe(insert: false, mode: 0) } }
    /// 回放归档录音（仅接受 ~/.sayless/recordings/ 下的 wav，防路径逃逸）
    func playArchived(_ file: String) {
        guard let url = resolveRecordingURL(file) else { return }
        DispatchQueue.global().async { [weak self] in _ = self?.runTool("/usr/bin/afplay", [url.path]) }
        logLine("playAudio \(url.lastPathComponent)")
    }
    /// 对归档录音重转写（↻）：结果照常润色并粘贴
    func retranscribeArchived(_ file: String) {
        guard let url = resolveRecordingURL(file), !busy else { return }
        logLine("retranscribe \(url.lastPathComponent)")
        // hub 是 key window；先收起并让出焦点，否则结果会粘贴回 hub
        hub.dismissForRecording()
        targetApp = ""
        transcribe(insert: true, force: true, wav: url.path)
    }
    @objc func toggleLoginItem() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            logLine("login item: \(error.localizedDescription)")
            notify("登录项切换失败", error.localizedDescription)
        }
    }
    @objc func openDataDir() {
        try? FileManager.default.createDirectory(atPath: saylessDataDir, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: saylessDataDir)
        NSWorkspace.shared.open(URL(fileURLWithPath: saylessDataDir))
    }
    @objc func showHub() { hub.show(tab: 0) }
    @objc func requestAX() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
    }
    @objc func showHistoryTab() { hub.show(tab: 1) }
    @objc func showSettingsTab() { hub.show(tab: 3) }
    @objc func openDict() { NSWorkspace.shared.open(URL(fileURLWithPath: saylessDictFile)) }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath)) }



    func startRecording() {
        busy = true
        recordingActive = true
        processingActive = false
        let front = NSWorkspace.shared.frontmostApplication
        if front?.bundleIdentifier == Bundle.main.bundleIdentifier {
            hub.dismissForRecording()
            targetApp = ""
        } else {
            targetApp = front?.localizedName ?? ""
        }
        if !recorder.start(onLevel: { [weak self] lvl in self?.capsule.setLevel(lvl) }) {
            busy = false
            recordingActive = false
            stopWork?.cancel()
            capsule.setResult(text: "麦克风启动失败：请检查麦克风权限/输入设备", ok: false, inserted: false)
            beep("Basso")
            notify("麦克风启动失败", "请检查 系统设置→隐私与安全性→麦克风，以及是否有可用输入设备")
            logLine("recording start failed (mic)")
            return
        }
        logLine("recording start mode=\(pendingMode)")
        stopWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self, self.busy else { return }
            logLine("max duration reached, auto stop")
            self.stopAndTranscribe()
        }
        stopWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: w)
    }

    func stopAndTranscribe() {
        guard recordingActive else { return }
        recordingActive = false
        capsule.setProcessing()
        stopWork?.cancel()
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let (pk, ok, reason) = self.recorder.stopWrite(to: URL(fileURLWithPath: self.wavPath))
            DispatchQueue.main.async {
                guard self.busy, !self.recordingActive else { return } // 已取消 / 已强制停止 / 已开始新录音
                if !ok {
                    self.busy = false
                    let msg = reason == "write" ? "录音写入失败（请检查磁盘空间/权限）" : "录音太短（<0.1s）"
                    self.capsule.setResult(text: msg, ok: false, inserted: false)
                    logLine("record failed reason=\(reason ?? "unknown") peak=\(pk)")
                    return
                }
                if pk < 0.05 {
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

    /// CLI 以 --no-insert 运行（App 自己负责粘贴），历史先记 false；
    /// 粘贴成功后按 RESULT_JSON 的 ts 精确更新对应条目，避免误改别的记录。
    func markHistoryInserted(ts: String) {
        guard !ts.isEmpty, let raw = try? String(contentsOfFile: saylessHistoryFile, encoding: .utf8) else { return }
        var lines = raw.components(separatedBy: "\n")
        var changed = false
        for i in lines.indices {
            guard let data = lines[i].data(using: .utf8),
                  var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  (obj["ts"] as? String) == ts else { continue }
            obj["inserted"] = true
            guard let newData = try? JSONSerialization.data(withJSONObject: obj),
                  let newLine = String(data: newData, encoding: .utf8) else { return }
            lines[i] = newLine
            changed = true
            break
        }
        guard changed else {
            logLine("history entry not found for inserted mark ts=\(ts)")
            return
        }
        if writeData(Data(lines.joined(separator: "\n").utf8), to: saylessHistoryFile) {
            logLine("history marked inserted ts=\(ts)")
        }
    }

    func transcribe(insert: Bool, mode: Int? = nil, force: Bool = false, wav: String? = nil) {
        guard activeTranscribe == nil else { logLine("transcribe ignored: already running"); return }
        let m = mode ?? pendingMode
        pendingMode = 0
        busy = true
        recordingActive = false
        processingActive = true
        capsule.setProcessing()
        guard let cli = saylessCLIPath() else {
            busy = false
            processingActive = false
            capsule.hide()
            notify("找不到 sayless CLI", "请先安装：ln -sf \"$PWD/sayless.mjs\" /opt/homebrew/bin/sayless")
            return
        }
        guard let node = whichTool("node") else {
            busy = false
            processingActive = false
            capsule.hide()
            notify("找不到 Node.js", "sayless 需要 Node 18+：brew install node")
            return
        }
        var args = [cli, "transcribe", wav ?? wavPath, "--no-insert"]
        if m == 1 { args += ["--translate"] }
        if m == 2 { args += ["--ask"] }
        if !targetApp.isEmpty { args += ["--app", targetApp] }
        if force { args += ["--force"] }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = args
        p.environment = childEnv
        p.standardOutput = FileHandle.nullDevice
        activeTranscribe = p
        // stderr 落到本次运行独有的临时文件：避免长输出填满 pipe，也避免取消后新进程覆盖旧日志
        let errPath = saylessDataDir + "/last-transcribe-\(UUID().uuidString).log"
        try? FileManager.default.createDirectory(atPath: saylessDataDir, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: saylessDataDir)
        try? Data().write(to: URL(fileURLWithPath: errPath))
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: errPath)
        let errHandle = FileHandle(forWritingAtPath: errPath)
        p.standardError = errHandle ?? FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            let errText = (try? String(contentsOfFile: errPath, encoding: .utf8)) ?? ""
            try? errHandle?.close()
            try? FileManager.default.removeItem(atPath: errPath)
            DispatchQueue.main.async {
                guard let self else { return }
                // 已被取消或被新进程替换：不要粘贴/提示旧结果
                guard self.activeTranscribe === proc else { return }
                self.activeTranscribe = nil
                self.processingActive = false
                self.busy = false
                if proc.terminationStatus == 0 {
                    // 优先读 CLI 的机器可读结果，避免多行文本被逐行截断
                    var finalText = ""
                    var resultTs = ""
                    for line in errText.split(separator: "\n") {
                        guard line.hasPrefix("RESULT_JSON:") else { continue }
                        let payload = String(line.dropFirst("RESULT_JSON:".count))
                        if let d = payload.data(using: .utf8),
                           let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                           let out = o["out"] as? String {
                            finalText = out
                            resultTs = (o["ts"] as? String) ?? ""
                        }
                    }
                    if finalText.isEmpty {
                        finalText = errText.split(separator: "\n")
                            .first(where: { $0.hasPrefix("结果: ") })
                            .map { String($0.dropFirst("结果: ".count)) } ?? ""
                    }
                    if finalText.isEmpty {
                        self.capsule.setResult(text: "没有识别到文本", ok: false, inserted: false)
                        self.beep("Basso")
                        logLine("ok but empty text")
                        return
                    }
                    let shouldPaste = insert && self.insertMode != "none"
                    let pasted = shouldPaste ? self.pasteText(finalText) : false
                    if pasted { self.markHistoryInserted(ts: resultTs) }
                    let display = (shouldPaste && !pasted) ? "已复制到剪贴板（自动粘贴失败，请手动 ⌘V）" : finalText
                    self.capsule.setResult(text: display, ok: true, inserted: pasted)
                    self.beep("Pop")
                    logLine("ok mode=\(m) paste=\(pasted) text=\(finalText.prefix(80))")
                } else {
                    self.capsule.setResult(text: String(errText.suffix(160)), ok: false, inserted: false)
                    self.beep("Basso")
                    self.notify("听写失败（exit \(proc.terminationStatus)）", String(errText.suffix(160)))
                    logLine("failed: \(errText.suffix(160))")
                }
            }
        }
        do { try p.run() } catch {
            try? FileManager.default.removeItem(atPath: errPath)
            if activeTranscribe === p { activeTranscribe = nil }
            processingActive = false
            busy = false
            capsule.hide()
            notify("管线启动失败", error.localizedDescription)
        }
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

// 调试口子：SAYLESS_DUMP_HUB=/tmp/hub.html SAYLESS_DUMP_HUB_TAB=0
// 只写出注入数据后的 HTML 并退出，不创建菜单栏/窗口，便于 CI 或人工核对。
if let dump = ProcessInfo.processInfo.environment["SAYLESS_DUMP_HUB"], !dump.isEmpty {
    let tab = Int(ProcessInfo.processInfo.environment["SAYLESS_DUMP_HUB_TAB"] ?? "0") ?? 0
    let ok = HubWindow().dumpHTML(tab: tab, to: dump)
    FileHandle.standardError.write(Data((ok ? "hub written: \(dump)\n" : "hub dump failed\n").utf8))
    exit(ok ? 0 : 1)
}

app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
