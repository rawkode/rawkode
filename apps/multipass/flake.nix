{
  description = "Multipass native keyboard-following mouse switcher";

  # Match the dots toolchain; consumers can override this with inputs.nixpkgs.follows.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/e8be7818e19ada32105a8af937a6a473b38167ca";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          packages = pkgs.callPackage ./nix/package.nix { };
        in
        {
          default = packages.multipass;
          inherit (packages) multipass engine;
        }
      );
      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/multipass";
        };
      });
      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
        engine = self.packages.${system}.engine;
      });
    };
}
