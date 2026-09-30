import AppKit
import SwiftUI
import UserNotifications

/// Courtside for Mac: a menu bar app (no Dock icon) whose panel runs the same
/// UI as the Chrome extension, plus a floating always-on-top window and a
/// desktop widget (CourtsideWidget target).
@main
struct CourtsideApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var monitor = FavoritesMonitor.shared

    var body: some Scene {
        MenuBarExtra {
            WebViewContainer(webView: WebViews.shared.menuBar)
                .frame(width: 380, height: 580)
        } label: {
            // A live favorite's score, like the extension's toolbar badge.
            if monitor.liveText.isEmpty {
                Image(systemName: "sportscourt.fill")
            } else {
                Text(monitor.liveText)
            }
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        Task { @MainActor in FavoritesMonitor.shared.start() }
    }

    /// courtside:// links from the widget.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            Task { @MainActor in DeepLink.open(url) }
        }
    }

    // Show alerts even while Courtside's panel is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    // Clicking an alert opens that game.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        if let link = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: link) {
            await DeepLink.open(url)
        }
    }
}

/// courtside://game?league=nfl&id=401772001 opens that game;
/// courtside://league?id=nfl (or id=fav) opens a scoreboard; courtside://open
/// just shows the floating window. The web UI restores what it finds in its
/// saved UI state, so we write that state and reload the window.
@MainActor
enum DeepLink {
    static func open(_ url: URL) {
        guard url.scheme == "courtside" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }

        switch url.host {
        case "game":
            if let league = value("league"), League.find(league) != nil, let id = value("id") {
                SharedStore.mergeUIState(["view": "game", "gameId": id, "gameLeague": league, "league": league])
            }
        case "league":
            if let id = value("id"), id == "fav" || League.find(id) != nil {
                SharedStore.mergeUIState(["view": "scores", "league": id])
            }
        default:
            break
        }
        FloatingPanel.shared.showReloading()
    }
}
