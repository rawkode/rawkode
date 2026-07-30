# Knowledge graph data model

Enchiridion treats every page as a node in a vault-local knowledge graph. Supertags provide
types and inherited predicates; canonical directed edges provide relationships; inverse names
provide backlinks without storing a second edge. SQLite is the local query engine. CloudKit is
transport, not an alternate graph authority.

## Semantic contract

- A node has one durable `NodeID` inside one `VaultID`. External identities always serialize as
  `VaultScopedNodeID`; relationships never cross vaults implicitly.
- A node may have multiple Supertags. A custom tag may inherit from multiple parents. The closure
  is a directed acyclic graph and includes the fixed Base Tags supplied by Enchiridion: Person,
  Organization, Company, Event, Place, Area, Project, and Task.
- A fact is a typed `(node, predicate, value)` assertion projected from the node's Automerge
  document. Predicate identity is stable even when a field is renamed.
- A relationship is one source-owned canonical edge with a forward and inverse name. One-to-one,
  one-to-many, many-to-one, and many-to-many are expressed as endpoint maximums on its definition.
- A backlink is the inverse projection of an incoming canonical edge. It is never a second mutable
  record.
- Concurrent maximum-one edges are preserved and surfaced as graph issues. Resolution is explicit;
  merge order must not silently choose a winner.
- Provider and inline-reference edges are graph projections. User-created edges are stored in the
  source node's Automerge document and therefore merge with the rest of that node.

## SQL versus Cypher

Enchiridion uses read-only SQLite SQL rather than embedding a Cypher engine.

| Concern | SQLite SQL | Cypher |
| --- | --- | --- |
| Local Apple-platform runtime | Already embedded, supported by GRDB, and shares transactions with page projection | Requires a second embedded engine or a server runtime |
| Graph traversal | Recursive CTEs are more verbose but compile cleanly from the visual builder | Pattern syntax is clearer for hand-written variable-length traversals |
| Facts, calendar data, FTS, and ordering | Natural joins, indexes, FTS5, aggregates, and date sorting in one engine | Often requires duplicated non-graph projections or engine-specific extensions |
| Cardinality and inheritance checks | Explicit projection and validation code; easy to test transactionally | Relationships are native, but application cardinality and tag-DAG rules still need validation |
| Query isolation | SQLite authorizer permits one read-only statement over stable public views | Would require an equivalent allowlist and resource-limiting layer |
| Mobile footprint and offline recovery | One database, backup, migration path, and CloudKit projection boundary | Two authorities increase packaging, migration, reconciliation, and recovery cost |
| User ergonomics | Visual query builder hides recursive SQL; advanced users may inspect or write SQL | Better direct graph syntax for advanced graph users |

Cypher wins on handwritten graph-pattern readability. SQL wins for this product because the graph
is one aspect of the same local-first data authority as prose, tasks, calendars, full-text search,
and sync state. Adding a graph database now would create a second transactional authority without
removing the need for SQLite.

This is not a commitment to expose SQLite internals. The supported query surface is the visual
query model and these read-only relations:

- `graph_nodes`
- `graph_tags`, `graph_tag_parents`, and `graph_tag_closure`
- `graph_node_tags` and `graph_facts`
- `graph_relation_definitions` and `graph_edges`
- `graph_issues`
- `graph_text_search`

Physical tables are denied by the SQLite authorizer. Queries are limited by row count, result size,
execution time, and a single-statement read-only policy. If a future Cypher engine becomes valuable,
it must implement the same semantic contract and query model; UI and persisted saved queries should
not depend on private SQL table names.

## Persistence and synchronization

Each vault has its own SQLite database and CloudKit record zone. Pages own their Automerge
documents and canonical edges. Supertag schemas, custom relationship definitions, and saved graph
queries are vault metadata with generation-safe CloudKit acknowledgements and tombstones. Fixed
Base Tags and system relationship definitions ship with the application and are not uploaded.

The vault catalog remains local device configuration: selected/default-capture vault choices and
local database locations are not graph knowledge. Global search opens each local vault and returns
vault-scoped identities; it does not create cross-vault edges.

## Evolution rules

1. Add graph behavior to the semantic model first, then project it into stable query views.
2. Keep one canonical mutation owner for every edge or fact.
3. Never materialize backlinks as independently editable data.
4. Preserve conflicting graph assertions through merge and expose deterministic issues.
5. Keep query execution read-only and bounded.
6. Version public query semantics deliberately; private tables may change freely.
