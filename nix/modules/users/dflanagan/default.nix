{ inputs, ... }:
let
  mkUser = import ../../../lib/mk-user.nix { inherit inputs; };

  darwinImports = with inputs; [
    # Editor and CLI toolkit
    self.homeModules.profiles-command-line

    # Nix CLI config for HM (required by modules that set nix.settings)
    self.homeModules.nix-home

    # Developer tooling (Docker client, Podman, language toolchains, etc.)
    self.homeModules.profiles-development

    # Apps and theming
    self.homeModules.ghostty
    self.homeModules.git
    self.homeModules.stylix
  ];

in
mkUser {
  username = "dflanagan";
  name = "David Flanagan";
  homeImports = {
    linux = [ ];
    darwin = darwinImports;
  };
  homeExtraConfig = {
    # Use work email for CoreWeave repositories
    programs.git.includes = [
      {
        condition = "gitdir:~/Code/src/github.com/coreweave/";
        contents.user.email = "dflanagan@coreweave.com";
      }
    ];
  };
}
