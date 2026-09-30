import AppIntents
import ImageIO
import SwiftUI
import WidgetKit

// Desktop / Notification Center widget. Widgets can't run the web UI, so this
// is native SwiftUI fed by the shared Swift ESPN client (Shared/Scores.swift)
// and the favorites the web UI saved in the App Group (Shared/SharedStore.swift).

@main
struct CourtsideWidgets: WidgetBundle {
    var body: some Widget {
        ScoresWidget()
    }
}

struct ScoresWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "CourtsideScores", intent: ScoresIntent.self, provider: ScoresProvider()) { entry in
            ScoresWidgetView(entry: entry)
        }
        .configurationDisplayName("Courtside Scores")
        .description("Live scores for your favorite teams or any league.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Configuration ("Edit Widget" menu)

enum ScoreSource: String, AppEnum {
    case favorites, nfl, nba, mlb, nhl, cfb, cbb

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Scores"
    static var caseDisplayRepresentations: [ScoreSource: DisplayRepresentation] = [
        .favorites: "My Favorites",
        .nfl: "NFL",
        .nba: "NBA",
        .mlb: "MLB",
        .nhl: "NHL",
        .cfb: "College Football",
        .cbb: "College Basketball",
    ]
}

struct ScoresIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Scores"
    static var description = IntentDescription("Choose your favorite teams or a league.")

    @Parameter(title: "Show", default: .favorites)
    var source: ScoreSource
}

// MARK: - Timeline

struct ScoresEntry: TimelineEntry {
    let date: Date
    let title: String
    let games: [Game]
    let logos: [URL: NSImage]
    /// Shown instead of games (no favorites yet, offline, off day).
    let message: String?
    /// Where tapping the header goes.
    let link: URL
}

struct ScoresProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ScoresEntry {
        ScoresEntry(date: .now, title: "Courtside", games: [], logos: [:], message: "Loading scores…",
                    link: URL(string: "courtside://open")!)
    }

    func snapshot(for configuration: ScoresIntent, in context: Context) async -> ScoresEntry {
        await load(configuration.source, family: context.family)
    }

    func timeline(for configuration: ScoresIntent, in context: Context) async -> Timeline<ScoresEntry> {
        let entry = await load(configuration.source, family: context.family)
        // macOS limits how often widgets refresh, so these are requests, not
        // guarantees. While the app runs it also triggers a reload whenever a
        // favorite's score changes (FavoritesMonitor).
        let live = entry.games.contains { $0.state == .live }
        let soon = entry.games.contains { $0.state == .pre && ($0.date ?? .distantFuture).timeIntervalSinceNow < 30 * 60 }
        let next = Date.now.addingTimeInterval(live ? 2 * 60 : soon ? 10 * 60 : 30 * 60)
        return Timeline(entries: [entry], policy: .after(next))
    }

    private func load(_ source: ScoreSource, family: WidgetFamily) async -> ScoresEntry {
        let limit = family == .systemSmall ? 1 : family == .systemMedium ? 3 : 7
        let title: String
        let link: URL
        var games: [Game] = []
        var message: String?

        if source == .favorites {
            title = "My Teams"
            link = URL(string: "courtside://league?id=fav")!
            let favorites = SharedStore.favorites
            if favorites.isEmpty {
                message = "Open Courtside and tap ★ on your teams."
            } else {
                games = await ScoresClient.favoriteGames(favorites)
                if games.isEmpty { message = "No upcoming games." }
            }
        } else {
            let league = League.find(source.rawValue)!
            title = league.label
            link = URL(string: "courtside://league?id=\(league.id)")!
            do {
                games = try await ScoresClient.scoreboard(league)
                if games.isEmpty { message = "No \(league.label) games today." }
            } catch {
                message = "Couldn't load scores."
            }
        }

        games = Array(games.prefix(limit))
        let logos = await Self.logos(for: games)
        return ScoresEntry(date: .now, title: title, games: games, logos: logos, message: message, link: link)
    }

    /// Widget views can't load images themselves, so logos are fetched here
    /// and shrunk to thumbnails (widgets have a tight memory limit).
    private static func logos(for games: [Game]) async -> [URL: NSImage] {
        let urls = Set(games.flatMap { [$0.away.logo, $0.home.logo] }.compactMap { $0 })
        return await withTaskGroup(of: (URL, NSImage?).self) { group in
            for url in urls {
                group.addTask {
                    guard let response = try? await ScoresClient.session.data(from: url) else { return (url, nil) }
                    return (url, Self.thumbnail(response.0, maxPixels: 64))
                }
            }
            var out: [URL: NSImage] = [:]
            for await (url, image) in group {
                if let image { out[url] = image }
            }
            return out
        }
    }

    private static func thumbnail(_ data: Data, maxPixels: Int) -> NSImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: maxPixels / 2, height: maxPixels / 2))
    }
}

// MARK: - Views

private let liveRed = Color(red: 1, green: 0.3, blue: 0.31)
private let background = Color(red: 0.05, green: 0.07, blue: 0.09)

struct ScoresWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ScoresEntry

    var body: some View {
        content
            .environment(\.colorScheme, .dark)
            .containerBackground(background, for: .widget)
            .widgetURL(family == .systemSmall ? (entry.games.first?.deepLink ?? entry.link) : entry.link)
    }

    @ViewBuilder private var content: some View {
        if let game = entry.games.first, family == .systemSmall {
            SmallGameView(game: game, logos: entry.logos)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(entry.title).font(.headline)
                    Spacer()
                    if entry.games.contains(where: { $0.state == .live }) {
                        Text("LIVE").font(.caption2.weight(.heavy)).foregroundStyle(liveRed)
                    }
                }
                if let message = entry.message, entry.games.isEmpty {
                    Spacer()
                    Text(message).font(.callout).foregroundStyle(.secondary)
                    Spacer()
                } else {
                    ForEach(entry.games) { game in
                        Link(destination: game.deepLink) {
                            GameRow(game: game, logos: entry.logos)
                        }
                        if game.id != entry.games.last?.id { Divider().opacity(0.4) }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }
}

private struct TeamLogo: View {
    let team: TeamLine
    let logos: [URL: NSImage]
    var size: CGFloat = 18

    var body: some View {
        if let url = team.logo, let image = logos[url] {
            Image(nsImage: image).resizable().scaledToFit().frame(width: size, height: size)
        } else {
            Circle().fill(.quaternary).frame(width: size, height: size)
                .overlay(Text(team.abbr.prefix(1)).font(.system(size: size * 0.45, weight: .bold)))
        }
    }
}

private struct TeamScoreLine: View {
    let team: TeamLine
    let game: Game
    let logos: [URL: NSImage]
    var logoSize: CGFloat = 18
    var scoreFont: Font = .body.weight(.bold)

    var body: some View {
        let dimmed = game.state == .post && !team.winner
        HStack(spacing: 6) {
            TeamLogo(team: team, logos: logos, size: logoSize)
            if let rank = team.rank {
                Text("\(rank)").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            }
            Text(team.abbr).font(.callout.weight(.semibold)).lineLimit(1)
            Spacer(minLength: 4)
            if game.state != .pre {
                Text(team.score).font(scoreFont).monospacedDigit()
            }
        }
        .foregroundStyle(dimmed ? Color.secondary : Color.primary)
    }
}

private struct StatusText: View {
    let game: Game

    var body: some View {
        Text(game.statusText)
            .font(.caption.weight(.semibold))
            .foregroundStyle(game.state == .live ? liveRed : Color.secondary)
            .lineLimit(1)
    }
}

private struct GameRow: View {
    let game: Game
    let logos: [URL: NSImage]

    var body: some View {
        HStack(spacing: 10) {
            VStack(spacing: 2) {
                TeamScoreLine(team: game.away, game: game, logos: logos)
                TeamScoreLine(team: game.home, game: game, logos: logos)
            }
            VStack(alignment: .trailing, spacing: 2) {
                StatusText(game: game)
                if !game.situation.isEmpty {
                    Text(game.situation).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(width: 96, alignment: .trailing)
        }
    }
}

private struct SmallGameView: View {
    let game: Game
    let logos: [URL: NSImage]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(League.find(game.league)?.label ?? "").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                Spacer()
                if game.state == .live {
                    Circle().fill(liveRed).frame(width: 6, height: 6)
                }
            }
            TeamScoreLine(team: game.away, game: game, logos: logos, logoSize: 24, scoreFont: .title2.weight(.bold))
            TeamScoreLine(team: game.home, game: game, logos: logos, logoSize: 24, scoreFont: .title2.weight(.bold))
            Spacer(minLength: 0)
            StatusText(game: game)
            if !game.situation.isEmpty {
                Text(game.situation).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}
