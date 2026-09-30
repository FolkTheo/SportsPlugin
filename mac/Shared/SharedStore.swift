import Foundation

/// Storage shared by the app, its web UI and the widget, through an App Group.
///
/// The web UI's `chrome.storage` areas ("sync", "local") are kept as JSON
/// dictionaries under "storage.sync" / "storage.local", written by
/// NativeBridge. Swift code reads favorites and settings from the same place,
/// so starring a team in the UI immediately affects the menu bar and widget.
enum SharedStore {
    /// "<TeamID>.courtside", from the AppGroupIdentifier Info.plist key.
    static let groupID: String? = Bundle.main.object(forInfoDictionaryKey: "AppGroupIdentifier") as? String

    static var defaults: UserDefaults {
        if let id = groupID, !id.isEmpty, let shared = UserDefaults(suiteName: id) { return shared }
        return .standard
    }

    private static func key(_ area: String) -> String { "storage.\(area)" }

    static func areaJSON(_ area: String) -> String {
        defaults.string(forKey: key(area)) ?? "{}"
    }

    static func area(_ area: String) -> [String: Any] {
        guard let data = areaJSON(area).data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return dict
    }

    static func saveArea(_ area: String, _ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        defaults.set(json, forKey: key(area))
    }

    /// Merges `patch` into the web UI's saved UI state (which league/game is open).
    static func mergeUIState(_ patch: [String: Any]) {
        var local = area("local")
        var ui = local["ui"] as? [String: Any] ?? [:]
        for (k, v) in patch { ui[k] = v }
        local["ui"] = ui
        saveArea("local", local)
    }

    // MARK: Favorites & settings (written by the web UI)

    struct Favorite: Hashable {
        let league: String
        let teamID: String
        let abbr: String
        let name: String
    }

    static var favorites: [Favorite] {
        let list = area("sync")["favorites"] as? [[String: Any]] ?? []
        return list.compactMap { f in
            guard let league = f["league"] as? String, League.find(league) != nil,
                  let teamID = (f["teamId"] as? String) ?? (f["teamId"] as? NSNumber)?.stringValue else { return nil }
            return Favorite(league: league, teamID: teamID, abbr: f["abbr"] as? String ?? "", name: f["name"] as? String ?? "")
        }
    }

    static var notifyFavorites: Bool {
        (area("sync")["settings"] as? [String: Any])?["notifyFavorites"] as? Bool ?? true
    }
}
