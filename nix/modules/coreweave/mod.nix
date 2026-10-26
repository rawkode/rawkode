_:
let
  mkApp = import ../../lib/mkApp.nix;
in
mkApp {
  name = "coreweave";

  common.home =
    {
      config,
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      firefoxAddons = pkgs.nur.repos.rycee.firefox-addons;

      # Not packaged in NUR; pinned to the addons.mozilla.org release.
      glean = firefoxAddons.buildFirefoxXpiAddon {
        pname = "glean";
        version = "1.2026.402.5000";
        addonId = "{315f61e5-f0ce-4d6e-a521-70e8da512405}";
        url = "https://addons.mozilla.org/firefox/downloads/file/4778840/glean-1.2026.402.5000.xpi";
        sha256 = "sha256-BY1/PugAT64LGGqZIWI4QMuH2l3C6jtbIvbnBjJa33k=";
        meta = { };
      };

      # Platform-specific naming for cwctl releases

      cwctlget = pkgs.writeShellScriptBin "cwctlget" ''
        set -euo pipefail

        VERSION="''${1:-latest}"
        BIN_DIR="$HOME/Code/bin"
        REPO="coreweave/cwctl"

        # Detect platform and architecture
        if [[ "$OSTYPE" == "darwin"* ]]; then
          PLATFORM="Darwin"
        else
          PLATFORM="Linux"
        fi

        if [[ "$(uname -m)" == "arm64" ]] || [[ "$(uname -m)" == "aarch64" ]]; then
          ARCH="arm64"
        else
          ARCH="x86_64"
        fi

        ASSET="cwctl_''${PLATFORM}_''${ARCH}.tar.gz"

        echo "Downloading cwctl ''${VERSION} for ''${PLATFORM}/''${ARCH}..."

        # Download to temp directory
        TEMP_DIR=$(mktemp -d)
        cd "$TEMP_DIR"

        if [[ "$VERSION" == "latest" ]]; then
          ${pkgs.gh}/bin/gh release download -R "$REPO" -p "$ASSET"
        else
          ${pkgs.gh}/bin/gh release download -R "$REPO" "$VERSION" -p "$ASSET"
        fi

        # Extract and install
        tar xzf "$ASSET"
        chmod +x cwctl
        mkdir -p "$BIN_DIR"
        mv cwctl "$BIN_DIR/cwctl"

        # Cleanup
        cd - > /dev/null
        rm -rf "$TEMP_DIR"

        echo "✓ cwctl installed to $BIN_DIR/cwctl"
        "$BIN_DIR/cwctl" version
      '';
    in
    {
      home.packages = with inputs.coreweave.packages.${pkgs.stdenv.hostPlatform.system}; [
        cw-eng-cli
        cwic
        cwctlget
      ];

      # Okta (work SSO) and Glean (work search) are only needed for work; add
      # them wherever Home Manager manages the Firefox profile.
      programs.firefox.profiles.default.extensions.packages = lib.mkIf config.programs.firefox.enable [
        firefoxAddons.okta-browser-plugin
        glean
      ];
    };
}
