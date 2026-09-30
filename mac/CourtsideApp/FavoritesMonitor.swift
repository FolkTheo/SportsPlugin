import Foundation
import UserNotifications
import WidgetKit

/// Watches favorite teams in the background: puts a live score in the menu
/// bar, sends score alerts, and asks the widget to refresh when scores change
/// (the Mac version of the extension's background worker).
@MainActor
final class FavoritesMonitor: ObservableObject {
    static let shared = FavoritesMonitor()

    /// e.g. "KC 24–20 BUF" while a favorite is playing, otherwise empty.
    @Published private(set) var liveText = ""

    private var loop: Task<Void, Never>?
    /// "league:gameId" -> "state|awayScore|homeScore" from the last poll.
    private var snapshot: [String: String] = [:]

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                let live = await self?.poll() ?? false
                // Every 30 seconds while a favorite is live, otherwise every 2 minutes.
                try? await Task.sleep(nanoseconds: (live ? 30 : 120) * 1_000_000_000)
            }
        }
    }

    func refreshNow() {
        Task { _ = await poll() }
    }

    @discardableResult
    private func poll() async -> Bool {
        let favorites = SharedStore.favorites
        guard !favorites.isEmpty else {
            liveText = ""
            snapshot = [:]
            return false
        }
        let games = await ScoresClient.favoriteGames(favorites)
        let live = games.filter { $0.state == .live }
        liveText = live.first.map { "\($0.away.abbr) \($0.away.score)–\($0.home.score) \($0.home.abbr)" } ?? ""

        var next: [String: String] = [:]
        for game in games {
            let key = "\(game.league):\(game.id)"
            let value = "\(game.state.rawValue)|\(game.away.score)|\(game.home.score)"
            next[key] = value
            // No alert on the first sighting; only for changes we observed.
            if let before = snapshot[key], before != value { await alert(game, before: before) }
        }
        if next != snapshot { WidgetCenter.shared.reloadAllTimelines() }
        snapshot = next
        return !live.isEmpty
    }

    private func alert(_ game: Game, before: String) async {
        guard SharedStore.notifyFavorites else { return }
        let wasState = before.split(separator: "|", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let line = "\(game.away.abbr) \(game.away.score) – \(game.home.abbr) \(game.home.score)"
        let title: String
        if wasState == "pre" && game.state == .live {
            title = "\(game.away.name) at \(game.home.name) has started"
        } else if game.state == .post && wasState != "post" {
            title = "Final: \(line)"
        } else if game.state == .live {
            title = "Score: \(line)"
        } else {
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = game.situation.isEmpty ? game.detail : "\(game.detail) · \(game.situation)"
        content.userInfo = ["url": game.deepLink.absoluteString]
        let request = UNNotificationRequest(identifier: "\(game.league):\(game.id):\(Date().timeIntervalSince1970)",
                                            content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
