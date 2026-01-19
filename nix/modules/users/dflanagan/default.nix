{ inputs, ... }:
let
  mkUser = import ../../../lib/mk-user.nix { inherit inputs; };
  machineSystems = import ../../../lib/machine-systems.nix;

  baseImports = with inputs; [
    self.homeModules.profiles-users-common
  ];

  darwinImports = with inputs; [
    # Darwin needs stylix explicitly (on NixOS it comes via nixosModules.stylix)
    self.homeModules.stylix
  ];

in
mkUser {
  username = "dflanagan";
  name = "David Flanagan";
  email = "david@rawkode.dev";
  signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAXwFFDFPDUbAql+V8xMmFxuZe6aUUxDD2cY0Dr0X1g9";
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
