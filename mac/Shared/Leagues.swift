import Foundation

/// The leagues Courtside covers. Mirrors src/lib/leagues.js (the web UI's
/// definitions); `path` is the ESPN site API path segment.
struct League: Hashable, Identifiable {
    let id: String
    let label: String
    let path: String
    /// Extra scoreboard query items (college leagues need a group to list every game).
    let scoreboardQuery: [URLQueryItem]

    static let all: [League] = [
        League(id: "nfl", label: "NFL", path: "football/nfl", scoreboardQuery: []),
        League(id: "nba", label: "NBA", path: "basketball/nba", scoreboardQuery: []),
        League(id: "mlb", label: "MLB", path: "baseball/mlb", scoreboardQuery: []),
        League(id: "nhl", label: "NHL", path: "hockey/nhl", scoreboardQuery: []),
        League(id: "cfb", label: "CFB", path: "football/college-football",
               scoreboardQuery: [URLQueryItem(name: "groups", value: "80"), URLQueryItem(name: "limit", value: "400")]),
        League(id: "cbb", label: "CBB", path: "basketball/mens-college-basketball",
               scoreboardQuery: [URLQueryItem(name: "groups", value: "50"), URLQueryItem(name: "limit", value: "400")]),
    ]

    static func find(_ id: String) -> League? {
        all.first { $0.id == id }
    }
}
