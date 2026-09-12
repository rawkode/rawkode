# Watch installation and CarPlay diagnosis — 12 September 2026

## Watch: confirmed package defect

The signed iPhone build embedded `Watch/ApsidesWatch.app`, with the correct
companion bundle identifier, watchOS platform, device family 4, OS 26 minimum,
and matching application versions. Its signature verifies. However, its embedded
wildcard development profile does **not** contain the intended physical Watch's
UDID. The iPhone and widget profiles do contain their intended device.

This is a concrete installation blocker. It explains why a successful generic
build and iPhone installation did not establish Watch installability. Hardware
installation logs are unavailable, so additional blockers have not been excluded.

An isolated signed Watch rebuild with automatic provisioning succeeded but reused
the same stale wildcard profile. Temporarily backing up that cached profile and
requesting fresh provisioning failed because Xcode reported no account available
and no matching Watch profile. The cached profile was restored; nothing was
revoked or deleted in the developer portal. A corrected profile has **not** been
issued and no replacement package has been installed.

## Repeatable gate

Use the physical UDIDs reported by `xcrun devicectl device info details`, rather
than its CoreDevice UUIDs:

```sh
bash apple/script/build_for_devices.sh "$IPHONE_UDID" "$WATCH_UDID"
```

This builds the complete signed iPhone package and validates its phone, embedded
Watch and widget against both devices. The check rejects missing device
authorization, expired profiles, wrong bundle identifiers, nondevelopment
profiles, invalid signatures, companion/version/team mismatches, and missing
widget/App Group registration. It performs no installation or device interaction.

The checker was run against the existing signed package: iPhone and widget passed;
Watch failed specifically on missing device authorization. Seven regression tests
passed, including an otherwise-valid wildcard profile that contains the phone
but omits the Watch. Generic compilation alone must not substitute for this gate.

## Remaining repair

When Xcode account access is available, refresh or create development provisioning
for `dev.rawkode.apsides.watchkitapp` including the registered Watch. Rebuild and
pass the gate above. When the devices return, verify Watch installation, launch,
and capture acknowledgement on the actual paired devices. No reinstall, app
removal, or action on a moving user's phone is attempted by this diagnosis.

## CarPlay: missing full app, separate widget

The package contains a validly signed WidgetKit extension with its App Group
authorized. The source supports the CarPlay-eligible `systemSmall` family. There
is no CarPlay launcher scene or approved app-category entitlement; a launcher
icon is therefore not implemented. Widget gallery discovery on the actual car
remains unverified. See [CarPlay test](CARPLAY-TEST.md) for the distinction and
parked diagnostics. This is not a completed full CarPlay experience.
