{
  description = "Kree - Focus! Window!";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        appName = "Kree";
      in
      {
        packages.default = pkgs.stdenv.mkDerivation {
          name = appName;
          src = ./.;

          buildInputs = with pkgs; [
            swift
            swiftpm
          ] ++ (if pkgs.stdenv.isDarwin then [
            pkgs.apple-sdk_14
          ] else []);

          buildPhase = ''
            # SwiftPM tries to use a sandbox which conflicts with Nix's sandbox
            swift build -c release --disable-sandbox --cache-path .build-cache
          '';

          installPhase = ''
            mkdir -p $out/Applications/${appName}.app/Contents/MacOS
            mkdir -p $out/Applications/${appName}.app/Contents/Resources

            cp .build/release/${appName} $out/Applications/${appName}.app/Contents/MacOS/
            cp Sources/${appName}/Info.plist $out/Applications/${appName}.app/Contents/
            
            # Copy resources
            if [ -d ".build/release/${appName}_${appName}.bundle" ]; then
                cp -R .build/release/${appName}_${appName}.bundle/* $out/Applications/${appName}.app/Contents/Resources/
            fi

            chmod +x $out/Applications/${appName}.app/Contents/MacOS/${appName}
          '';
        };

        apps.default = {
          type = "app";
          program = "${pkgs.writeShellScriptBin "install-and-run" ''
            APP_NAME="Kree"
            DEST="$HOME/Applications/$APP_NAME.app"
            
            echo "Installing $APP_NAME to $DEST..."
            mkdir -p "$HOME/Applications"
            rm -rf "$DEST"
            
            # Copy from Nix Store
            cp -RL "${self.packages.${system}.default}/Applications/$APP_NAME.app" "$HOME/Applications/"
            chmod -R u+w "$DEST"
            
            echo "Launching $APP_NAME..."
            open "$DEST"
          ''}/bin/install-and-run";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            swift
            swiftpm
          ] ++ (if pkgs.stdenv.isDarwin then [
            pkgs.apple-sdk_14
          ] else []);

          shellHook = ''
            echo "Swift environment loaded."
            echo "Build with: swift build"
            echo "Run with: swift run"
          '';
        };
      });
}
