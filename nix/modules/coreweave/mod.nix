{ lib, ... }:
let
  mkApp = import ../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "coreweave";

  common.home =
    {
      inputs,
      pkgs,
      ...
    }:
    let
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
    };
}
