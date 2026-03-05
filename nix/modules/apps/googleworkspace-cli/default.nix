{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "googleworkspace-cli";

  common.home =
    { inputs, pkgs, ... }:
    let
      inherit (pkgs.stdenv.hostPlatform) system;
      packages = inputs.googleworkspace-cli.packages.${system};
      upstreamPackage = packages.default or packages.gws;
      upstreamPackageEval = builtins.tryEval upstreamPackage.drvPath;

      source = inputs.googleworkspace-cli.outPath;
      cargoToml = builtins.fromTOML (builtins.readFile "${source}/Cargo.toml");

      darwinFallbackPackage = pkgs.rustPlatform.buildRustPackage {
        pname = "gws";
        version = cargoToml.package.version or "unstable";
        src = source;
        cargoLock.lockFile = "${source}/Cargo.lock";
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.libiconv ];
        doCheck = false;
      };

      package =
        if upstreamPackageEval.success then
          upstreamPackage
        else if pkgs.stdenv.isDarwin then
          darwinFallbackPackage
        else
          throw "googleworkspace-cli flake does not expose a usable package for ${system}";
    in
    {
      home.packages = [ package ];
    };
}
