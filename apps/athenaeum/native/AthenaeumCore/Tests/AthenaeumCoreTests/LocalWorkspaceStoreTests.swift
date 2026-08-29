import XCTest
import Loro
import CryptoKit
import AthenaeumDomain
@testable import AthenaeumCore

final class LocalWorkspaceStoreTests: XCTestCase {
    private func makeStore() throws -> LocalWorkspaceStore {
        try LocalWorkspaceStore(path: LocalWorkspaceStore.scratchPath(label: UUID().uuidString))
    }

    func testMigrationIsIdempotentAndPersistsUserVersion() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        _ = try LocalWorkspaceStore(path: path)
        // Re-opening the same file must not fail or re-run destructive DDL — the same
        // `if version < currentSchemaVersion` idempotency new-notes' own migration ladder relies
        // on (`SQLiteStore.migrate`), exercised here for real against a real file on disk.
        let reopened = try LocalWorkspaceStore(path: path)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(
            id: try EntityId(validating: UUID().uuidString.lowercased()),
            workspaceId: workspaceId,
            title: "Reopened fine",
            createdAt: try IsoDateTimeString(validating: "2026-08-20T00:00:00Z")
        )
        try await reopened.upsertNode(node)
        let fetched = try await reopened.node(id: node.id)
        XCTAssertEqual(fetched?.title, "Reopened fine")
    }

    func testV1MigrationPreservesLegacyPageBytesAndAddsLoroTable() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let connection = try SQLite3Connection(path: path)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let legacyBytes = Data([0x00, 0xFF, 0x42])
        try connection.exec(
            """
            CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE pages (node_id TEXT PRIMARY KEY, automerge_doc_id TEXT NOT NULL, heads_hash TEXT NOT NULL, doc_bytes BLOB, dirty INTEGER NOT NULL DEFAULT 0);
            INSERT INTO nodes VALUES ('\(nodeId.rawValue)', '\(workspaceId.rawValue)', 'Legacy', '2026-08-20T00:00:00Z', 0);
            """
        )
        try connection.run(
            "INSERT INTO pages VALUES (?, ?, ?, ?, 0);",
            [.text(nodeId.rawValue), .text(nodeId.rawValue), .text("heads"), .blob(legacyBytes)]
        )
        try connection.setUserVersion(1)

        let migrated = try LocalWorkspaceStore(path: path)
        let migratedBytes = try await migrated.pageDocBytes(nodeId: nodeId)
        XCTAssertEqual(migratedBytes, legacyBytes)

        let prepared = try await preparedPage(nodeId: nodeId)
        try await migrated.upsertLoroPage(
            LoroPageLocalState(
                prepared: prepared, dirty: true,
                observedDescriptorStorageVersion: 7, observedDescriptorSnapshotSHA256: hash("b")
            )
        )
        let loroRow = try await migrated.loroPage(nodeId: nodeId)
        XCTAssertEqual(loroRow?.observedDescriptorStorageVersion, 7)
    }

    func testFutureSchemaVersionIsRejected() throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let connection = try SQLite3Connection(path: path)
        try connection.setUserVersion(9)
        XCTAssertThrowsError(try LocalWorkspaceStore(path: path)) { error in
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .unsupportedSchemaVersion(9))
        }
    }

    func testV3MigrationPreservesBytesAndV4LayoutRejectsCorruption() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let connection = try SQLite3Connection(path: path)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let automergeBytes = Data([0, 255, 42])
        let loroBytes = try canonicalSnapshot()
        try connection.exec("""
            CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE pages (node_id TEXT PRIMARY KEY, automerge_doc_id TEXT NOT NULL, heads_hash TEXT NOT NULL, doc_bytes BLOB, dirty INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE loro_pages (node_id TEXT PRIMARY KEY, page_schema_version INTEGER NOT NULL, snapshot_bytes BLOB NOT NULL, local_snapshot_sha256 TEXT NOT NULL, dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)), observed_descriptor_storage_version INTEGER NOT NULL, observed_descriptor_snapshot_sha256 TEXT NOT NULL);
            INSERT INTO nodes VALUES ('\(nodeId.rawValue)', '\(workspaceId.rawValue)', 'v3', '2026-08-20T00:00:00Z', 0);
            """)
        try connection.run("INSERT INTO pages VALUES (?, ?, ?, ?, 0);", [.text(nodeId.rawValue), .text(nodeId.rawValue), .text("heads"), .blob(automergeBytes)])
        try connection.run("INSERT INTO loro_pages VALUES (?, 1, ?, ?, 0, 1, ?);", [.text(nodeId.rawValue), .blob(loroBytes), .text(hash()), .text(hash("b"))])
        try connection.setUserVersion(3)
        let migrated = try LocalWorkspaceStore(path: path)
        let migratedAutomerge = try await migrated.pageDocBytes(nodeId: nodeId)
        let migratedLoro = try await migrated.loroPage(nodeId: nodeId)
        XCTAssertEqual(migratedAutomerge, automergeBytes)
        XCTAssertEqual(migratedLoro?.snapshotBytes, loroBytes)

        // Reopen a deliberately malformed v4 database.
        let corruptPath = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let corrupt = try SQLite3Connection(path: corruptPath)
        try corrupt.exec("CREATE TABLE loro_semantic_checkpoints (workspace_id TEXT, node_id TEXT);")
        try corrupt.setUserVersion(4)
        XCTAssertThrowsError(try LocalWorkspaceStore(path: corruptPath)) { error in
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroCheckpoint)
        }

        let v5CorruptPath = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let v5Corrupt = try SQLite3Connection(path: v5CorruptPath)
        try v5Corrupt.exec("CREATE TABLE loro_semantic_checkpoints_v5 (workspace_id TEXT NOT NULL, node_id TEXT NOT NULL, state TEXT NOT NULL, request_id TEXT NOT NULL, commit_message TEXT NOT NULL, attribution_kind TEXT NOT NULL, attribution_one TEXT NOT NULL, attribution_two TEXT, route_storage_version INTEGER NOT NULL, route_schema_version INTEGER NOT NULL, route_snapshot_sha256 TEXT NOT NULL, update_bytes BLOB NOT NULL, update_sha256 TEXT NOT NULL, base_version_vector BLOB NOT NULL, base_version_vector_sha256 TEXT NOT NULL, PRIMARY KEY (workspace_id, node_id));")
        try v5Corrupt.setUserVersion(5)
        XCTAssertThrowsError(try LocalWorkspaceStore(path: v5CorruptPath)) { error in
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroCheckpoint)
        }
    }

    func testV4CheckpointMigrationPreservesPopulatedRowsAndRollsBackMalformedSource() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let connection = try SQLite3Connection(path: path)
        let workspace = try EntityId(validating: UUID().uuidString.lowercased()), node = try EntityId(validating: UUID().uuidString.lowercased())
        let update = Data([1, 2, 3])
        let prepared = try await LoroPageDocumentStore().prepare(nodeId: node, snapshot: canonicalSnapshot())
        let version = prepared.versionBytes
        try connection.exec("""
            CREATE TABLE loro_pages (node_id TEXT PRIMARY KEY, page_schema_version INTEGER NOT NULL, snapshot_bytes BLOB NOT NULL, local_snapshot_sha256 TEXT NOT NULL, dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)), observed_descriptor_storage_version INTEGER NOT NULL, observed_descriptor_snapshot_sha256 TEXT NOT NULL);
            """)
        try connection.exec(v4CheckpointDDL)
        let versionDigest = try VersionVectorIdentity.digest(encodedVersionVector: version)
        try connection.run("INSERT INTO loro_semantic_checkpoints VALUES (?, ?, 'inFlight', 'request', 'commit', 'humanUi', 'macos', NULL, 1, 1, ?, ?, ?, ?, ?);", [.text(workspace.rawValue), .text(node.rawValue), .text(hash()), .blob(update), .text(sha(update)), .blob(version), .text(versionDigest)])
        try connection.setUserVersion(4)
        let migrated = try LocalWorkspaceStore(path: path)
        let migratedCheckpoint = try await migrated.loroCheckpoint(workspaceId: workspace, nodeId: node)
        let disposition = try await migrated.loroCheckpointDisposition(workspaceId: workspace, nodeId: node)
        XCTAssertNil(migratedCheckpoint)
        XCTAssertEqual(disposition, .migratedV5Quarantined(.init(workspaceId: workspace, nodeId: node)))
        XCTAssertEqual(try connection.userVersion(), 8)
        XCTAssertEqual(try connection.query("SELECT COUNT(*) FROM loro_semantic_checkpoints_v5;") { columnInt($0, 0) }.first, 1)
        XCTAssertEqual(try connection.query("SELECT COUNT(*) FROM loro_semantic_candidates_v6;") { columnInt($0, 0) }.first, 0)
        XCTAssertEqual(try connection.query("SELECT COUNT(*) FROM loro_semantic_candidates_v7;") { columnInt($0, 0) }.first, 0)
        XCTAssertEqual(try connection.query("SELECT COUNT(*) FROM loro_semantic_checkpoint_archive_v7;") { columnInt($0, 0) }.first, 0)

        let malformedPath = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let malformed = try SQLite3Connection(path: malformedPath)
        try malformed.exec(v4CheckpointDDL)
        try malformed.run("INSERT INTO loro_semantic_checkpoints VALUES (?, ?, 'inFlight', 'request', 'commit', 'humanUi', 'macos', NULL, 1, 1, ?, ?, ?, ?, ?);", [.text(workspace.rawValue), .text(node.rawValue), .text(hash()), .blob(update), .text(String(repeating: "0", count: 64)), .blob(version), .text(versionDigest)])
        try malformed.setUserVersion(4)
        XCTAssertThrowsError(try LocalWorkspaceStore(path: malformedPath))
        XCTAssertEqual(try malformed.userVersion(), 4)
        XCTAssertEqual(try malformed.query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='loro_semantic_checkpoints_v5';") { columnInt($0, 0) }.first, 0)

        let unconstrainedPath = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let unconstrained = try SQLite3Connection(path: unconstrainedPath)
        try unconstrained.exec("""
            CREATE TABLE loro_semantic_checkpoints (
                workspace_id TEXT NOT NULL, node_id TEXT NOT NULL, state TEXT NOT NULL,
                request_id TEXT NOT NULL, commit_message TEXT NOT NULL, attribution_kind TEXT NOT NULL,
                attribution_one TEXT NOT NULL, attribution_two TEXT, route_storage_version INTEGER NOT NULL,
                route_schema_version INTEGER NOT NULL, route_snapshot_sha256 TEXT NOT NULL, update_bytes BLOB NOT NULL,
                update_sha256 TEXT NOT NULL, base_version_vector BLOB NOT NULL, base_version_vector_sha256 TEXT NOT NULL,
                PRIMARY KEY (workspace_id, node_id)
            );
            """)
        try unconstrained.setUserVersion(4)
        XCTAssertThrowsError(try LocalWorkspaceStore(path: unconstrainedPath)) { error in
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroCheckpoint)
        }
        XCTAssertEqual(try unconstrained.userVersion(), 4)
        XCTAssertEqual(try unconstrained.query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='loro_semantic_checkpoints_v5';") { columnInt($0, 0) }.first, 0)
    }

    func testV6MigrationPreservesQuarantinedRowsWithoutActivatingOrArchiving() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let connection = try SQLite3Connection(path: path)
        let workspace = try EntityId(validating: UUID().uuidString.lowercased())
        let node = try EntityId(validating: UUID().uuidString.lowercased())
        let prepared = try await LoroPageDocumentStore().prepare(nodeId: node, snapshot: canonicalSnapshot())
        let update = Data([0x01, 0x02, 0x03])
        let vectorDigest = try VersionVectorIdentity.digest(encodedVersionVector: prepared.versionBytes)

        try connection.exec("""
            CREATE TABLE loro_pages (
                node_id TEXT PRIMARY KEY, page_schema_version INTEGER NOT NULL,
                snapshot_bytes BLOB NOT NULL, local_snapshot_sha256 TEXT NOT NULL,
                dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
                observed_descriptor_storage_version INTEGER NOT NULL,
                observed_descriptor_snapshot_sha256 TEXT NOT NULL
            );
            """)
        try connection.exec(v5CheckpointDDL)
        try connection.exec(v6CandidateDDL)
        try connection.run("""
            INSERT INTO loro_semantic_candidates_v6 (
                workspace_id,node_id,state,request_id,commit_message,attribution_kind,attribution_one,attribution_two,
                route_storage_version,route_schema_version,route_snapshot_sha256,update_bytes,update_sha256,
                base_version_vector,base_version_vector_sha256,candidate_snapshot,candidate_snapshot_sha256,
                candidate_result_version_vector,candidate_result_version_vector_sha256,
                expected_result_storage_version,expected_result_schema_version,expected_result_snapshot_sha256
            ) VALUES (?, ?, 'retainedRetry', 'v6-request', 'legacy v6', 'humanUi', 'macos', NULL,
                1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 1, ?);
            """, [
                .text(workspace.rawValue), .text(node.rawValue),
                .text(prepared.localSnapshotSHA256), .blob(update), .text(sha(update)),
                .blob(prepared.versionBytes), .text(vectorDigest),
                .blob(prepared.snapshotBytes), .text(prepared.localSnapshotSHA256),
                .blob(prepared.versionBytes), .text(vectorDigest),
                .text(prepared.localSnapshotSHA256)
            ])
        try connection.setUserVersion(6)
        let before = try rawV6Candidate(connection, workspace: workspace, node: node)

        let migrated = try LocalWorkspaceStore(path: path)
        XCTAssertEqual(try connection.userVersion(), 8)
        XCTAssertEqual(try rawV6Candidate(connection, workspace: workspace, node: node), before)
        let active = try await migrated.loroCheckpoint(workspaceId: workspace, nodeId: node)
        let evidence = try await migrated.frozenCandidateEvidence(workspaceId: workspace, nodeId: node)
        let disposition = try await migrated.loroCheckpointDisposition(workspaceId: workspace, nodeId: node)
        XCTAssertNil(active)
        XCTAssertNil(evidence)
        XCTAssertEqual(disposition, .migratedV6Quarantined(.init(workspaceId: workspace, nodeId: node)))
        XCTAssertEqual(try connection.query("SELECT COUNT(*) FROM loro_semantic_candidates_v7;") { columnInt($0, 0) }.first, 0)
        XCTAssertEqual(try connection.query("SELECT COUNT(*) FROM loro_semantic_checkpoint_archive_v7;") { columnInt($0, 0) }.first, 0)

        let reopened = try LocalWorkspaceStore(path: path)
        XCTAssertEqual(try rawV6Candidate(connection, workspace: workspace, node: node), before)
        let reopenedDisposition = try await reopened.loroCheckpointDisposition(workspaceId: workspace, nodeId: node)
        XCTAssertEqual(reopenedDisposition, .migratedV6Quarantined(.init(workspaceId: workspace, nodeId: node)))
    }

    func testV2MigrationRenamesDescriptorWitnessColumnsAndPreservesLegacyPages() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let connection = try SQLite3Connection(path: path)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let legacyBytes = Data([0x2A, 0x00, 0xFF])
        let snapshot = try canonicalSnapshot()
        try connection.exec(
            """
            CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE pages (node_id TEXT PRIMARY KEY, automerge_doc_id TEXT NOT NULL, heads_hash TEXT NOT NULL, doc_bytes BLOB, dirty INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE loro_pages (
                node_id TEXT PRIMARY KEY, page_schema_version INTEGER NOT NULL, snapshot_bytes BLOB NOT NULL,
                local_snapshot_sha256 TEXT NOT NULL, dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
                server_storage_version INTEGER NOT NULL, server_snapshot_sha256 TEXT NOT NULL
            );
            INSERT INTO nodes VALUES ('\(nodeId.rawValue)', '\(workspaceId.rawValue)', 'v2', '2026-08-20T00:00:00Z', 0);
            """
        )
        try connection.run("INSERT INTO pages VALUES (?, ?, ?, ?, 0);", [.text(nodeId.rawValue), .text(nodeId.rawValue), .text("heads"), .blob(legacyBytes)])
        try connection.run(
            "INSERT INTO loro_pages VALUES (?, 1, ?, ?, 1, 9, ?);",
            [.text(nodeId.rawValue), .blob(snapshot), .text(hash()), .text(hash("b"))]
        )
        try connection.setUserVersion(2)

        let migrated = try LocalWorkspaceStore(path: path)
        let migratedLegacyBytes = try await migrated.pageDocBytes(nodeId: nodeId)
        XCTAssertEqual(migratedLegacyBytes, legacyBytes)
        let row = try await migrated.loroPage(nodeId: nodeId)
        XCTAssertEqual(row?.snapshotBytes, snapshot)
        XCTAssertEqual(row?.observedDescriptorStorageVersion, 9)
        XCTAssertEqual(row?.observedDescriptorSnapshotSHA256, hash("b"))

        let prepared = try await LoroPageDocumentStore().prepare(nodeId: nodeId, snapshot: snapshot)
        try await migrated.upsertLoroPage(LoroPageLocalState(prepared: prepared, dirty: false, observedDescriptorStorageVersion: 10, observedDescriptorSnapshotSHA256: hash("c")))
        let rewrittenRow = try await migrated.loroPage(nodeId: nodeId)
        XCTAssertEqual(rewrittenRow?.observedDescriptorStorageVersion, 10)
    }

    func testObservedV2MigrationPreservesPopulatedLoroRowWithoutRebuild() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let connection = try SQLite3Connection(path: path)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let legacyBytes = Data([0xAB, 0xCD])
        let snapshot = try canonicalSnapshot()
        let localDigest = hash("b")
        let observedDigest = hash("e")
        try connection.exec(
            """
            CREATE TABLE nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE pages (node_id TEXT PRIMARY KEY, automerge_doc_id TEXT NOT NULL, heads_hash TEXT NOT NULL, doc_bytes BLOB, dirty INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE loro_pages (
                node_id TEXT PRIMARY KEY, page_schema_version INTEGER NOT NULL, snapshot_bytes BLOB NOT NULL,
                local_snapshot_sha256 TEXT NOT NULL, dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
                observed_descriptor_storage_version INTEGER NOT NULL,
                observed_descriptor_snapshot_sha256 TEXT NOT NULL
            );
            INSERT INTO nodes VALUES ('\(nodeId.rawValue)', '\(workspaceId.rawValue)', 'observed v2', '2026-08-20T00:00:00Z', 0);
            """
        )
        try connection.run("INSERT INTO pages VALUES (?, ?, ?, ?, 0);", [.text(nodeId.rawValue), .text(nodeId.rawValue), .text("heads"), .blob(legacyBytes)])
        try connection.run(
            "INSERT INTO loro_pages VALUES (?, 1, ?, ?, 1, 12, ?);",
            [.text(nodeId.rawValue), .blob(snapshot), .text(localDigest), .text(observedDigest)]
        )
        try connection.setUserVersion(2)

        let migrated = try LocalWorkspaceStore(path: path)
        let migratedLegacyBytes = try await migrated.pageDocBytes(nodeId: nodeId)
        XCTAssertEqual(migratedLegacyBytes, legacyBytes)
        let row = try await migrated.loroPage(nodeId: nodeId)
        XCTAssertEqual(row?.snapshotBytes, snapshot)
        XCTAssertEqual(row?.localSnapshotSHA256, localDigest)
        XCTAssertEqual(row?.observedDescriptorStorageVersion, 12)
        XCTAssertEqual(row?.observedDescriptorSnapshotSHA256, observedDigest)

        // Reopening proves the no-rebuild path advanced user_version transactionally.
        let reopened = try LocalWorkspaceStore(path: path)
        let reopenedRow = try await reopened.loroPage(nodeId: nodeId)
        XCTAssertEqual(reopenedRow?.snapshotBytes, snapshot)
    }

    func testPreparedCandidateCannotBeRetargetedToAnotherNode() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeA = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeB = try EntityId(validating: UUID().uuidString.lowercased())
        try await store.upsertNode(Node(id: nodeA, workspaceId: workspaceId, title: "A", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
        try await store.upsertNode(Node(id: nodeB, workspaceId: workspaceId, title: "B", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
        let cache = LoroPageDocumentStore()
        let preparedForA = try await preparedPage(nodeId: nodeA, store: cache)
        let state = LoroPageLocalState(prepared: preparedForA, dirty: true, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: hash("b"))

        // There is intentionally no node-id argument here: the candidate's actor-issued node
        // binding is the SQL key. A caller asking to store it under B cannot retarget it.
        XCTAssertEqual(state.nodeId, nodeA)
        XCTAssertNotEqual(state.nodeId, nodeB)
        try await store.upsertLoroPage(state)
        try await cache.publish(nodeId: state.nodeId, prepared: preparedForA)
        let persistedB = try await store.loroPage(nodeId: nodeB)
        let cachedB = try await cache.publishedState(nodeId: nodeB)
        let persistedA = try await store.loroPage(nodeId: nodeA)
        XCTAssertNil(persistedB)
        XCTAssertNil(cachedB)
        XCTAssertEqual(persistedA?.snapshotBytes, preparedForA.snapshotBytes)
    }

    func testLoroPageRequiresExistingNode() async throws {
        let store = try makeStore()
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let prepared = try await preparedPage(nodeId: nodeId)
        let state = LoroPageLocalState(
            prepared: prepared, dirty: true,
            observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: hash("b")
        )
        do {
            try await store.upsertLoroPage(state)
            XCTFail("expected nodeNotFound")
        } catch LocalWorkspaceStoreError.nodeNotFound(let id) {
            XCTAssertEqual(id, nodeId)
        }
    }

    func testLoroSnapshotSurvivesSQLiteReopen() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let store = try LocalWorkspaceStore(path: path)
        try await store.upsertNode(
            Node(id: nodeId, workspaceId: workspaceId, title: "Loro", createdAt: "2026-08-20T00:00:00Z"),
            dirty: false
        )
        let documentStore = LoroPageDocumentStore()
        let prepared = try await preparedPage(nodeId: nodeId, store: documentStore)
        try await store.upsertLoroPage(
            LoroPageLocalState(
                prepared: prepared, dirty: true,
                observedDescriptorStorageVersion: 2, observedDescriptorSnapshotSHA256: hash("b")
            )
        )

        let reopened = try LocalWorkspaceStore(path: path)
        let persisted = try await reopened.loroPage(nodeId: nodeId)
        XCTAssertEqual(persisted?.snapshotBytes, prepared.snapshotBytes)
        XCTAssertEqual(persisted?.localSnapshotSHA256, prepared.localSnapshotSHA256)
        let rehydrated = try await LoroPageDocumentStore().prepare(nodeId: nodeId, snapshot: try XCTUnwrap(persisted?.snapshotBytes))
        XCTAssertEqual(rehydrated.versionBytes, prepared.versionBytes)
    }

    func testLoroPageStrictlyRejectsCorruptDurableScalarsWithoutWriting() async throws {
        let corruptions: [(String, String, [SQLiteValue])] = [
            ("malformed local hash", "local_snapshot_sha256 = ?", [.text("not-a-sha256")]),
            ("blob local hash", "local_snapshot_sha256 = ?", [.blob(Data(repeating: 0x61, count: 64))]),
            ("malformed observed hash", "observed_descriptor_snapshot_sha256 = ?", [.text("ABC")]),
            ("zero page schema", "page_schema_version = ?", [.int(0)]),
            ("zero observed storage version", "observed_descriptor_storage_version = ?", [.int(0)]),
            ("invalid dirty encoding", "dirty = ?", [.int(2)]),
            ("empty snapshot", "snapshot_bytes = ?", [.blob(Data())])
        ]

        for (name, assignment, values) in corruptions {
            let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
            let store = try LocalWorkspaceStore(path: path)
            let workspace = try EntityId(validating: UUID().uuidString.lowercased())
            let node = try EntityId(validating: UUID().uuidString.lowercased())
            try await store.upsertNode(Node(id: node, workspaceId: workspace, title: name, createdAt: "2026-08-20T00:00:00Z"), dirty: false)
            let prepared = try await preparedPage(nodeId: node)
            try await store.upsertLoroPage(.init(prepared: prepared, dirty: false, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: prepared.localSnapshotSHA256))

            let connection = try SQLite3Connection(path: path)
            try connection.exec("PRAGMA ignore_check_constraints = ON;")
            try connection.run("UPDATE loro_pages SET \(assignment) WHERE node_id = ?;", values + [.text(node.rawValue)])
            try connection.exec("PRAGMA ignore_check_constraints = OFF;")
            let rawBefore = try rawLoroPage(connection, nodeId: node)

            do {
                _ = try await store.loroPage(nodeId: node)
                XCTFail("\(name) must be rejected")
            } catch {
                XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroPageState)
            }
            XCTAssertEqual(try rawLoroPage(connection, nodeId: node), rawBefore, "\(name) must not cause a repair write")
        }
    }

    func testLoroPageRejectsHashWithEmbeddedNULWithoutWriting() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let store = try LocalWorkspaceStore(path: path)
        let workspace = try EntityId(validating: UUID().uuidString.lowercased())
        let node = try EntityId(validating: UUID().uuidString.lowercased())
        try await store.upsertNode(Node(id: node, workspaceId: workspace, title: "embedded NUL", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
        let prepared = try await preparedPage(nodeId: node)
        try await store.upsertLoroPage(.init(prepared: prepared, dirty: false, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: prepared.localSnapshotSHA256))
        let connection = try SQLite3Connection(path: path)
        try connection.run("UPDATE loro_pages SET local_snapshot_sha256 = ? || char(0) || 'suffix' WHERE node_id = ?;", [.text(prepared.localSnapshotSHA256), .text(node.rawValue)])
        let rawBefore = try rawLoroPage(connection, nodeId: node)

        do {
            _ = try await store.loroPage(nodeId: node)
            XCTFail("an embedded NUL must not be truncated into a valid hash")
        } catch {
            XCTAssertEqual(error as? LocalWorkspaceStoreError, .invalidLoroPageState)
        }
        XCTAssertEqual(try rawLoroPage(connection, nodeId: node), rawBefore)
    }

    func testInjectedLoroWriteFailureDoesNotReplacePublishedCache() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let durable = try LocalWorkspaceStore(path: path)
        try await durable.upsertNode(Node(id: nodeId, workspaceId: workspaceId, title: "Loro", createdAt: "2026-08-20T00:00:00Z"), dirty: false)
        let documentStore = LoroPageDocumentStore()
        let prepared = try await preparedPage(nodeId: nodeId, store: documentStore)
        try await durable.upsertLoroPage(LoroPageLocalState(prepared: prepared, dirty: true, observedDescriptorStorageVersion: 1, observedDescriptorSnapshotSHA256: hash("b")))
        try await documentStore.publish(nodeId: nodeId, prepared: prepared)

        let failing = try LocalWorkspaceStore(path: path, failLoroPageWrites: true)
        do {
            try await failing.upsertLoroPage(LoroPageLocalState(prepared: prepared, dirty: true, observedDescriptorStorageVersion: 2, observedDescriptorSnapshotSHA256: hash("c")))
            XCTFail("expected injected write failure")
        } catch let error as LocalWorkspaceStoreError {
            XCTAssertEqual(error, .injectedLoroWriteFailure)
        }
        let published = try await documentStore.publishedState(nodeId: nodeId)
        XCTAssertEqual(published?.snapshotBytes, prepared.snapshotBytes)
        let durableState = try await durable.loroPage(nodeId: nodeId)
        XCTAssertEqual(durableState?.observedDescriptorStorageVersion, 1)
    }

    private func hash(_ character: Character = "a") -> String { String(repeating: String(character), count: 64) }
    private func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private func rawLoroPage(_ connection: SQLite3Connection, nodeId: EntityId) throws -> [String] {
        try connection.query(
            "SELECT typeof(page_schema_version), length(snapshot_bytes), local_snapshot_sha256, typeof(dirty), dirty, typeof(observed_descriptor_storage_version), observed_descriptor_storage_version, observed_descriptor_snapshot_sha256 FROM loro_pages WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in
            [columnText(statement, 0), String(columnInt(statement, 1)), columnText(statement, 2), columnText(statement, 3), String(columnInt(statement, 4)), columnText(statement, 5), String(columnInt(statement, 6)), columnText(statement, 7)]
        }.first ?? []
    }

    private func rawV6Candidate(_ connection: SQLite3Connection, workspace: EntityId, node: EntityId) throws -> [String] {
        try connection.query(
            """
            SELECT state,request_id,commit_message,hex(update_bytes),update_sha256,
                   hex(base_version_vector),base_version_vector_sha256,
                   hex(candidate_snapshot),candidate_snapshot_sha256,
                   hex(candidate_result_version_vector),candidate_result_version_vector_sha256,
                   expected_result_storage_version,expected_result_schema_version,expected_result_snapshot_sha256
            FROM loro_semantic_candidates_v6 WHERE workspace_id=? AND node_id=?;
            """,
            [.text(workspace.rawValue), .text(node.rawValue)]
        ) { statement in
            [
                columnText(statement, 0), columnText(statement, 1), columnText(statement, 2),
                columnText(statement, 3), columnText(statement, 4), columnText(statement, 5),
                columnText(statement, 6), columnText(statement, 7), columnText(statement, 8),
                columnText(statement, 9), columnText(statement, 10), String(columnInt(statement, 11)),
                String(columnInt(statement, 12)), columnText(statement, 13)
            ]
        }.first ?? []
    }

    private var v4CheckpointDDL: String { """
    CREATE TABLE loro_semantic_checkpoints (
        workspace_id TEXT NOT NULL, node_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),
        request_id TEXT NOT NULL, commit_message TEXT NOT NULL,
        attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),
        attribution_one TEXT NOT NULL, attribution_two TEXT,
        route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0), route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),
        route_snapshot_sha256 TEXT NOT NULL, update_bytes BLOB NOT NULL, update_sha256 TEXT NOT NULL,
        base_version_vector BLOB NOT NULL, base_version_vector_sha256 TEXT NOT NULL,
        PRIMARY KEY (workspace_id, node_id), UNIQUE (node_id),
        CHECK (length(request_id) BETWEEN 1 AND 200), CHECK (length(commit_message) BETWEEN 1 AND 500),
        CHECK (length(update_bytes) BETWEEN 1 AND 2097152), CHECK (length(base_version_vector) BETWEEN 1 AND 65536),
        CHECK (length(route_snapshot_sha256) = 64), CHECK (length(update_sha256) = 64), CHECK (length(base_version_vector_sha256) = 64),
        CHECK ((attribution_kind = 'agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind != 'agentJob' AND attribution_two IS NULL))
    );
    """ }

    private var v5CheckpointDDL: String { """
    CREATE TABLE loro_semantic_checkpoints_v5 (workspace_id TEXT NOT NULL,node_id TEXT NOT NULL,state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),request_id TEXT NOT NULL,commit_message TEXT NOT NULL,attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),attribution_one TEXT NOT NULL,attribution_two TEXT,route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0),route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),route_snapshot_sha256 TEXT NOT NULL,update_bytes BLOB NOT NULL,update_sha256 TEXT NOT NULL,base_version_vector BLOB NOT NULL,base_version_vector_sha256 TEXT NOT NULL,PRIMARY KEY (workspace_id,node_id),CHECK(length(request_id) BETWEEN 1 AND 200),CHECK(length(commit_message) BETWEEN 1 AND 500),CHECK(length(update_bytes) BETWEEN 1 AND 2097152),CHECK(length(base_version_vector) BETWEEN 1 AND 65536),CHECK(length(route_snapshot_sha256)=64),CHECK(length(update_sha256)=64),CHECK(length(base_version_vector_sha256)=64),CHECK((attribution_kind='agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind!='agentJob' AND attribution_two IS NULL)));
    """ }

    private var v6CandidateDDL: String { """
    CREATE TABLE loro_semantic_candidates_v6 (workspace_id TEXT NOT NULL,node_id TEXT NOT NULL,state TEXT NOT NULL CHECK (state IN ('inFlight','retainedRetry','retainedConflict','retainedRequestIdentity')),request_id TEXT NOT NULL,commit_message TEXT NOT NULL,attribution_kind TEXT NOT NULL CHECK (attribution_kind IN ('humanUi','agentJob','system')),attribution_one TEXT NOT NULL,attribution_two TEXT,route_storage_version INTEGER NOT NULL CHECK (route_storage_version > 0 AND route_storage_version < 9223372036854775807),route_schema_version INTEGER NOT NULL CHECK (route_schema_version > 0),route_snapshot_sha256 TEXT NOT NULL,update_bytes BLOB NOT NULL,update_sha256 TEXT NOT NULL,base_version_vector BLOB NOT NULL,base_version_vector_sha256 TEXT NOT NULL,candidate_snapshot BLOB NOT NULL,candidate_snapshot_sha256 TEXT NOT NULL,candidate_result_version_vector BLOB NOT NULL,candidate_result_version_vector_sha256 TEXT NOT NULL,expected_result_storage_version INTEGER NOT NULL CHECK (expected_result_storage_version = route_storage_version + 1),expected_result_schema_version INTEGER NOT NULL CHECK (expected_result_schema_version = route_schema_version),expected_result_snapshot_sha256 TEXT NOT NULL,PRIMARY KEY (workspace_id,node_id),CHECK(length(request_id) BETWEEN 1 AND 200),CHECK(length(commit_message) BETWEEN 1 AND 500),CHECK(length(update_bytes) BETWEEN 1 AND 2097152),CHECK(length(base_version_vector) BETWEEN 1 AND 65536),CHECK(length(candidate_snapshot) BETWEEN 1 AND 8388608),CHECK(length(candidate_result_version_vector) BETWEEN 1 AND 65536),CHECK(length(route_snapshot_sha256)=64),CHECK(length(update_sha256)=64),CHECK(length(base_version_vector_sha256)=64),CHECK(length(candidate_snapshot_sha256)=64),CHECK(length(candidate_result_version_vector_sha256)=64),CHECK(length(expected_result_snapshot_sha256)=64),CHECK((attribution_kind='agentJob' AND attribution_two IS NOT NULL) OR (attribution_kind!='agentJob' AND attribution_two IS NULL)));
    """ }

    private func canonicalSnapshot() throws -> Data {
        let doc = LoroDoc()
        try doc.getMap(id: "athenaeum-page-meta-v1").insert(key: "schemaVersion", v: 1)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        try root.insert(key: "nodeName", v: "doc")
        _ = try root.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        _ = try root.getOrCreateListContainer(key: "children", child: LoroList())
        doc.commit()
        return try doc.export(mode: .snapshot)
    }

    private func preparedPage(nodeId: EntityId, store: LoroPageDocumentStore = LoroPageDocumentStore()) async throws -> LoroPreparedPageState {
        let doc = LoroDoc()
        try doc.getMap(id: "athenaeum-page-meta-v1").insert(key: "schemaVersion", v: 1)
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        try root.insert(key: "nodeName", v: "doc")
        _ = try root.getOrCreateMapContainer(key: "attributes", child: LoroMap())
        _ = try root.getOrCreateListContainer(key: "children", child: LoroList())
        doc.commit()
        return try await store.prepare(nodeId: nodeId, snapshot: try doc.export(mode: .snapshot))
    }

    func testNodeUpsertAndDirtyBookkeeping() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(
            id: try EntityId(validating: UUID().uuidString.lowercased()),
            workspaceId: workspaceId,
            title: "Local first",
            createdAt: try IsoDateTimeString(validating: "2026-08-20T00:00:00Z")
        )
        try await store.upsertNode(node, dirty: true)

        let dirty = try await store.listDirtyNodes(workspaceId: workspaceId)
        XCTAssertEqual(dirty.map(\.id), [node.id])

        try await store.markNodeSynced(id: node.id)
        let stillDirty = try await store.listDirtyNodes(workspaceId: workspaceId)
        XCTAssertTrue(stillDirty.isEmpty)

        let fetched = try await store.node(id: node.id)
        XCTAssertEqual(fetched, node)

        let listed = try await store.listNodes(workspaceId: workspaceId)
        XCTAssertEqual(listed, [node])
    }

    func testPageRequiresExistingNode() async throws {
        let store = try makeStore()
        let missingNodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let page = Page(nodeId: missingNodeId, automergeDocId: missingNodeId.rawValue, headsHash: "abc")

        do {
            try await store.upsertPage(page, docBytes: nil)
            XCTFail("expected nodeNotFound")
        } catch LocalWorkspaceStoreError.nodeNotFound(let id) {
            XCTAssertEqual(id, missingNodeId)
        }
    }

    func testPageDocBytesRoundTrip() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(id: nodeId, workspaceId: workspaceId, title: "Has a page", createdAt: "2026-08-20T00:00:00Z")
        try await store.upsertNode(node, dirty: false)

        let bytes = Data([0x01, 0x02, 0x03, 0xFF])
        let page = Page(nodeId: nodeId, automergeDocId: nodeId.rawValue, headsHash: "hash-1")
        try await store.upsertPage(page, docBytes: bytes, dirty: true)

        let storedBytes1 = try await store.pageDocBytes(nodeId: nodeId)
        XCTAssertEqual(storedBytes1, bytes)
        let storedPage1 = try await store.page(nodeId: nodeId)
        XCTAssertEqual(storedPage1?.headsHash, "hash-1")

        // Updating the reference row without new bytes (`docBytes: nil`) must not clobber the
        // previously-stored blob — `upsertPage`'s `COALESCE(excluded.doc_bytes, pages.doc_bytes)`.
        let updated = Page(nodeId: nodeId, automergeDocId: nodeId.rawValue, headsHash: "hash-2")
        try await store.upsertPage(updated, docBytes: nil, dirty: false)
        let storedBytes2 = try await store.pageDocBytes(nodeId: nodeId)
        XCTAssertEqual(storedBytes2, bytes)
        let storedPage2 = try await store.page(nodeId: nodeId)
        XCTAssertEqual(storedPage2?.headsHash, "hash-2")
    }

    func testPageDirtyBitIsObservableForLegacyProjectionAdmission() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(id: nodeId, workspaceId: workspaceId, title: "Legacy", createdAt: "2026-08-20T00:00:00Z")
        try await store.upsertNode(node, dirty: false)
        let page = Page(nodeId: nodeId, automergeDocId: nodeId.rawValue, headsHash: "hash")

        try await store.upsertPage(page, docBytes: Data([0x01]), dirty: true)
        let dirty = try await store.isPageDirty(nodeId: nodeId)
        XCTAssertTrue(dirty)

        try await store.markPageSynced(nodeId: nodeId)
        let clean = try await store.isPageDirty(nodeId: nodeId)
        XCTAssertFalse(clean)
    }

    func testLegacyProjectionWitnessStoresSameLoadBindingAndSurvivesRestart() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(id: nodeId, workspaceId: workspaceId, title: "Legacy projection", createdAt: "2026-08-20T00:00:00Z")
        let store = try LocalWorkspaceStore(path: path)
        try await store.upsertNode(node, dirty: false)

        let witness = (storageVersion: 11, docId: "legacy-doc", headsHash: "heads-11", bytesSha256: sha(Data([0x11, 0x22])))
        let first = try await store.persistLegacyProjectionWitness(
            nodeId: nodeId,
            storageVersion: witness.storageVersion,
            docId: witness.docId,
            headsHash: witness.headsHash,
            bytesSha256: witness.bytesSha256
        )
        XCTAssertEqual(
            first,
            .persisted(.init(nodeId: nodeId, storageVersion: witness.storageVersion, docId: witness.docId, headsHash: witness.headsHash, bytesSha256: witness.bytesSha256))
        )
        let storedState = try await store.legacyPageState(nodeId: nodeId)
        XCTAssertEqual(
            storedState,
            .init(page: Page(nodeId: nodeId, automergeDocId: witness.docId, headsHash: witness.headsHash), docBytes: nil, dirty: false)
        )

        let reopened = try LocalWorkspaceStore(path: path)
        let repeated = try await reopened.persistLegacyProjectionWitness(
            nodeId: nodeId,
            storageVersion: witness.storageVersion,
            docId: witness.docId,
            headsHash: witness.headsHash,
            bytesSha256: witness.bytesSha256
        )
        XCTAssertEqual(
            repeated,
            .alreadyPersisted(.init(nodeId: nodeId, storageVersion: witness.storageVersion, docId: witness.docId, headsHash: witness.headsHash, bytesSha256: witness.bytesSha256))
        )
    }

    func testLegacyProjectionWitnessLeavesDirtyRowByteForByteUntouchedAndRequiresRecovery() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        let node = Node(id: nodeId, workspaceId: workspaceId, title: "Dirty legacy", createdAt: "2026-08-20T00:00:00Z")
        let store = try LocalWorkspaceStore(path: path)
        try await store.upsertNode(node, dirty: false)
        let localBytes = Data([0xde, 0xad, 0xbe, 0xef])
        try await store.upsertPage(
            Page(nodeId: nodeId, automergeDocId: "local-doc", headsHash: "local-heads"),
            docBytes: localBytes,
            dirty: true
        )
        let before = try await store.legacyPageState(nodeId: nodeId)

        let disposition = try await store.persistLegacyProjectionWitness(
            nodeId: nodeId,
            storageVersion: 12,
            docId: "server-doc",
            headsHash: "server-heads",
            bytesSha256: sha(Data([0x12]))
        )
        guard case .recoveryRequired(let recovered) = disposition else {
            return XCTFail("dirty legacy rows must require recovery")
        }
        XCTAssertEqual(recovered, before)
        let unchanged = try await store.legacyPageState(nodeId: nodeId)
        XCTAssertEqual(unchanged, before)

        let reopened = try LocalWorkspaceStore(path: path)
        let reopenedState = try await reopened.legacyPageState(nodeId: nodeId)
        XCTAssertEqual(reopenedState, before)
        let witnessRows = try SQLite3Connection(path: path).query(
            "SELECT COUNT(*) FROM legacy_page_witnesses WHERE node_id = ?;",
            [.text(nodeId.rawValue)]
        ) { statement in columnInt(statement, 0) }
        XCTAssertEqual(witnessRows, [0])
    }

    func testTagUpsertAndParentIdsRoundTrip() async throws {
        let store = try makeStore()
        let parentId = try EntityId(validating: UUID().uuidString.lowercased())
        let tagId = try EntityId(validating: UUID().uuidString.lowercased())
        let tag = Tag(id: tagId, name: "Custom Tag", parentIds: [parentId], builtin: false)

        try await store.upsertTag(tag, dirty: true)
        let fetched = try await store.tag(id: tagId)
        XCTAssertEqual(fetched, tag)

        let all = try await store.listTags()
        XCTAssertTrue(all.contains(tag))
    }

    func testFactValueRoundTripsThroughJSON() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let nodeId = try EntityId(validating: UUID().uuidString.lowercased())
        try await store.upsertNode(
            Node(id: nodeId, workspaceId: workspaceId, title: "Fact host", createdAt: "2026-08-20T00:00:00Z"),
            dirty: false
        )

        let factId = try EntityId(validating: UUID().uuidString.lowercased())
        let value: JSONValue = ["due": "2026-09-01", "priority": 2, "urgent": true, "tags": ["a", "b"]]
        let fact = Fact(id: factId, nodeId: nodeId, predicateId: "task-metadata", value: value)
        try await store.upsertFact(fact, dirty: true)

        let fetched = try await store.listFacts(nodeId: nodeId)
        XCTAssertEqual(fetched, [fact])
    }

    func testEdgeBacklinksQueryMirrorsTargetIndex() async throws {
        let store = try makeStore()
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())
        let source = try EntityId(validating: UUID().uuidString.lowercased())
        let target = try EntityId(validating: UUID().uuidString.lowercased())
        for id in [source, target] {
            try await store.upsertNode(
                Node(id: id, workspaceId: workspaceId, title: "n", createdAt: "2026-08-20T00:00:00Z"), dirty: false
            )
        }
        let relationDefinitionId = try EntityId(validating: UUID().uuidString.lowercased())
        let edgeId = try EntityId(validating: UUID().uuidString.lowercased())
        let edge = Edge(id: edgeId, relationDefinitionId: relationDefinitionId, sourceNodeId: source, targetNodeId: target)
        try await store.upsertEdge(edge, dirty: true)

        let backlinks = try await store.listBacklinks(targetNodeId: target)
        XCTAssertEqual(backlinks, [edge])

        let outgoing = try await store.listOutgoingEdges(sourceNodeId: source)
        XCTAssertEqual(outgoing, [edge])

        let noBacklinks = try await store.listBacklinks(targetNodeId: source)
        XCTAssertTrue(noBacklinks.isEmpty)
    }

    func testSyncFeedCursorPersistsAcrossReopens() async throws {
        let path = LocalWorkspaceStore.scratchPath(label: UUID().uuidString)
        let workspaceId = try EntityId(validating: UUID().uuidString.lowercased())

        let store = try LocalWorkspaceStore(path: path)
        let initialCursor = try await store.syncFeedCursor(workspaceId: workspaceId)
        XCTAssertNil(initialCursor)

        try await store.setSyncFeedCursor(workspaceId: workspaceId, epoch: "epoch-1", afterCounter: 42)

        let reopened = try LocalWorkspaceStore(path: path)
        let cursor = try await reopened.syncFeedCursor(workspaceId: workspaceId)
        XCTAssertEqual(cursor?.epoch, "epoch-1")
        XCTAssertEqual(cursor?.afterCounter, 42)

        try await reopened.setSyncFeedCursor(workspaceId: workspaceId, epoch: "epoch-2", afterCounter: nil)
        let updated = try await reopened.syncFeedCursor(workspaceId: workspaceId)
        XCTAssertEqual(updated?.epoch, "epoch-2")
        XCTAssertNil(updated?.afterCounter)
    }
}
