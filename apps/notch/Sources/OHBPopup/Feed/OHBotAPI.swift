import Foundation

/// Les appels REST du flux : un bearer valide avant chaque requête, un seul rejeu après un 401
/// avec un jeton rafraîchi, les erreurs de l'API avec leur code.
@MainActor
struct OHBotAPI {
    /// D'où viennent les jetons : le compte local, ou openedbot en mode hébergé.
    let account: any TokenSource
    let transport: any HTTPTransport

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        try await decode(T.self, from: send("GET", path, query: query, body: nil))
    }

    /// Les octets bruts d'une ressource protégée (pièce jointe, avatar importé).
    func data(_ path: String) async throws -> Data {
        try await send("GET", path, query: [:], body: nil)
    }

    func post<T: Decodable>(_ path: String, json body: some Encodable, headers: [String: String] = [:], method: String = "POST") async throws -> T {
        try await decode(T.self, from: send(method, path, query: [:], body: try JSONEncoder().encode(body), headers: headers))
    }

    func delete(_ path: String, query: [String: String] = [:]) async throws {
        _ = try await send("DELETE", path, query: query, body: nil)
    }

    func request(_ method: String, _ path: String, query: [String: String] = [:], session: BearerToken, body: Data? = nil,
                 headers: [String: String] = [:]) throws -> URLRequest {
        guard let origin = account.origin, var components = URLComponents(url: origin.appending(path: path), resolvingAgainstBaseURL: false) else {
            throw OHBotAuthError.invalidOrigin
        }
        if !query.isEmpty { components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var r = URLRequest(url: components.url!)
        r.httpMethod = method
        r.timeoutInterval = 20
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        r.setValue(session.organizationId, forHTTPHeaderField: "X-OHB-Organization")
        if body != nil { r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        r.httpBody = body
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    private func send(_ method: String, _ path: String, query: [String: String], body: Data?, headers: [String: String] = [:]) async throws -> Data {
        let session = try await account.validToken()
        do {
            return try await perform(request(method, path, query: query, session: session, body: body, headers: headers))
        } catch OHBotAuthError.http(401, let code) {
            // Le jeton paraissait bon : on le rafraîchit une fois, puis on rejoue.
            let fresh = try await account.refreshedToken()
            do {
                return try await perform(request(method, path, query: query, session: fresh, body: body, headers: headers))
            } catch OHBotAuthError.http(401, _) {
                throw OHBotAuthError.http(status: 401, code: code)
            }
        }
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let data: Data
        let http: HTTPURLResponse
        do {
            (data, http) = try await transport.send(request)
        } catch let e as OHBotAuthError {
            throw e
        } catch let e as URLError where e.code == .cancelled {
            throw OHBotAuthError.cancelled
        } catch {
            throw OHBotAuthError.network(error.localizedDescription)
        }
        guard (200..<300).contains(http.statusCode) else {
            struct Envelope: Decodable { struct Inner: Decodable { var code: String?; var message: String? }; var error: Inner? }
            let inner = (try? JSONDecoder().decode(Envelope.self, from: data))?.error
            // Un 5xx expliqué (« Erreur interne : … Référence : … ») : la référence retrouve la ligne du journal serveur.
            if http.statusCode >= 500, let message = inner?.message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
                throw OHBotAuthError.server(status: http.statusCode, code: inner?.code, message: String(message.prefix(300)))
            }
            throw OHBotAuthError.http(status: http.statusCode, code: inner?.code)
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) async throws -> T {
        if T.self == Empty.self { return Empty() as! T }
        do { return try OHBotAuthClient.decoder.decode(T.self, from: data) } catch { throw OHBotAuthError.invalidResponse }
    }

    struct Empty: Decodable, Sendable {}
}

/// Un lecteur de trames Server-Sent Events, octet par octet : `id`, `event`, `data`, les
/// commentaires ignorés, les lignes `data` jointes par un saut de ligne, LF, CRLF et CR acceptés.
struct SSEParser: Sendable {
    struct Frame: Equatable, Sendable {
        var id: String?
        var event: String?
        var data: String
    }

    private var line: [UInt8] = []
    private var sawCR = false
    private var id: String?
    private var event: String?
    private var data: [String] = []

    /// Donne les trames complètes contenues dans ce morceau.
    mutating func feed(_ bytes: some Sequence<UInt8>) -> [Frame] {
        var frames: [Frame] = []
        for b in bytes {
            if b == 0x0A { // LF
                if sawCR { sawCR = false; continue } // CRLF : le CR a déjà clos la ligne
                if let f = endLine() { frames.append(f) }
            } else if b == 0x0D { // CR
                sawCR = true
                if let f = endLine() { frames.append(f) }
            } else {
                sawCR = false
                line.append(b)
            }
        }
        return frames
    }

    private mutating func endLine() -> Frame? {
        defer { line = [] }
        let text = String(decoding: line, as: UTF8.self)
        if text.isEmpty {
            guard !data.isEmpty else { event = nil; return nil }
            let frame = Frame(id: id, event: event, data: data.joined(separator: "\n"))
            event = nil
            data = []
            return frame
        }
        if text.hasPrefix(":") { return nil }
        let (field, value): (String, String)
        if let colon = text.firstIndex(of: ":") {
            field = String(text[..<colon])
            var v = text[text.index(after: colon)...]
            if v.hasPrefix(" ") { v = v.dropFirst() }
            value = String(v)
        } else {
            field = text
            value = ""
        }
        switch field {
        case "id": if !value.contains("\0") { id = value }
        case "event": event = value
        case "data": data.append(value)
        default: break
        }
        return nil
    }
}
