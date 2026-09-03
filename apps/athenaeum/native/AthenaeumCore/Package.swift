// swift-tools-version:5.9
// AthenaeumCore — native SQLite authority, Loro replica/durability, and structured sync.
//
// This shipped package is deliberately Loro-only. Legacy Automerge pages remain readable through
// the server-owned projection RPC, but their historical local sync engine is not linked into the
// same process as `loro-swift`; see `LEGACY_AUTOMERGE_VERIFIER.md` for the retired verifier lane.
import PackageDescription

let package = Package(
    name: "AthenaeumCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "AthenaeumCore", targets: ["AthenaeumCore"]),
        .executable(name: "loro-interoperability-probe", targets: ["LoroInteroperabilityProbeCLI"]),
        // Phase 3 exit-criterion driver (see `Sources/Phase3ExitCriterionCLI/Phase3Driver.swift`'s
        // top doc comment): a small subcommand CLI an external orchestrator drives, scoped to
        // `AgentEditService`'s chat/pending-changes RPC surface
        // (`WorkspaceRPCClient+AgentEdit.swift`) instead of Automerge/structured sync. No
        // `AthenaeumCore`/local-SQLite dependency needed — a chat has no local-authority
        // counterpart the way a page/node does — so this target depends only on `AthenaeumDomain`/
        // `AthenaeumRPC`, not `AthenaeumCore` itself; kept in this package anyway to sit next to
        // its neighboring phase drivers rather than a third top-level package for one small CLI.
        .executable(name: "phase3-driver", targets: ["Phase3ExitCriterionCLI"]),
        // Phase 4 exit-criterion driver (see `Sources/Phase4ExitCriterionCLI/Phase4Driver.swift`'s
        // top doc comment): the same small subcommand CLI shape as the neighboring phase drivers,
        // scoped to the dev-auth + multi-workspace-catalog +
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
        // Loro is the authoritative format for newly created pages. The Core package owns the
        // actor-confined replica/durability boundary; routing remains in the sync-client layer.
        .package(url: "https://github.com/loro-dev/loro-swift.git", exact: "1.13.3")
    ],
    targets: [
        .target(
            name: "AthenaeumCore",
            dependencies: [
                .product(name: "AthenaeumDomain", package: "AthenaeumDomain"),
                .product(name: "AthenaeumRPC", package: "AthenaeumRPC"),
                .product(name: "Loro", package: "loro-swift")
            ],
            // new-notes' own precedent (`apps/new-notes/apps/native/Package.swift`,
            // `Sources/DailyNotesCore`'s `linkerSettings`) links `sqlite3` directly rather than a
            // package dependency — SQLite ships as a system library on Apple platforms, so this
            // needs a link flag, not a Swift package.
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        // Verification-only Loro wire-format mechanics. This target deliberately has no
        // library product: application code can depend only on AthenaeumCore's semantic API.
        .target(
            name: "LoroInteroperabilityProbeSupport",
            dependencies: [
                "AthenaeumCore",
                .product(name: "Loro", package: "loro-swift")
            ]
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
        .testTarget(
            name: "LoroInteroperabilityProbeSupportTests",
            dependencies: [
                "LoroInteroperabilityProbeSupport",
                .product(name: "Loro", package: "loro-swift")
            ]
        ),
        .executableTarget(
            name: "LoroInteroperabilityProbeCLI",
            dependencies: ["LoroInteroperabilityProbeSupport"]
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
