#!/usr/bin/env python3
"""Validate the signed companion package against both intended physical devices."""

import argparse
from datetime import datetime, timezone
import fnmatch
from pathlib import Path
import plistlib
import subprocess
import sys


def profile_errors(profile, bundle_id, device_id, now):
    errors = []
    if device_id not in profile.get("ProvisionedDevices", []):
        errors.append("provisioning profile does not authorize the requested device")
    expiry = profile.get("ExpirationDate")
    if not isinstance(expiry, datetime) or expiry.replace(tzinfo=timezone.utc) <= now:
        errors.append("provisioning profile is expired or has no expiry")
    entitlements = profile.get("Entitlements", {})
    identifier = entitlements.get("application-identifier", "")
    prefixes = profile.get("ApplicationIdentifierPrefix", [])
    if not any(fnmatch.fnmatchcase(prefix + "." + bundle_id, identifier) for prefix in prefixes):
        errors.append("provisioning profile does not authorize this bundle identifier")
    if not entitlements.get("get-task-allow", False):
        errors.append("expected a development provisioning profile")
    return errors


def inspect_bundle(path, device_id):
    info = plistlib.loads((path / "Info.plist").read_bytes())
    subprocess.run(["codesign", "--verify", "--strict", str(path)], check=True, capture_output=True)
    result = subprocess.run(
        ["security", "cms", "-D", "-i", str(path / "embedded.mobileprovision")],
        check=True, capture_output=True,
    )
    profile = plistlib.loads(result.stdout)
    signed = subprocess.run(
        ["codesign", "-d", "--entitlements", "-", "--xml", str(path)],
        check=True, capture_output=True,
    )
    entitlements = plistlib.loads(signed.stdout)
    errors = profile_errors(profile, info["CFBundleIdentifier"], device_id, datetime.now(timezone.utc))
    errors.extend(signed_entitlement_errors(profile, entitlements, info["CFBundleIdentifier"]))
    return info, profile, entitlements, errors


def signed_entitlement_errors(profile, signed, bundle_id):
    errors = []
    allowed = profile.get("Entitlements", {})
    identifier = signed.get("application-identifier", "")
    if identifier not in [prefix + "." + bundle_id for prefix in profile.get("ApplicationIdentifierPrefix", [])]:
        errors.append("signed application identifier does not match the bundle and profile")
    if signed.get("com.apple.developer.team-identifier") not in profile.get("TeamIdentifier", []):
        errors.append("signed team is not authorized by the profile")
    if signed.get("get-task-allow") is not True:
        errors.append("executable is not signed for development")
    groups = signed.get("com.apple.security.application-groups", [])
    if any(group not in allowed.get("com.apple.security.application-groups", []) for group in groups):
        errors.append("signed App Group is not authorized by the profile")
    if bundle_id in ("rawkode.academy.enchiridion", "rawkode.academy.enchiridion.widget") and "group.rawkode.academy.enchiridion" not in groups:
        errors.append("executable is missing the shared widget App Group entitlement")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--iphone", required=True, help="Physical iPhone UDID, not CoreDevice UUID")
    parser.add_argument("--watch", required=True, help="Physical Watch UDID, not CoreDevice UUID")
    args = parser.parse_args()
    bundles = [
        ("iPhone", args.app, args.iphone),
        ("Watch", args.app / "Watch/Enchiridion.app", args.watch),
        ("Widget", args.app / "PlugIns/ApsidesWidget.appex", args.iphone),
    ]
    results = {}
    failures = []
    for label, path, device in bundles:
        try:
            info, profile, _, errors = inspect_bundle(path, device)
            results[label] = (info, profile)
            failures.extend(f"{label}: {error}" for error in errors)
            print(f"{label}: {'FAIL' if errors else 'PASS'} signature and device provisioning")
        except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
            failures.append(f"{label}: cannot validate signed bundle ({type(error).__name__})")
    if len(results) == 3:
        phone, phone_profile = results["iPhone"]
        watch, _ = results["Watch"]
        widget, _ = results["Widget"]
        if watch.get("WKCompanionAppBundleIdentifier") != phone["CFBundleIdentifier"]:
            failures.append("Watch: companion bundle identifier does not match iPhone")
        if watch.get("WKApplication") is not True or watch.get("UIDeviceFamily") != [4]:
            failures.append("Watch: expected a single-target watchOS application")
        if widget.get("NSExtension", {}).get("NSExtensionPointIdentifier") != "com.apple.widgetkit-extension":
            failures.append("Widget: missing WidgetKit extension registration")
        for label, (info, profile) in results.items():
            if profile.get("TeamIdentifier") != phone_profile.get("TeamIdentifier"):
                failures.append(f"{label}: signing team differs from iPhone")
            for key in ("CFBundleVersion", "CFBundleShortVersionString"):
                if info.get(key) != phone.get(key):
                    failures.append(f"{label}: {key} differs from iPhone")
        for label in ("iPhone", "Widget"):
            groups = results[label][1].get("Entitlements", {}).get("com.apple.security.application-groups", [])
            if "group.rawkode.academy.enchiridion" not in groups:
                failures.append(f"{label}: profile does not authorize the shared widget App Group")
    for failure in failures:
        print(failure, file=sys.stderr)
    if failures:
        return 1
    print("Package checks passed. Physical installation and launch remain separate checks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
