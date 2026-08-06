# EnchiridionStore

The local native projection store. It owns GRDB schema evolution, projections,
and bounded read-only graph queries. The durable mutation boundary must make
document state, catalog state, projections, and outbox effects atomic before
this module is production-ready.
