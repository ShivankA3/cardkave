import Foundation
import Network
import UniformTypeIdentifiers

/// A tiny embedded HTTP/1.1 server that serves the bundled `www` directory on
/// 127.0.0.1.
///
/// Why not a custom `cardkave://` URL scheme? The web app uses Firebase Auth,
/// whose initialization only completes on an **authorized domain**. A custom
/// scheme isn't one, so Firebase's first `onAuthStateChanged` never fires, the
/// app's boot `await cloudSync.ready` hangs, and the router never runs (blank
/// screen). Serving over `http://localhost` — which Firebase authorizes by
/// default — makes the app behave exactly as it does on the website, while
/// still bundling the local code so you can test your own changes. Needs no
/// third-party dependencies (built on Network.framework).
final class LocalServer {
    private let root: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.cardkave.localserver", attributes: .concurrent)
    private(set) var port: UInt16 = 0
    private var ready = false

    /// Whether the listener is currently accepting connections.
    var isReady: Bool { ready }

    init(root: URL) { self.root = root.standardizedFileURL }

    /// Starts listening on a free loopback port and calls `onReady(port)` on the
    /// main queue once the server is accepting connections.
    func start(onReady: @escaping (UInt16) -> Void) {
        if ready, port != 0 { onReady(port); return }
        bootstrap(onReady: onReady)
    }

    /// Ensures the server is listening — iOS tears the loopback listener down
    /// while the app is suspended, so after returning to the foreground we may
    /// need to start a fresh one. Reports the port and whether a restart was
    /// required (so the caller can reload the web view onto the new port).
    func ensureRunning(_ completion: @escaping (_ port: UInt16, _ didRestart: Bool) -> Void) {
        if ready, port != 0 { completion(port, false); return }
        listener?.cancel()
        listener = nil
        bootstrap { port in completion(port, true) }
    }

    private func bootstrap(onReady: @escaping (UInt16) -> Void) {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            params.requiredInterfaceType = .loopback
            let listener = try NWListener(using: params)
            self.listener = listener
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            var firedReady = false
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.ready = true
                    let port = listener.port?.rawValue ?? 0
                    self?.port = port
                    if !firedReady { firedReady = true; DispatchQueue.main.async { onReady(port) } }
                case .failed(let error):
                    self?.ready = false
                    NSLog("CKSERVER: listener failed: \(error)")
                case .cancelled:
                    self?.ready = false
                default:
                    break
                }
            }
            listener.start(queue: queue)
        } catch {
            NSLog("CKSERVER: failed to start: \(error)")
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        readRequest(connection, buffer: Data())
    }

    /// Accumulates bytes until the end of the HTTP request headers, then serves.
    private func readRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self = self else { connection.cancel(); return }
            var buffer = buffer
            if let data = data { buffer.append(data) }

            if let range = buffer.firstRange(of: Data("\r\n\r\n".utf8)) {
                let head = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                self.serve(connection, requestHead: head)
                return
            }
            if error != nil || isComplete || buffer.count > 1_000_000 {
                self.send(connection, status: 400, headers: [:], body: Data("Bad Request".utf8))
                return
            }
            self.readRequest(connection, buffer: buffer)
        }
    }

    private func serve(_ connection: NWConnection, requestHead: Data) {
        guard let text = String(data: requestHead, encoding: .utf8),
              let requestLine = text.split(separator: "\r\n", omittingEmptySubsequences: false).first else {
            send(connection, status: 400, headers: [:], body: Data("Bad Request".utf8)); return
        }
        let tokens = requestLine.split(separator: " ")
        guard tokens.count >= 2 else {
            send(connection, status: 400, headers: [:], body: Data()); return
        }
        let method = String(tokens[0])
        var path = String(tokens[1])
        if let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            path = String(path[path.startIndex..<cut])
        }
        path = path.removingPercentEncoding ?? path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let relative = String(path.drop(while: { $0 == "/" }))
        let fileURL = root.appendingPathComponent(relative).standardizedFileURL

        guard fileURL.path == root.path || fileURL.path.hasPrefix(root.path + "/") else {
            send(connection, status: 403, headers: ["Content-Type": "text/plain"], body: Data("Forbidden".utf8)); return
        }
        guard method == "GET" || method == "HEAD" else {
            send(connection, status: 405, headers: ["Allow": "GET, HEAD"], body: Data()); return
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            send(connection, status: 404, headers: ["Content-Type": "text/plain"],
                 body: Data("Not found: \(relative)".utf8)); return
        }
        let headers = [
            "Content-Type": Self.mimeType(forExtension: fileURL.pathExtension),
            "Cache-Control": "no-cache",
        ]
        send(connection, status: 200, headers: headers,
             body: method == "HEAD" ? Data() : data, declaredLength: data.count)
    }

    private func send(_ connection: NWConnection, status: Int, headers: [String: String],
                      body: Data, declaredLength: Int? = nil) {
        var response = "HTTP/1.1 \(status) \(Self.reasonPhrase(status))\r\n"
        var headers = headers
        headers["Content-Length"] = String(declaredLength ?? body.count)
        headers["Connection"] = "close"
        for (key, value) in headers { response += "\(key): \(value)\r\n" }
        response += "\r\n"
        var out = Data(response.utf8)
        out.append(body)
        connection.send(content: out, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private static func reasonPhrase(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        default:  return "OK"
        }
    }

    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "text/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "svg":         return "image/svg+xml"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif":         return "image/gif"
        case "webp":        return "image/webp"
        case "ico":         return "image/x-icon"
        case "woff":        return "font/woff"
        case "woff2":       return "font/woff2"
        case "ttf":         return "font/ttf"
        case "map", "txt":  return "text/plain; charset=utf-8"
        default:
            if let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType {
                return mime
            }
            return "application/octet-stream"
        }
    }
}
