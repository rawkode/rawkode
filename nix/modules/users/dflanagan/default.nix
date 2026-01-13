{ inputs, ... }:
let
  homeModule =
    {
      lib,
      system ? if builtins.hasAttr "currentSystem" builtins then builtins.currentSystem else "unknown",
      ...
    }:
    let
      isDarwin = lib.hasSuffix "darwin" system;
      homeDirectory = if isDarwin then "/Users/dflanagan" else "/home/dflanagan";

      darwinImports = with inputs; [
        # Editor and CLI toolkit
        self.homeModules.command-line

        # Nix CLI config for HM (required by modules that set nix.settings)
        self.homeModules.nix-home

        # Developer tooling (Docker client, Podman, language toolchains, etc.)
        self.homeModules.development

        # Apps and theming
        self.homeModules.ghostty
        self.homeModules.git
        self.homeModules.stylix
      ];
    in
    {
      home = {
        username = "dflanagan";
        inherit homeDirectory;
        stateVersion = "25.11";
      };

      programs.home-manager.enable = true;

      nixpkgs.config.allowUnfree = true;

      # Use work email for CoreWeave repositories
      programs.git.includes = [
        {
          condition = "gitdir:~/Code/src/github.com/coreweave/";
          contents.user.email = "dflanagan@coreweave.com";
        }
      ];

      imports = if isDarwin then darwinImports else [ ];
    };

  flake.homeModules.users-dflanagan = homeModule;

  flake.darwinModules.users-dflanagan =
    { pkgs, ... }:
    {
      home-manager.backupFileExtension = "hm-backup";
      home-manager.overwriteBackup = true;
      home-manager.useUserPackages = true;
      home-manager.extraSpecialArgs = {
        inherit inputs;
        system = "aarch64-darwin";
      };
      home-manager.users.dflanagan = homeModule;
    };
in
{
  inherit flake;
}
