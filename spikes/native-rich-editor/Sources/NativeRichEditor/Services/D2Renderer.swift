import Darwin
import Foundation

enum D2Renderer {
    enum RenderError: LocalizedError {
        case missingBinary, sourceTooLarge, timedOut, invalidOutput
        case compilation(String)

        var errorDescription: String? {
            switch self {
            case .missingBinary:
                return "D2 is not installed. Run script/setup_d2.sh, then rebuild the app."
            case .sourceTooLarge:
                return "This spike supports diagrams up to 200 KB of source."
            case .timedOut:
                return "The diagram took too long to render. Simplify it and try again."
            case .invalidOutput:
                return "D2 did not produce a supported SVG."
            case .compilation(let diagnostic):
                return diagnostic
            }
        }
    }

    static func render(source: String) async throws -> String {
        let work = Task.detached(priority: .userInitiated) {
            try renderOffMainThread(source: source)
        }
        return try await withTaskCancellationHandler {
            try await work.value
        } onCancel: {
            work.cancel()
        }
    }

    private static func binaryURL() throws -> URL {
        var candidates: [URL] = []
        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL.appendingPathComponent("d2"))
        }
        if let configured = ProcessInfo.processInfo.environment["D2_BINARY"], !configured.isEmpty {
            candidates.append(URL(fileURLWithPath: configured))
        }
        candidates.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".tools/d2"))
        guard let binary = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else {
            throw RenderError.missingBinary
        }
        return binary
    }

    private static func renderOffMainThread(source: String) throws -> String {
        try Task.checkCancellation()
        guard source.utf8.count <= 200_000 else { throw RenderError.sourceTooLarge }
        let executable = try binaryURL()
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent("native-note-d2-\(UUID().uuidString)")
        try files.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? files.removeItem(at: directory) }

        let input = directory.appendingPathComponent("diagram.d2")
        let output = directory.appendingPathComponent("diagram.svg")
        let diagnostics = directory.appendingPathComponent("diagnostics.txt")
        try source.write(to: input, atomically: true, encoding: .utf8)
        files.createFile(atPath: diagnostics.path, contents: nil)
        let errorHandle = try FileHandle(forWritingTo: diagnostics)
        defer { try? errorHandle.close() }

        let process = Process()
        process.executableURL = executable
        process.currentDirectoryURL = directory
        process.arguments = ["--layout=dagre", "--pad=24", "--timeout=15", "--watch=false",
                             "--bundle=true", "--target=", input.path, output.path]
        // Do not inherit D2_WATCH, alternate plugins, or other renderer configuration.
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": directory.path, "TMPDIR": directory.path]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        // A file avoids a full stderr pipe blocking the child process.
        process.standardError = errorHandle
        try process.run()

        let deadline = ProcessInfo.processInfo.systemUptime + 17
        while process.isRunning {
            if Task.isCancelled || ProcessInfo.processInfo.systemUptime > deadline {
                process.terminate()
                let terminationDeadline = ProcessInfo.processInfo.systemUptime + 0.25
                while process.isRunning && ProcessInfo.processInfo.systemUptime < terminationDeadline {
                    Thread.sleep(forTimeInterval: 0.01)
                }
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit()
                try Task.checkCancellation()
                throw RenderError.timedOut
            }
            Thread.sleep(forTimeInterval: 0.025)
        }
        process.waitUntilExit()
        try Task.checkCancellation()
        guard process.terminationStatus == 0 else {
            let log = try FileHandle(forReadingFrom: diagnostics)
            defer { try? log.close() }
            let diagnostic = String(decoding: try log.read(upToCount: 16_000) ?? Data(), as: UTF8.self)
                .replacingOccurrences(of: input.path, with: "diagram.d2")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw RenderError.compilation(diagnostic.isEmpty ? "D2 could not compile this diagram." : diagnostic)
        }
        let attributes = try files.attributesOfItem(atPath: output.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= 8_000_000 else {
            throw RenderError.invalidOutput
        }
        let svg = try String(contentsOf: output, encoding: .utf8)
        guard svg.contains("<svg"), svg.contains("</svg>") else { throw RenderError.invalidOutput }
        return svg
    }
}
