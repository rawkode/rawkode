{
  description = "Kree - Focus! Window!";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        appName = "Kree";
      in
      {
        packages.default = pkgs.stdenv.mkDerivation {
          name = appName;
          src = ./.;

          buildInputs =
            with pkgs;
            [
              swift
              swiftpm
            ]
            ++ (
              if pkgs.stdenv.isDarwin then
                [
                  pkgs.apple-sdk_14
                ]
              else
                [ ]
            );

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
            set -eu
            installer=/run/current-system/sw/bin/rawkos-install-app
            stopper=/run/current-system/sw/bin/rawkos-stop-app
            if [ ! -x "$installer" ] || [ ! -x "$stopper" ]; then
              echo "Activate your rawkOS Darwin configuration before launching Kree." >&2
              exit 1
            fi
            "$installer" "${self.packages.${system}.default}/Applications/Kree.app"
            "$stopper" Kree
            exec /usr/bin/open "$HOME/Applications/Kree.app"
          ''}/bin/install-and-run";
        };

        devShells.default = pkgs.mkShell {
          buildInputs =
            with pkgs;
            [
              swift
              swiftpm
            ]
            ++ (
              if pkgs.stdenv.isDarwin then
                [
                  pkgs.apple-sdk_14
                ]
              else
                [ ]
            );

          shellHook = ''
            echo "Swift environment loaded."
            echo "Build with: swift build"
            echo "Run the signed app with: nix run ."
          '';
        };
      }
    );
}
