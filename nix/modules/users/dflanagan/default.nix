{ inputs, ... }:
let
  mkUser = import ../../../lib/mk-user.nix { inherit inputs; };
  machineSystems = import ../../../lib/machine-systems.nix;

  baseImports = with inputs; [
    nix-index-database.homeModules.nix-index
    nur.modules.homeManager.default

    self.homeModules.ai
    self.homeModules.profiles-home
    self.homeModules.profiles-desktop
    self.homeModules.fish
    self.homeModules.nix-home
    self.homeModules.stylix
  ];

  darwinImports = with inputs; [
  ];

in
mkUser {
  username = "dflanagan";
  name = "David Flanagan";
  inherit machineSystems;
  homeImports = {
    darwin = darwinImports ++ baseImports;
  };
  homeExtraConfig = {
    programs.git.includes = [
      {
        condition = "gitdir:~/Code/src/github.com/coreweave/";
        contents.user.email = "dflanagan@coreweave.com";
      }
    ];
  };
  enableHomeConfigurations = true;
  machinesDir = ../../machines;
}
