CREATE TABLE documents (
 owner TEXT NOT NULL,
 key TEXT NOT NULL,
 revision INTEGER NOT NULL,
 mutation_id TEXT NOT NULL,
 snapshot TEXT NOT NULL,
 format TEXT NOT NULL,
 extensions TEXT NOT NULL CHECK(json_valid(extensions)),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner, key)
);
