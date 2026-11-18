// Team Chat.app: a window around the team chat. It starts the bundled server (Resources/team-chat-server)
// on 127.0.0.1:4747, shows it in a WKWebView, and stops it on quit.
import Cocoa
import UserNotifications
import WebKit

let port = 4747
let base = URL(string: "http://127.0.0.1:\(port)")!
let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Team Chat")

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate,
  WKScriptMessageHandler, UNUserNotificationCenterDelegate
{
  var window: NSWindow!
  var web: WKWebView!
  var server: Process?
  var titleObservation: NSKeyValueObservation?
  var quitting = false

  // MARK: Launch

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    buildWindow()
    showMessage("Starting the team…")
    UNUserNotificationCenter.current().delegate = self
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }

    DispatchQueue.global().async {
      // A team chat server that's already up (from the repo) is reused rather than started twice.
      if !self.serverAnswers() { self.startServer() }
      for _ in 0..<60 {
        if self.serverAnswers() {
          DispatchQueue.main.async { self.web.load(URLRequest(url: base)) }
          return
        }
        if let s = self.server, !s.isRunning { break }
        Thread.sleep(forTimeInterval: 0.5)
      }
      DispatchQueue.main.async {
        self.showMessage("The team chat server didn't start. Its log is in ~/Library/Logs/Team Chat/server.log.")
      }
    }
  }

  /// The PATH of your login shell, so jobs find git, bun, az and the rest like they do in Terminal.
  func loginPath() -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-ilc", "printf '%s' \"$PATH\""]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    try? p.run()
    let deadline = Date().addingTimeInterval(5)
    while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    if p.isRunning { p.terminate() }
    let path = String(data: out.fileHandleForReading.availableData, encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let fallback = "\(home)/.local/bin:\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return path.contains("/usr/bin") ? path : fallback
  }

  func startServer() {
    guard let exe = Bundle.main.url(forResource: "team-chat-server", withExtension: nil) else { return }
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
    let logURL = logDir.appendingPathComponent("server.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    let log = try? FileHandle(forWritingTo: logURL)

    var env = ProcessInfo.processInfo.environment
    env["PATH"] = loginPath()
    env["PORT"] = String(port)
    let p = Process()
    p.executableURL = exe
    p.environment = env
    p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    p.standardOutput = log
    p.standardError = log
    p.terminationHandler = { [weak self] proc in
      guard proc.terminationReason != .exit || proc.terminationStatus != 0 else { return }
      DispatchQueue.main.async { self?.serverStopped() }
    }
    do {
      try p.run()
      server = p
    } catch {
      DispatchQueue.main.async { self.showMessage("Couldn't start the server: \(error.localizedDescription)") }
    }
  }

  func serverStopped() {
    guard !quitting else { return }
    showMessage("The team chat server stopped. Its log is in ~/Library/Logs/Team Chat/server.log. Quit and reopen the app to start it again.")
  }

  func serverAnswers() -> Bool { state() != nil }

  /// GET /api/state, synchronously, with a short timeout.
  func state() -> [String: Any]? {
    var result: [String: Any]?
    let done = DispatchSemaphore(value: 0)
    var req = URLRequest(url: base.appendingPathComponent("api/state"))
    req.timeoutInterval = 2
    URLSession.shared.dataTask(with: req) { data, _, _ in
      if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { result = json }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 3)
    return result
  }

  // MARK: Window

  func buildWindow() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    // The page's notifications (a teammate @mentions you while the window is hidden) become macOS notifications.
    let polyfill = """
      window.Notification = class {
        static permission = "granted";
        static requestPermission() { return Promise.resolve("granted"); }
        constructor(title, opts) {
          const data = (opts && opts.data) || {};
          window.webkit.messageHandlers.notify.postMessage({ title: String(title), body: String((opts && opts.body) || ""), channel: String(data.channel || ""), urgent: !!data.urgent });
        }
        close() {}
      };
      window.__teamAppActive = true;
      """
    config.userContentController.addUserScript(
      WKUserScript(source: polyfill, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.userContentController.add(self, name: "notify")

    web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = self
    web.navigationDelegate = self
    web.allowsBackForwardNavigationGestures = false
    titleObservation = web.observe(\.title, options: [.new]) { [weak self] view, _ in
      self?.updateBadge(view.title ?? "")
    }

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "Team Chat"
    window.minSize = NSSize(width: 420, height: 480)
    window.contentView = web
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("TeamChatMain")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func showMessage(_ text: String) {
    let html = """
      <!doctype html><meta charset="utf-8"><style>
      body{margin:0;height:100vh;display:grid;place-items:center;font:15px -apple-system,system-ui;background:#1a1d21;color:#d1d2d3}
      @media (prefers-color-scheme: light){body{background:#fff;color:#1d1c1d}}
      div{max-width:420px;text-align:center;line-height:1.5}b{font-size:40px;display:block;margin-bottom:8px}</style>
      <div><b>💬</b>\(text)</div>
      """
    web.loadHTMLString(html, baseURL: nil)
  }

  /// "(3) Team" → a 3 on the Dock icon.
  func updateBadge(_ title: String) {
    let count = title.range(of: #"^\((\d+)\)"#, options: .regularExpression).map { String(title[$0].dropFirst().dropLast()) }
    NSApp.dockTile.badgeLabel = count
  }

  // Closing the window keeps the team running; the Dock icon brings it back.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    return false
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  // MARK: Quit

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard server != nil else { return .terminateNow }
    let busy = workingCount()
    if busy > 0 {
      let alert = NSAlert()
      alert.messageText = busy == 1 ? "A teammate is still working" : "\(busy) teammates or jobs are still working"
      alert.informativeText = "Quitting stops them. Their sessions stay in Claude Code, and you can ask them to carry on later."
      alert.addButton(withTitle: "Quit")
      alert.addButton(withTitle: "Cancel")
      if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
    }
    quitting = true
    return .terminateNow
  }

  func applicationWillTerminate(_ note: Notification) {
    guard let s = server, s.isRunning else { return }
    s.terminate()
    let deadline = Date().addingTimeInterval(3)
    while s.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
  }

  func workingCount() -> Int {
    guard let st = state() else { return 0 }
    let chats = (st["sessions"] as? [[String: Any]] ?? []).filter { $0["busyIn"] != nil }.count
    let jobs = (st["channels"] as? [[String: Any]] ?? []).reduce(0) { n, ch in
      n + (ch["jobs"] as? [[String: Any]] ?? []).filter { ($0["status"] as? String) == "running" }.count
    }
    return chats + jobs
  }

  // MARK: Web view

  /// ClickUp links go to Chrome (where you're signed in to ClickUp); other links to the default browser.
  func openExternal(_ url: URL) {
    let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome")
    if url.host == "app.clickup.com", let chrome {
      NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
    } else {
      NSWorkspace.shared.open(url)
    }
  }

  // Links to anything but the team chat open in a browser.
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if let url = action.request.url, action.navigationType == .linkActivated, url.host != base.host || url.port != port {
      openExternal(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url { openExternal(url) }
    return nil
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.runModal()
    completionHandler()
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "notify", let body = message.body as? [String: Any] else { return }
    let content = UNMutableNotificationContent()
    content.title = body["title"] as? String ?? "Team Chat"
    content.body = body["body"] as? String ?? ""
    content.sound = .default
    content.threadIdentifier = body["channel"] as? String ?? ""
    content.userInfo = ["channel": body["channel"] as? String ?? ""]
    // A question for you bounces the Dock icon once, like a mention in Slack.
    if body["urgent"] as? Bool == true && !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler done: @escaping () -> Void
  ) {
    let channel = response.notification.request.content.userInfo["channel"] as? String ?? ""
    DispatchQueue.main.async {
      self.window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      if channel.range(of: #"^[\w-]+$"#, options: .regularExpression) != nil {
        self.web.evaluateJavaScript("window.TeamApp && window.TeamApp.openChannel('\(channel)')")
      }
    }
    done()
  }

  // Shown even while Team Chat is in front: the page only asks when you're in another channel.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    done([.banner, .list, .sound])
  }

  // The page notifies only when you're not looking, so it needs to know when the app is in the background.
  func applicationDidBecomeActive(_ note: Notification) { web?.evaluateJavaScript("window.__teamAppActive = true") }
  func applicationDidResignActive(_ note: Notification) { web?.evaluateJavaScript("window.__teamAppActive = false") }

  // MARK: Menu

  @objc func reload() { web.load(URLRequest(url: base)) }
  @objc func openInBrowser() { NSWorkspace.shared.open(URL(string: "http://localhost:\(port)")!) }
  @objc func openLog() { NSWorkspace.shared.open(logDir.appendingPathComponent("server.log")) }
  @objc func closeWindow() { window.orderOut(nil) }
  /// The page checks (updates.ts) and says what it found.
  @objc func checkForUpdates() {
    window.makeKeyAndOrderFront(nil)
    web.evaluateJavaScript("window.teamChatCheckUpdates && window.teamChatCheckUpdates()")
  }

  func buildMenu() {
    let main = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let item = NSMenuItem()
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      item.submenu = menu
      main.addItem(item)
    }
    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    add("Team Chat", [
      item("About Team Chat", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      item("Check for Updates…", #selector(checkForUpdates)),
      .separator(),
      item("Hide Team Chat", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit Team Chat", #selector(NSApplication.terminate(_:)), "q"),
    ])
    add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    add("View", [
      item("Reload", #selector(reload), "r"),
      item("Open in Browser", #selector(openInBrowser), "o", [.command, .shift]),
      item("Show Server Log", #selector(openLog)),
    ])
    add("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      item("Close", #selector(closeWindow), "w"),
    ])
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
