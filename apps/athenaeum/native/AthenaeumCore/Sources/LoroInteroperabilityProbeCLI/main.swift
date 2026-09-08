import Foundation
import LoroInteroperabilityProbeSupport

private enum Exit: Int32 {
    case usage = 2
    case input = 3
    case probe = 4
    case output = 5
}

private struct CLIError: Error {
    let exit: Exit
}

private struct Arguments {
    let snapshot: URL
    let serverVersion: URL?
    let incomingUpdate: URL?
    let update: URL
    let clientVersion: URL
    let text: String
    let operation: String
    let rangeStart: Int?
    let rangeLength: Int?

    init(_ values: [String]) throws {
        var fields: [String: String] = [:]
        var index = 0
        while index < values.count {
            let key = values[index]
            guard ["--snapshot", "--server-version", "--incoming-update", "--update", "--client-version", "--text", "--operation", "--range-start", "--range-length"].contains(key),
                  index + 1 < values.count,
                  fields[key] == nil else {
                throw CLIError(exit: .usage)
            }
            fields[key] = values[index + 1]
            index += 2
        }
        guard let snapshot = fields["--snapshot"],
              let update = fields["--update"],
              let clientVersion = fields["--client-version"],
              let text = fields["--text"] else {
            throw CLIError(exit: .usage)
        }
        self.snapshot = URL(fileURLWithPath: snapshot)
        self.serverVersion = fields["--server-version"].map(URL.init(fileURLWithPath:))
        self.incomingUpdate = fields["--incoming-update"].map(URL.init(fileURLWithPath:))
        self.update = URL(fileURLWithPath: update)
        self.clientVersion = URL(fileURLWithPath: clientVersion)
        self.text = text
        self.operation = fields["--operation"] ?? "append"
        self.rangeStart = fields["--range-start"].flatMap(Int.init)
        self.rangeLength = fields["--range-length"].flatMap(Int.init)
        guard operation == "append" || (operation == "replace" && rangeStart != nil && rangeLength != nil),
              operation != "append" || !text.isEmpty else { throw CLIError(exit: .usage) }
    }
}

private func fail(_ message: String, code: Exit) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    Foundation.exit(code.rawValue)
}

@main
struct LoroInteroperabilityProbeCLI {
    static func main() async {
        let arguments: Arguments
        do {
            arguments = try Arguments(Array(CommandLine.arguments.dropFirst()))
        } catch let error as CLIError {
            fail("usage: loro-interoperability-probe --snapshot <path> [--server-version <path>] [--incoming-update <path>] --update <path> --client-version <path> --text <text> [--operation append|replace --range-start <scalar> --range-length <scalar>]", code: error.exit)
        } catch {
            fail("invalid arguments", code: .usage)
        }

        let snapshot: Data
        let serverVersion: Data?
        let incomingUpdate: Data?
        do {
            snapshot = try Data(contentsOf: arguments.snapshot)
            if let serverVersionURL = arguments.serverVersion {
                serverVersion = try Data(contentsOf: serverVersionURL)
            } else {
                serverVersion = nil
            }
            incomingUpdate = try arguments.incomingUpdate.map { try Data(contentsOf: $0) }
        } catch {
            fail("could not read probe input", code: .input)
        }

        let output: LoroProbeOutput
        do {
            let probe = LoroInteroperabilityProbe()
            if arguments.operation == "replace" {
                output = try await probe.replaceTextUpdate(snapshot: snapshot, serverVersion: serverVersion, incomingUpdate: incomingUpdate, text: arguments.text, rangeStart: arguments.rangeStart!, rangeLength: arguments.rangeLength!)
            } else {
                output = try await probe.makeTextUpdate(snapshot: snapshot, serverVersion: serverVersion, text: arguments.text)
            }
        } catch {
            fail("probe rejected input", code: .probe)
        }

        do {
            try output.update.write(to: arguments.update, options: .atomic)
            try output.clientVersion.write(to: arguments.clientVersion, options: .atomic)
        } catch {
            fail("could not write probe output", code: .output)
        }
    }
}
