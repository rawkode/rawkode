import unittest
from datetime import datetime, timezone
from verify_device_build import profile_errors, signed_entitlement_errors


class DeviceProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 12, tzinfo=timezone.utc)
        self.profile = {
            "ProvisionedDevices": ["phone", "watch"],
            "ExpirationDate": datetime(2027, 1, 1),
            "ApplicationIdentifierPrefix": ["TEAM"],
            "Entitlements": {"application-identifier": "TEAM.dev.example.*", "get-task-allow": True},
        }

    def test_wildcard_profile_still_requires_watch_registration(self):
        self.profile["ProvisionedDevices"] = ["phone"]
        self.assertIn("provisioning profile does not authorize the requested device",
                      profile_errors(self.profile, "dev.example.watch", "watch", self.now))

    def test_authorized_watch(self):
        self.assertEqual(profile_errors(self.profile, "dev.example.watch", "watch", self.now), [])

    def test_other_apps_profile_cannot_be_substituted(self):
        self.assertIn("provisioning profile does not authorize this bundle identifier",
                      profile_errors(self.profile, "dev.other.watch", "watch", self.now))

    def test_expired_profile_is_rejected(self):
        self.profile["ExpirationDate"] = datetime(2026, 9, 11)
        self.assertIn("provisioning profile is expired or has no expiry",
                      profile_errors(self.profile, "dev.example.watch", "watch", self.now))

    def test_distribution_profile_is_not_device_development_evidence(self):
        self.profile["Entitlements"]["get-task-allow"] = False
        self.assertIn("expected a development provisioning profile",
                      profile_errors(self.profile, "dev.example.watch", "watch", self.now))

    def test_profile_permission_does_not_replace_signed_app_group(self):
        self.profile["TeamIdentifier"] = ["TEAM"]
        self.profile["Entitlements"]["com.apple.security.application-groups"] = ["group.rawkode.academy.enchiridion"]
        signed = {"application-identifier": "TEAM.rawkode.academy.enchiridion.widget",
                  "com.apple.developer.team-identifier": "TEAM", "get-task-allow": True}
        self.assertEqual(signed_entitlement_errors(self.profile, signed, "rawkode.academy.enchiridion.widget"),
                         ["executable is missing the shared widget App Group entitlement"])

    def test_signed_identity_must_match_bundle_and_profile(self):
        self.profile["TeamIdentifier"] = ["TEAM"]
        signed = {"application-identifier": "OTHER.dev.example.watch",
                  "com.apple.developer.team-identifier": "OTHER", "get-task-allow": True}
        errors = signed_entitlement_errors(self.profile, signed, "dev.example.watch")
        self.assertIn("signed application identifier does not match the bundle and profile", errors)
        self.assertIn("signed team is not authorized by the profile", errors)


if __name__ == "__main__":
    unittest.main()
