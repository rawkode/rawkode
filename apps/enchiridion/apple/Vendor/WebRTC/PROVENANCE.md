# WebRTC 153 — P4X redistribution

This package consumes P4X-639 Ltd's signed redistribution of the unchanged
WebRTC 153 binary distributed by `stasel/WebRTC`.

- Original distribution: https://github.com/stasel/WebRTC/releases/tag/153.0.0
- Original package revision: `4266157cd08f92115de885ab12d87196a8db87e1`
- Original binary ZIP SHA256:
  `3e3a8946f27510133e3feed04d05fa23505bbe366e977620503bfc7986c2b78f`
- Original WebRTC source revision: `9ea5afcad008b940468c2a15aec339592cf5a935`
  on `branch-heads/8010`.
- Redistribution: https://github.com/rawkode/rawkode/releases/tag/enchiridion-webrtc-153.0.0-p4x.1
- Signing identity: P4X Apple Development identity, Apple team `6KXCJGJ45W`.
- Change: a timestamped outer XCFramework signature, identifying P4X as the
  redistributor. This is not an original upstream/vendor signature. No WebRTC
  code, privacy manifest, inner framework or headers were changed or rebuilt.
- The release ZIP's checksum is pinned in `Package.swift`.

`LICENSE` preserves the WebRTC project's license. `DISTRIBUTOR-LICENSE.md`
preserves the original binary distributor's license. Original debug symbols
remain sourced from the same upstream 153 release, checksum- and UUID-validated
by `apple/scripts/install-webrtc-dsym.sh` during archive builds.

The signature establishes who redistributed this artifact. It does not establish
an independent source rebuild or replace dependency review. To update it, verify
the original source/version and binary checksum, retain license notices, sign a
new explicitly versioned redistribution with the authorized team identity, and
pin the resulting archive checksum. Never modify App Store signature metadata
or remove the vendor-provenance record from the app archive.
