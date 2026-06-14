import Darwin
import Foundation
import UniformTypeIdentifiers

/// A tiny embedded HTTP/1.1 server that serves the bundled `www` directory on
/// 127.0.0.1.
///
/// Why a raw BSD socket instead of Network.framework's `NWListener`? On a real
/// device, `NWListener` goes through iOS's local-network privacy layer, which
/// terminates the app (`abort_with_payload`) when used without the right
/// declaration — even for loopback. A POSIX socket explicitly bound to the
/// loopback address `127.0.0.1` is exempt from local-network privacy, so it
/// runs the same on the simulator and on device, with no prompt and no crash.
///
/// Why a local server at all? The web app uses Firebase Auth, which only
/// initializes on an authorized domain — `localhost` is authorized by default,
/// a `file://` / custom-scheme origin is not — so loading any other way leaves
/// the app stuck on a blank screen during boot.
final class LocalServer {
    private let root: URL
    private var serverFD: Int32 = -1
    private(set) var port: UInt16 = 0
    private var ready = false
    private let lock = NSLock()
    private let acceptQueue = DispatchQueue(label: "com.cardkave.localserver.accept")
    private let ioQueue = DispatchQueue(label: "com.cardkave.localserver.io", attributes: .concurrent)

    /// Whether the server is currently listening.
    var isReady: Bool { lock.lock(); defer { lock.unlock() }; return ready }

    init(root: URL) {
        self.root = root.standardizedFileURL
        // Never let a write to a closed client socket raise SIGPIPE (which would
        // crash the app); we also set SO_NOSIGPIPE per connection below.
        signal(SIGPIPE, SIG_IGN)
    }

    /// Starts the server (if not already running) and calls `onReady(port)` on
    /// the main queue once it is listening.
    func start(onReady: @escaping (UInt16) -> Void) {
        if isReady, port != 0 { onReady(port); return }
        bootstrap { port in DispatchQueue.main.async { onReady(port) } }
    }

    /// Ensures the server is listening — iOS closes the socket while the app is
    /// suspended, so after returning to the foreground we may need a fresh one.
    /// Reports the port and whether a restart was required (so the caller can
    /// reload the web view onto the new port).
    func ensureRunning(_ completion: @escaping (_ port: UInt16, _ didRestart: Bool) -> Void) {
        if isReady, port != 0 { completion(port, false); return }
        stop()
        bootstrap { port in DispatchQueue.main.async { completion(port, true) } }
    }

    private func stop() {
        lock.lock()
        ready = false
        let fd = serverFD
        serverFD = -1
        lock.unlock()
        if fd >= 0 { close(fd) }
    }

    private func bootstrap(onReady: @escaping (UInt16) -> Void) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { NSLog("CKSERVER: socket() failed errno=\(errno)"); return }

        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0                                // let the OS pick a free port
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")   // loopback only — privacy-exempt

        let didBind = withUnsafePointer(to: &addr) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard didBind == 0 else { NSLog("CKSERVER: bind failed errno=\(errno)"); close(fd); return }
        guard listen(fd, 16) == 0 else { NSLog("CKSERVER: listen failed errno=\(errno)"); close(fd); return }

        var name = sockaddr_in()
        var nameLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let chosenPort: UInt16 = withUnsafeMutablePointer(to: &name) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in _ = getsockname(fd, sa, &nameLen) }
            return UInt16(bigEndian: raw.pointee.sin_port)
        }

        lock.lock(); serverFD = fd; port = chosenPort; ready = true; lock.unlock()
        onReady(chosenPort)
        acceptQueue.async { [weak self] in self?.acceptLoop(fd) }
    }

    private func acceptLoop(_ fd: Int32) {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 {
                if errno == EINTR { continue }
                break  // server socket was closed
            }
            var noSigpipe: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
            ioQueue.async { [weak self] in self?.handle(client) }
        }
    }

    private func handle(_ fd: Int32) {
        defer { close(fd) }

        // Read until the end of the request headers (GET/HEAD have no body).
        var request = Data()
        let terminator = Data("\r\n\r\n".utf8)
        var buffer = [UInt8](repeating: 0, count: 8192)
        while request.range(of: terminator) == nil {
            let n = recv(fd, &buffer, buffer.count, 0)
            if n <= 0 { return }
            request.append(contentsOf: buffer[0..<n])
            if request.count > 1_000_000 { return }
        }

        guard let headEnd = request.range(of: terminator),
              let head = String(data: request.subdata(in: request.startIndex..<headEnd.lowerBound), encoding: .utf8),
              let requestLine = head.split(separator: "\r\n", omittingEmptySubsequences: false).first else {
            writeResponse(fd, status: 400, headers: [:], body: Data("Bad Request".utf8)); return
        }

        let tokens = requestLine.split(separator: " ")
        guard tokens.count >= 2 else { writeResponse(fd, status: 400, headers: [:], body: Data()); return }
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
            writeResponse(fd, status: 403, headers: ["Content-Type": "text/plain"], body: Data("Forbidden".utf8)); return
        }
        guard method == "GET" || method == "HEAD" else {
            writeResponse(fd, status: 405, headers: ["Allow": "GET, HEAD"], body: Data()); return
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            writeResponse(fd, status: 404, headers: ["Content-Type": "text/plain"],
                          body: Data("Not found: \(relative)".utf8)); return
        }
        let headers = [
            "Content-Type": Self.mimeType(forExtension: fileURL.pathExtension),
            "Cache-Control": "no-cache",
        ]
        writeResponse(fd, status: 200, headers: headers,
                      body: method == "HEAD" ? Data() : data, declaredLength: data.count)
    }

    private func writeResponse(_ fd: Int32, status: Int, headers: [String: String],
                               body: Data, declaredLength: Int? = nil) {
        var response = "HTTP/1.1 \(status) \(Self.reasonPhrase(status))\r\n"
        var headers = headers
        headers["Content-Length"] = String(declaredLength ?? body.count)
        headers["Connection"] = "close"
        for (key, value) in headers { response += "\(key): \(value)\r\n" }
        response += "\r\n"
        var out = Data(response.utf8)
        out.append(body)
        writeAll(fd, out)
    }

    private func writeAll(_ fd: Int32, _ data: Data) {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress, raw.count > 0 else { return }
            var sent = 0
            while sent < raw.count {
                let n = send(fd, base + sent, raw.count - sent, 0)
                if n <= 0 { break }
                sent += n
            }
        }
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
