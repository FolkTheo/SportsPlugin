import AppKit
import WebKit

/// "Float on desktop": the scores UI in a small panel that stays above other
/// windows, on every Space and over full-screen apps (the Mac equivalent of
/// the extension's overlay and keep-on-top window).
@MainActor
final class FloatingPanel {
    static let shared = FloatingPanel()

    private var panel: NSPanel?
    private var webView: WKWebView?

    func show() {
        if panel == nil { build() }
        panel?.orderFrontRegardless()
        panel?.makeKey()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Shows the panel after reloading it, so the UI picks up state written
    /// natively (e.g. the game a widget tap asked to open).
    func showReloading() {
        webView?.reload()
        show()
    }

    private func build() {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 660),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "Courtside"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 300, height: 260)
        panel.appearance = NSAppearance(named: .darkAqua)

        let webView = WebViews.shared.make(mode: "window")
        panel.contentView = webView
        // Remember where the user put it.
        if !panel.setFrameUsingName("CourtsideFloating") { panel.center() }
        panel.setFrameAutosaveName("CourtsideFloating")

        self.panel = panel
        self.webView = webView
    }
}
