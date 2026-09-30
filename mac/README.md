# Courtside for Mac

The Courtside extension as a Mac app, in three forms:

- **Menu bar:** a court icon in the menu bar. Click it for the full Courtside interface: every league, favorites, box scores, odds and settings. While one of your favorite teams is playing, the icon changes to the live score (for example `KC 24–20 BUF`).
- **Float on desktop:** the same interface in a small window that stays on top of other apps, on every Space and over full-screen video. It's the Mac version of the extension's overlay. Open it with the pop-out button in the panel or with **Float on desktop** in Settings. It remembers where you put it.
- **Desktop widget:** small, medium and large widgets for your desktop or Notification Center. Each shows either **My Favorites** or any league (right-click the widget and choose **Edit Widget**). Clicking a game opens it in the floating window.

The app also sends score alerts for your favorite teams, like the extension does, and has an **Open at login** option in Settings.

## Requirements

- A Mac with **macOS 14 Sonoma** or newer (needed for desktop widgets)
- **Xcode 15** or newer, from the Mac App Store
- **XcodeGen**, which generates the Xcode project from `project.yml`: `brew install xcodegen`
- An Apple ID signed in to Xcode (Xcode ▸ Settings ▸ Accounts). A free account is enough to run the app on your own Mac.

## Build and run

1. Open `mac/project.yml` and set:
   - `COURTSIDE_BUNDLE_ID` to something unique to you, such as `com.yourname.courtside`
   - `DEVELOPMENT_TEAM` to your team id (shown in Xcode ▸ Settings ▸ Accounts, 10 characters)
2. Generate the project and open it:
   ```sh
   cd mac
   xcodegen generate
   open Courtside.xcodeproj
   ```
3. Select the **Courtside** scheme and **My Mac**, then press ⌘R.
4. The icon appears in the menu bar. There's no Dock icon; that's intentional. Allow notifications if you want score alerts.
5. To add the widget: right-click the desktop ▸ **Edit Widgets…**, search for **Courtside**, and drag in a size. Star a team in the menu bar panel and it shows up in the widget.

After changing `project.yml`, run `xcodegen generate` again. Changes to the shared interface in `../src` are picked up on the next build.

> **This code hasn't been compiled yet.** It was written in a Linux environment without Xcode. The part that connects the Swift app to the shared interface is tested in a browser (`npm run test:mac-bridge`), but the Swift itself hasn't been built. The first build may need small fixes. Paste any Xcode errors back and they're usually quick to resolve.

## How it works

```
mac/
  project.yml                    XcodeGen spec: the app plus a widget extension
  Shared/                        Code compiled into both the app and the widget
    Leagues.swift                League list (mirrors src/lib/leagues.js)
    Scores.swift                 Small Swift ESPN client: games, scores, status
    SharedStore.swift            App Group storage shared by the UI, app and widget
  CourtsideApp/
    CourtsideApp.swift           Menu bar app, notifications, courtside:// links
    WebViews.swift               Web views running ../src/app/app.html
    NativeBridge.swift           Answers the interface's storage, network and action requests
    FloatingPanel.swift          The always-on-top window
    FavoritesMonitor.swift       Live score in the menu bar, alerts, widget refreshes
    Web/native-shim.js           Gives the shared interface the chrome.* functions it expects
  CourtsideWidget/
    CourtsideWidget.swift        WidgetKit widget (SwiftUI) and its settings
```

- **One interface for both.** The menu bar panel and the floating window run the extension's own interface, bundled from `../src`. The app serves it at `courtside-app://app/…` and injects `native-shim.js` first. That script gives the interface the handful of `chrome.*` functions it uses: storage, network requests and messages. Improvements to the extension's interface carry over to the Mac app automatically.
- **Network requests** to ESPN and DraftKings go through the app itself rather than the web view, so browser cross-site restrictions don't apply. No other sites can be reached this way.
- **Storage** lives in an App Group, a storage area shared by the app and its widget. Favorites starred in the interface are immediately visible to the menu bar and the widget.
- **The widget** is native SwiftUI. Widgets can't run web pages, so it uses a small Swift port of the ESPN parsing to fetch games itself.

## Limits to know about

- **Widget freshness:** macOS decides how often widgets refresh. The widget asks for a refresh every 2 minutes during live games and every 30 minutes otherwise. While the app is running, it also triggers a refresh whenever a favorite's score changes. Even so, a widget can lag a live game by a minute or two. The menu bar and the floating window update every 15 seconds, or your chosen interval.
- **The floating window** stays above other windows. It doesn't draw inside other apps the way the Chrome overlay draws inside a web page.
- **Data sources** are the same unofficial ESPN and DraftKings feeds as the extension, with the same caveats (see the main README).

## Sharing it with other people

Running it on your own Mac is free. To give the app to others, you need the **Apple Developer Program** ($99 a year). Then either:

- **Direct download:** sign with a Developer ID certificate and notarize it (Xcode ▸ Product ▸ Archive ▸ Distribute App ▸ Direct Distribution). People can then download and open it without security warnings.
- **Mac App Store:** submit for App Review. The app is already sandboxed, which the store requires. Review would look closely at the unofficial ESPN and DraftKings data and the team logos, the same risks as the Chrome Web Store.
