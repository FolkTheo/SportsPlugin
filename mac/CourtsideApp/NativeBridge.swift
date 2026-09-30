import AppKit
import ServiceManagement
import WebKit
import WidgetKit

/// Answers the web UI's calls (see Web/native-shim.js). Every message is a
/// dictionary with a "type"; the reply resolves the page's promise.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private static let areas: Set<String> = ["sync", "local", "session"]
    /// The only hosts the page may fetch through the app.
    private static let apiHosts: Set<String> = ["site.api.espn.com", "sportsbook-nash.draftkings.com"]

    // The async form of the reply API: the returned (value, error) resolves or
    // rejects the page's promise.
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return (nil, "Malformed message")
        }
        switch type {
        case "storage-get", "storage-set", "storage-remove":
            guard let area = body["area"] as? String, Self.areas.contains(area) else {
                return (nil, "Unknown storage area")
            }
            if type == "storage-get" { return (SharedStore.areaJSON(area), nil) }
            if type == "storage-set" { return (set(area: area, itemsJSON: body["items"] as? String), nil) }
            return (remove(area: area, keys: body["keys"] as? [String] ?? []), nil)

        case "fetch":
            return await fetch(body["url"] as? String)

        case "open-floating":
            FloatingPanel.shared.show()
            return (true, nil)

        case "open-url":
            if let s = body["url"] as? String, let url = URL(string: s), url.scheme == "https" || url.scheme == "http" {
                NSWorkspace.shared.open(url)
            }
            return (true, nil)

        case "get-login-item":
            return (SMAppService.mainApp.status == .enabled, nil)

        case "set-login-item":
            do {
                if body["enabled"] as? Bool == true {
                    try SMAppService.mainApp.register()
                } else {
                    try SMAppService.mainApp.unregister()
                }
                return (true, nil)
            } catch {
                return (nil, error.localizedDescription)
            }

        case "quit":
            // Let the reply reach the page first.
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return (true, nil)

        default:
            return (nil, "Unknown message: \(type)")
        }
    }

    // MARK: Storage

    private func set(area: String, itemsJSON: String?) -> Bool {
        guard let data = itemsJSON?.data(using: .utf8),
              let items = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        var stored = SharedStore.area(area)
        var changes: [String: Any] = [:]
        for (key, value) in items {
            var change: [String: Any] = ["newValue": value]
            if let old = stored[key] { change["oldValue"] = old }
            changes[key] = change
            stored[key] = value
        }
        SharedStore.saveArea(area, stored)
        didChange(area: area, changes: changes)
        return true
    }

    private func remove(area: String, keys: [String]) -> Bool {
        var stored = SharedStore.area(area)
        var changes: [String: Any] = [:]
        for key in keys {
            if let old = stored.removeValue(forKey: key) { changes[key] = ["oldValue": old] }
        }
        SharedStore.saveArea(area, stored)
        didChange(area: area, changes: changes)
        return true
    }

    private func didChange(area: String, changes: [String: Any]) {
        guard !changes.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: changes),
              let json = String(data: data, encoding: .utf8) else { return }
        // JSON is a valid JavaScript expression, so it can be passed inline.
        WebViews.shared.broadcast("window.__courtsideStorageChanged && window.__courtsideStorageChanged(\"\(area)\", \(json))")
        // Favorites and settings drive the menu bar score and the widget.
        if area == "sync", changes["favorites"] != nil || changes["settings"] != nil {
            FavoritesMonitor.shared.refreshNow()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    // MARK: Network

    private func fetch(_ urlString: String?) async -> (Any?, String?) {
        guard let urlString, let url = URL(string: urlString), url.scheme == "https",
              let host = url.host, Self.apiHosts.contains(host) else {
            return (nil, "Blocked request")
        }
        do {
            let (data, response) = try await ScoresClient.session.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            return (["status": status, "body": String(decoding: data, as: UTF8.self)], nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }
}
