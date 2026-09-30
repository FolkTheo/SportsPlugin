import Foundation

// A small Swift port of the web UI's ESPN parsing (src/lib/espn.js), just
// enough for the widget and the menu bar: teams, scores and game status.
// Parsing uses plain dictionaries rather than Codable because ESPN's payloads
// vary by sport and game state.

enum GameState: String {
    case pre
    case live = "in"
    case post
}

struct TeamLine: Hashable {
    let id: String
    let abbr: String
    let name: String
    let score: String
    let logo: URL?
    let rank: Int?
    let winner: Bool
}

struct Game: Identifiable, Hashable {
    let id: String
    let league: String
    let date: Date?
    let state: GameState
    /// ESPN's short status: "4:12 - 3rd", "Final", "Top 7th".
    let detail: String
    let away: TeamLine
    let home: TeamLine
    /// "2nd & 7" or "2-1, 1 out" while live; otherwise empty.
    let situation: String

    /// Opens this game in the app (see AppDelegate.handle(url:)).
    var deepLink: URL {
        var c = URLComponents()
        c.scheme = "courtside"
        c.host = "game"
        c.queryItems = [URLQueryItem(name: "league", value: league), URLQueryItem(name: "id", value: id)]
        return c.url!
    }

    /// Status for display: kickoff time before the game, ESPN's detail after.
    var statusText: String {
        guard state == .pre, let date, !detail.localizedCaseInsensitiveContains("TBD") else { return detail }
        let f = DateFormatter()
        f.dateFormat = Calendar.current.isDateInToday(date) ? "h:mm a" : "EEE h:mm a"
        return f.string(from: date)
    }
}

enum ScoresClient {
    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private static let apiRoot = "https://site.api.espn.com/apis/site/v2/sports"

    static func fetchJSON(_ url: URL) async throws -> [String: Any] {
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    /// Today's games for a league, live first.
    static func scoreboard(_ league: League) async throws -> [Game] {
        var c = URLComponents(string: "\(apiRoot)/\(league.path)/scoreboard")!
        c.queryItems = league.scoreboardQuery.isEmpty ? nil : league.scoreboardQuery
        let json = try await fetchJSON(c.url!)
        let events = json["events"] as? [[String: Any]] ?? []
        return sorted(events.compactMap { parseEvent($0, league: league.id) })
    }

    /// A team's current or next game (ESPN's team endpoint keeps it live).
    static func nextGame(for favorite: SharedStore.Favorite) async throws -> Game? {
        guard let league = League.find(favorite.league),
              let url = URL(string: "\(apiRoot)/\(league.path)/teams/\(favorite.teamID)") else { return nil }
        let json = try await fetchJSON(url)
        let team = json["team"] as? [String: Any]
        guard let event = (team?["nextEvent"] as? [[String: Any]])?.first else { return nil }
        return parseEvent(event, league: league.id)
    }

    /// Current/next game for each favorite team, deduplicated, live first.
    static func favoriteGames(_ favorites: [SharedStore.Favorite]) async -> [Game] {
        let games = await withTaskGroup(of: Game?.self) { group -> [Game] in
            for favorite in favorites {
                group.addTask { try? await ScoresClient.nextGame(for: favorite) }
            }
            var out: [Game] = []
            for await game in group {
                if let game, !out.contains(where: { $0.id == game.id && $0.league == game.league }) { out.append(game) }
            }
            return out
        }
        return sorted(games)
    }

    static func sorted(_ games: [Game]) -> [Game] {
        let order: [GameState: Int] = [.live: 0, .pre: 1, .post: 2]
        return games.sorted { a, b in
            if a.state != b.state { return order[a.state]! < order[b.state]! }
            let da = a.date ?? .distantFuture
            let db = b.date ?? .distantFuture
            return a.state == .post ? da > db : da < db
        }
    }

    // MARK: Parsing

    static func parseEvent(_ event: [String: Any], league: String) -> Game? {
        guard let comp = (event["competitions"] as? [[String: Any]])?.first,
              let competitors = comp["competitors"] as? [[String: Any]], competitors.count >= 2 else { return nil }
        let homeRaw = competitors.first { $0["homeAway"] as? String == "home" } ?? competitors[1]
        let awayRaw = competitors.first { $0["homeAway"] as? String == "away" } ?? competitors[0]
        let status = (comp["status"] ?? event["status"]) as? [String: Any] ?? [:]
        let type = status["type"] as? [String: Any] ?? [:]
        let state = GameState(rawValue: type["state"] as? String ?? "pre") ?? .pre
        let id = string(event["id"]) ?? string(comp["id"]) ?? UUID().uuidString

        return Game(
            id: id,
            league: league,
            date: parseDate(event["date"] as? String ?? comp["date"] as? String),
            state: state,
            detail: type["shortDetail"] as? String ?? type["detail"] as? String ?? "",
            away: parseTeam(awayRaw),
            home: parseTeam(homeRaw),
            situation: state == .live ? situationText(comp["situation"] as? [String: Any], league: league) : ""
        )
    }

    private static func parseTeam(_ c: [String: Any]) -> TeamLine {
        let team = c["team"] as? [String: Any] ?? [:]
        let logo = team["logo"] as? String ?? (team["logos"] as? [[String: Any]])?.first?["href"] as? String
        var score = ""
        if let s = c["score"] as? [String: Any] {
            score = string(s["displayValue"]) ?? string(s["value"]) ?? ""
        } else {
            score = string(c["score"]) ?? ""
        }
        let rank = ((c["curatedRank"] as? [String: Any])?["current"] as? Int) ?? (c["rank"] as? Int)
        return TeamLine(
            id: string(team["id"]) ?? "",
            abbr: team["abbreviation"] as? String ?? "",
            name: team["shortDisplayName"] as? String ?? team["name"] as? String ?? "",
            score: score,
            logo: logo.flatMap(URL.init(string:)),
            rank: rank.flatMap { $0 <= 25 ? $0 : nil },
            winner: c["winner"] as? Bool ?? false
        )
    }

    private static func situationText(_ s: [String: Any]?, league: String) -> String {
        guard let s else { return "" }
        if let dd = s["shortDownDistanceText"] as? String ?? s["downDistanceText"] as? String { return dd }
        if league == "mlb", let balls = s["balls"] as? Int, let strikes = s["strikes"] as? Int, let outs = s["outs"] as? Int {
            return "\(balls)-\(strikes), \(outs) out\(outs == 1 ? "" : "s")"
        }
        return ""
    }

    private static func string(_ v: Any?) -> String? {
        switch v {
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        default: return nil
        }
    }

    /// ESPN dates look like "2026-09-28T20:25Z" (often without seconds).
    static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        let iso = ISO8601DateFormatter()
        if let d = iso.date(from: s) { return d }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        for format in ["yyyy-MM-dd'T'HH:mmX", "yyyy-MM-dd'T'HH:mm:ssX", "yyyy-MM-dd'T'HH:mm:ss.SSSX"] {
            f.dateFormat = format
            if let d = f.date(from: s) { return d }
        }
        return nil
    }
}
