import AppKit
import SwiftUI
import WebKit

/// Serves the bundled web UI at courtside-app://app/… from the app's
/// Resources, where the build copies the extension's src/ and icons/ folders.
/// A custom scheme (instead of file://) gives the page a real origin, which
/// ES modules and the refresh worker need.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "courtside-app"
    private let root = Bundle.main.resourceURL!.standardizedFileURL

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        let file = root.appendingPathComponent(url.path).standardizedFileURL
        // Only files inside Resources; never follow "../" out of the bundle.
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            task.didReceive(Data())
            task.didFinish()
            return
        }
        let headers = ["Content-Type": Self.mimeType(for: file.pathExtension), "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }
}

/// Creates the web views that run the shared UI, and relays storage changes
/// to all of them (the equivalent of chrome.storage.onChanged).
@MainActor
final class WebViews: NSObject, WKNavigationDelegate, WKUIDelegate {
    static let shared = WebViews()

    private let schemeHandler = BundleSchemeHandler()
    private let bridge = NativeBridge()
    private let views = NSHashTable<WKWebView>.weakObjects()
    private lazy var shim: String = {
        guard let url = Bundle.main.url(forResource: "native-shim", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            assertionFailure("native-shim.js missing from the app bundle")
            return ""
        }
        return source
    }()

    /// The menu bar panel's web view, kept alive between openings.
    lazy var menuBar: WKWebView = make(mode: "menubar")

    /// `mode` is the web UI's layout: "menubar" or "window" (the floating panel).
    func make(mode: String) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemeHandler, forURLScheme: BundleSchemeHandler.scheme)
        let content = config.userContentController
        content.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.addScriptMessageHandler(bridge, contentWorld: .page, name: "courtside")

        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 380, height: 580), configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = NSColor(red: 0.05, green: 0.07, blue: 0.09, alpha: 1)
        webView.load(URLRequest(url: URL(string: "\(BundleSchemeHandler.scheme)://app/src/app/app.html?mode=\(mode)")!))
        views.add(webView)
        return webView
    }

    /// Runs `js` in every open web view.
    func broadcast(_ js: String) {
        for view in views.allObjects {
            view.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // Links (e.g. "Open this game on DraftKings") open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

/// Hosts an existing web view in SwiftUI without recreating it.
struct WebViewContainer: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
