import Foundation
import Security

/// La session dans le trousseau de connexion : un mot de passe générique par origine, jamais
/// dans `UserDefaults`, non synchronisé.
///
/// L'élément est écrit et lu par `/usr/bin/security`, pas par l'API du trousseau depuis l'app.
/// Raison : sans certificat Developer ID, macOS attache l'élément à l'empreinte du binaire qui l'a
/// créé (liste de partitions `cdhash:`), et chaque recompilation redemandait le mot de passe de
/// session. Porté par l'outil système, signé par Apple et stable, il ne demande plus rien.
/// Contrepartie assumée, la même que `gh` : un processus de l'utilisateur qui appelle `security`
/// peut lire l'élément sans boîte. Le secret ne passe jamais en argument (visible dans `ps`) :
/// il transite par l'entrée standard de `security -i`, encodé en base64.
struct SessionKeychain: Sendable {
    var service = "app.openedbot.popup.session"
    /// L'élément de l'ancienne encoche (`app.openedbot.notch`), relu une fois pour rester connecté ; laissé en place.
    var legacyService: String? = "app.openedbot.notch.session"
    var tool = "/usr/bin/security"

    func load(origin: URL) throws -> OHBotSession? {
        let account = try Self.checked(origin.absoluteString)
        let result = try run([tool, "find-generic-password", "-s", service, "-a", account, "-w"])
        // 44 : élément introuvable.
        if result.status == 44 { return try migrateLegacy(origin: origin) }
        guard result.status == 0 else { throw OHBotAuthError.keychain(OSStatus(result.status)) }
        let encoded = String(decoding: result.output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        // Une entrée illisible (format d'une autre version) vaut « pas de session », pas un crash.
        guard let data = Data(base64Encoded: encoded) else { return nil }
        return try? OHBotAuthClient.decoder.decode(OHBotSession.self, from: data)
    }

    func save(_ session: OHBotSession, origin: URL) throws {
        let account = try Self.checked(origin.absoluteString)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let encoded = try encoder.encode(session).base64EncodedString()
        // `-U` met à jour l'élément s'il existe ; le base64 ne contient ni guillemet ni espace.
        let command = "add-generic-password -U -s \"\(service)\" -a \"\(account)\" -w \"\(encoded)\"\n"
        let result = try run([tool, "-i"], input: Data(command.utf8))
        guard result.status == 0, result.errors.isEmpty else {
            throw OHBotAuthError.keychain(OSStatus(result.status == 0 ? errSecIO : result.status))
        }
    }

    func delete(origin: URL) throws {
        let account = try Self.checked(origin.absoluteString)
        let result = try run([tool, "delete-generic-password", "-s", service, "-a", account])
        guard result.status == 0 || result.status == 44 else { throw OHBotAuthError.keychain(OSStatus(result.status)) }
    }

    /// Une fois : l'ancien élément (écrit par l'app elle-même) est relu, recopié, puis supprimé.
    /// macOS peut demander le mot de passe cette fois-là, la dernière.
    /// Une fois : l'élément de l'ancienne encoche, écrit lui aussi par `security`, est relu sans boîte et recopié.
    /// Il n'est pas supprimé : l'opérateur le retire quand la migration est confirmée.
    private func migrateLegacy(origin: URL) throws -> OHBotSession? {
        guard let legacyService else { return nil }
        let account = try Self.checked(origin.absoluteString)
        let result = try run([tool, "find-generic-password", "-s", legacyService, "-a", account, "-w"])
        guard result.status == 0 else { return nil }
        let encoded = String(decoding: result.output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let data = Data(base64Encoded: encoded),
              let session = try? OHBotAuthClient.decoder.decode(OHBotSession.self, from: data) else { return nil }
        try save(session, origin: origin)
        return session
    }

    /// Le compte est une origine (`https://hôte`) : on refuse tout ce qui casserait la ligne de commande.
    static func checked(_ account: String) throws -> String {
        guard !account.isEmpty, !account.contains("\""), !account.contains("\n"), !account.contains("\\") else {
            throw OHBotAuthError.invalidOrigin
        }
        return account
    }

    private func run(_ arguments: [String], input: Data? = nil) throws -> (status: Int32, output: Data, errors: Data) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: arguments[0])
        process.arguments = Array(arguments.dropFirst())
        let stdout = Pipe()
        process.standardOutput = stdout
        let stderr = Pipe()
        process.standardError = stderr
        let stdin = Pipe()
        process.standardInput = input == nil ? FileHandle.nullDevice : stdin
        do { try process.run() } catch { throw OHBotAuthError.keychain(errSecNotAvailable) }
        if let input {
            stdin.fileHandleForWriting.write(input)
            try? stdin.fileHandleForWriting.close()
        }
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        let errors = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, output, errors)
    }
}
