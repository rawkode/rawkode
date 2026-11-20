{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  # Prefixed to avoid colliding with the "coreweave" app bundle
  # (modules/coreweave/mod.nix) in flake.{home,nixos,darwin}Modules.
  name = "capabilities-coreweave";

  home = with inputs.self.appBundles; [
    coreweave.home
  ];

  darwin =
    { lib, ... }:
    {
      rawkOS.darwin.firewall.enable = lib.mkForce false;

      system.defaults.CustomSystemPreferences."org.mozilla.nightly" = {
        EnterprisePoliciesEnabled = true;
        ExtensionSettings = {
          "plugin@okta.com" = {
            installation_mode = "normal_installed";
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/okta-browser-plugin/latest.xpi";
          };
          "{315f61e5-f0ce-4d6e-a521-70e8da512405}" = {
            installation_mode = "normal_installed";
            install_url = "https://addons.mozilla.org/firefox/downloads/latest/glean/latest.xpi";
          };
        };
      };
    };
}
