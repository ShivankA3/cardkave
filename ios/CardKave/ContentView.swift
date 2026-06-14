import SwiftUI

/// Hosts the CardKave web app inside a full-screen WKWebView.
///
/// The native chrome is intentionally minimal: a background colour that matches
/// the web theme (so the status-bar and home-indicator areas blend in) and a
/// status-bar style that follows the in-app light/dark toggle, reported back
/// from the web app through a small JS → native bridge (see WebView).
struct ContentView: View {
    @StateObject private var model = WebViewModel()

    var body: some View {
        ZStack {
            backgroundColor
                .ignoresSafeArea()
            WebView(model: model)
                // Let WKWebView handle keyboard insets itself; otherwise SwiftUI
                // and WebKit both adjust and the content jumps.
                .ignoresSafeArea(.keyboard, edges: .bottom)
        }
        .preferredColorScheme(model.theme == .light ? .light : .dark)
    }

    /// Matches the web app's default dark surface (#0f0f13) and pure white in
    /// light mode, so the safe-area strips don't show a mismatched band.
    private var backgroundColor: Color {
        model.theme == .light
            ? Color(red: 1, green: 1, blue: 1)
            : Color(red: 15 / 255, green: 15 / 255, blue: 19 / 255)
    }
}
