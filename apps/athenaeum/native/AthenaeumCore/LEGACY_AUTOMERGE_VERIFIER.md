# Native legacy Automerge verifier

`AthenaeumCore` is the shipped Loro-only native product. It must not link
`automerge-swift`: both bindings package a static Rust runtime, and a binary
containing both archives fails to link on macOS.

The former `PageDocumentStore`, its tests, and `phase2-driver` exercised local
Automerge sync. They were intentionally retired from this package rather than
leaving a test or executable target that co-links Automerge and Loro. This is
not removal of the legacy compatibility contract: backend RPCs and the web
legacy editor remain the compatibility lane, while native presents legacy pages
through `getLegacyPageProjection` as read-only migration-required content.

If local native Automerge verification is needed again, create a separate
package or helper process that links only `automerge-swift` plus shared
Domain/RPC code. It must not depend on `AthenaeumCore`, `Loro`, or an app
target, and it needs its own versioned IPC/storage ownership design before it
can be used for product behavior.
