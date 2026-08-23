// swift-tools-version:5.9
// AthenaeumCore — plan §"Repo/package layout": "native/AthenaeumCore/ — Swift actors: local
// SQLite authority, Automerge integration, sync client".
//
// Platforms: macOS/iOS only, deliberately NOT watchOS — this package links `automerge-swift`
// (see below), and the Decisions stage's `automerge-swift-spike` proved for real (not assumed —
// inspected the shipped `automergeFFI.xcframework`'s `Info.plist`, then confirmed with
// `xcodebuild -destination 'generic/platform=watchOS'`, which fails with "no library for this
// platform was found") that automerge-swift 0.7.2 ships no watchOS slice. Per the plan's
// load-bearing consequence callout, watchOS Phase 2 support therefore uses `AthenaeumRPC`'s
// structured-record RPC methods directly (plain-text quick-capture, no Automerge doc) — it does
// not, and structurally cannot, depend on `AthenaeumCore`.
import PackageDescription

let package = Package(
    name: "AthenaeumCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "AthenaeumCore", targets: ["AthenaeumCore"]),
        // Phase 2 exit-criterion driver (see `Sources/Phase2ExitCriterionCLI/Phase2Driver.swift`'s
        // top doc comment): a small subcommand CLI that lets an external orchestrator (a shell
        // script driving both this CLI *and* a real browser via chrome-devtools MCP, run process
        // by process so a real-time concurrent web+native edit scenario can be staged step by
        // step) exercise `WorkspaceSyncClient`'s real Automerge sync and structured-feed/epoch-recovery
        // paths against a live backend, without needing a full app UI to automate. Not part of the
        // shipped app — a verification tool, kept in this package because it exercises
        // `AthenaeumCore` directly and needs no dependencies beyond what this package already has.
        .executable(name: "phase2-driver", targets: ["Phase2ExitCriterionCLI"]),
        // Phase 3 exit-criterion driver (see `Sources/Phase3ExitCriterionCLI/Phase3Driver.swift`'s
        // top doc comment): same "small subcommand CLI an external orchestrator drives" shape as
        // `phase2-driver` above, scoped to `AgentEditService`'s chat/pending-changes RPC surface
        // (`WorkspaceRPCClient+AgentEdit.swift`) instead of Automerge/structured sync. No
        // `AthenaeumCore`/local-SQLite dependency needed — a chat has no local-authority
        // counterpart the way a page/node does — so this target depends only on `AthenaeumDomain`/
        // `AthenaeumRPC`, not `AthenaeumCore` itself; kept in this package anyway to sit next to
        // its Phase 2 sibling rather than a third top-level package for one small CLI.
        .executable(name: "phase3-driver", targets: ["Phase3ExitCriterionCLI"]),
        // Phase 4 exit-criterion driver (see `Sources/Phase4ExitCriterionCLI/Phase4Driver.swift`'s
        // top doc comment): same "small subcommand CLI an external orchestrator drives" shape as
        // `phase2-driver`/`phase3-driver` above, scoped to the dev-auth + multi-workspace-catalog +
        // sharing RPC surface (`DevAuthClient`, `UserRPCClient`, `WorkspaceRPCClient+Sharing.swift`).
        // No `AthenaeumCore`/local-SQLite dependency needed — sign-in and workspace-catalog operations
        // have no local-authority counterpart — so, like `phase3-driver`, this target depends only
        // on `AthenaeumDomain`/`AthenaeumRPC`.
        .executable(name: "phase4-driver", targets: ["Phase4ExitCriterionCLI"]),
        // Phase 5 native-stage exit-criterion driver (see
        // `Sources/Phase5ExitCriterionCLI/Phase5Driver.swift`'s top doc comment): same
        // "small subcommand CLI an external orchestrator drives" shape as its three siblings,
        // scoped to the Google Calendar + Bookmarks gatekeeper RPC surface
        // (`WorkspaceRPCClient+Calendar.swift`). No `AthenaeumCore`/local-SQLite dependency needed —
        // calendar events/bookmarks are structured records, not Automerge prose — so, like
        // `phase3-driver`/`phase4-driver`, this target depends only on `AthenaeumDomain`/
        // `AthenaeumRPC`.
        .executable(name: "phase5-driver", targets: ["Phase5ExitCriterionCLI"]),
        // Phase 6 native-stage exit-criterion driver (see
        // `Sources/Phase6ExitCriterionCLI/Phase6Driver.swift`'s top doc comment): same
        // "small subcommand CLI an external orchestrator drives" shape as its four siblings,
        // scoped to the Meetings RPC surface (`WorkspaceRPCClient+Meetings.swift`) plus
        // `AthenaeumCore`'s own `MeetingTranscriptionPipeline`/`Meetings/*` module — the one
        // driver in this family that depends on `AthenaeumCore` for real audio decode + on-device
        // ASR + chunking, not just `AthenaeumDomain`/`AthenaeumRPC`.
        .executable(name: "phase6-driver", targets: ["Phase6ExitCriterionCLI"]),
        // Phase 7 native-stage exit-criterion driver (see
        // `Sources/Phase7ExitCriterionCLI/Phase7Driver.swift`'s top doc comment): same
        // "small subcommand CLI an external orchestrator drives" shape as its five siblings,
        // scoped to the Workouts RPC surface (`WorkspaceRPCClient+Workouts.swift`) plus
        // `AthenaeumCore`'s own `SyntheticWorkoutDataSource`/`WorkoutImportBridge` — depends on
        // `AthenaeumCore` for the real `WorkoutDataSource` protocol/synthetic fixtures, not just
        // `AthenaeumDomain`/`AthenaeumRPC`.
        .executable(name: "phase7-driver", targets: ["Phase7ExitCriterionCLI"])
    ],
    dependencies: [
        .package(name: "AthenaeumDomain", path: "../AthenaeumDomain"),
        .package(name: "AthenaeumRPC", path: "../AthenaeumRPC"),
        // Exact-pinned, matching the Decisions stage's verified spike (`automerge-swift-spike/
        // Package.swift`) and new-notes' own vendoring discipline (plan risk #1: "carry that same
        // vendoring discipline forward, don't assume it's matured").
        .package(url: "https://github.com/automerge/automerge-swift.git", exact: "0.7.2")
    ],
    targets: [
        .target(
            name: "AthenaeumCore",
            dependencies: [
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC"),
                .product(name: "Automerge", package: "automerge-swift")
            ],
            // new-notes' own precedent (`apps/new-notes/apps/native/Package.swift`,
            // `Sources/DailyNotesCore`'s `linkerSettings`) links `sqlite3` directly rather than a
            // package dependency — SQLite ships as a system library on Apple platforms, so this
            // needs a link flag, not a Swift package.
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .testTarget(
            name: "AthenaeumCoreTests",
            dependencies: ["AthenaeumCore"],
            // Real synthesized-speech fixtures for the Meetings/Phase-6 spike (see
            // Sources/AthenaeumCore/Meetings/ and SpeakerClustererTests/AudioChunkerTests'
            // own comments): five `.aiff` files genuinely produced by macOS's `say` command
            // (`say -v Samantha -o samantha_1.aiff "..."`, two different voices, two clips
            // each, plus one near-silent clip) — not synthetic tones. Small (~550 KiB total),
            // committed so these tests are reproducible without depending on this stage's
            // scratchpad directory.
            resources: [.copy("Fixtures")]
        ),
        .executableTarget(
            name: "Phase2ExitCriterionCLI",
            dependencies: [
                "AthenaeumCore",
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC")
            ]
        ),
        .executableTarget(
            name: "Phase3ExitCriterionCLI",
            dependencies: [
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC")
            ]
        ),
        .executableTarget(
            name: "Phase4ExitCriterionCLI",
            dependencies: [
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC")
            ]
        ),
        .executableTarget(
            name: "Phase5ExitCriterionCLI",
            dependencies: [
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC")
            ]
        ),
        .executableTarget(
            name: "Phase6ExitCriterionCLI",
            dependencies: [
                "AthenaeumCore",
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC")
            ]
        ),
        .executableTarget(
            name: "Phase7ExitCriterionCLI",
            dependencies: [
                "AthenaeumCore",
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC")
            ]
        )
    ]
)
