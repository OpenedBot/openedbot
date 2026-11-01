import Foundation
import os

/// Le canal vers openedbot en mode hébergé : des lignes lues sur un descripteur (notre stdin), des
/// lignes écrites sur un autre (notre stdout d'origine). Les journaux n'y passent jamais.
final class HostChannel: @unchecked Sendable {
    private static let log = Logger(subsystem: "app.openedbot.popup", category: "host")

    private let input: FileHandle
    private let output: FileHandle
    private let lock = NSLock()
    private var closed = false
    /// Délai laissé au thread principal pour quitter après la fin de stdin ; au-delà, on sort de force
    /// (thread principal gelé) : une popup ne doit jamais survivre à son hôte.
    private let watchdog: Duration?

    init(input: FileHandle, output: FileHandle, watchdog: Duration? = .seconds(3)) {
        self.input = input
        self.output = output
        self.watchdog = watchdog
    }

    /// Les flux du processus, préparés pour le protocole : le stdout d'origine est mis de côté pour
    /// lui seul, puis le descripteur 1 pointe sur stderr. Un `print` égaré (le nôtre ou celui d'une
    /// bibliothèque) ne peut donc pas corrompre le canal. SIGPIPE est ignoré : un hôte disparu se
    /// voit à l'écriture (EPIPE) et à la lecture (EOF), il ne tue pas la popup en plein milieu.
    static func standardStreams() -> HostChannel? {
        signal(SIGPIPE, SIG_IGN)
        let protocolFD = dup(STDOUT_FILENO)
        guard protocolFD >= 0, dup2(STDERR_FILENO, STDOUT_FILENO) >= 0 else { return nil }
        return HostChannel(input: FileHandle.standardInput, output: FileHandle(fileDescriptor: protocolFD, closeOnDealloc: true))
    }

    /// Lit en continu sur un thread à part. `onLine` puis `onEOF` sont appelés sur le MainActor, dans
    /// l'ordre d'arrivée (un flux asynchrone, pas des blocs postés un à un : l'ordre compte, `hello`
    /// avant `signedIn`).
    func start(onLine: @escaping @MainActor (String) -> Void, onEOF: @escaping @MainActor () -> Void) {
        let input = self.input
        let watchdog = self.watchdog
        let (lines, sink) = AsyncStream<String>.makeStream(bufferingPolicy: .unbounded)
        Task { @MainActor in
            for await line in lines { onLine(line) }
            onEOF()
        }
        let thread = Thread { [weak self] in
            var splitter = HostLineSplitter()
            while true {
                guard let chunk = Self.readAvailable(input.fileDescriptor) else { break } // EOF : l'hôte a fermé, ou il est mort
                let (complete, overflowed) = splitter.push(chunk)
                if overflowed > 0 { Self.log.error("ligne trop longue ignorée (\(overflowed))") }
                for line in complete { sink.yield(line) }
            }
            self?.markClosed()
            Self.log.notice("fin du canal de l'hôte")
            sink.finish()
            if let watchdog {
                Thread.sleep(forTimeInterval: Double(watchdog.components.seconds) + Double(watchdog.components.attoseconds) / 1e18)
                Self.log.error("le thread principal n'a pas quitté après la fin du canal : sortie forcée")
                _exit(0)
            }
        }
        thread.name = "app.openedbot.popup.host"
        thread.start()
    }

    /// false : le canal est fermé (hôte parti) ; le message est perdu, l'appelant le traite en erreur.
    @discardableResult
    func send(_ message: HostProtocol.Outgoing) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return false }
        do {
            try output.write(contentsOf: HostProtocol.encode(message))
            return true
        } catch {
            closed = true
            Self.log.error("écriture vers l'hôte impossible : \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Ce qui est disponible, 4 Kio au plus ; nil à la fin du flux ou sur erreur. `read(2)` et non
    /// `FileHandle.read(upToCount:)`, qui sur un pipe attend d'avoir tout le compte ou la fin.
    static func readAvailable(_ fd: Int32) -> [UInt8]? {
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n > 0 { return Array(buffer.prefix(n)) }
            if n < 0, errno == EINTR { continue }
            if n < 0 { log.error("lecture de l'hôte impossible (errno \(errno))") }
            return nil
        }
    }

    private func markClosed() {
        lock.lock()
        closed = true
        lock.unlock()
    }
}
