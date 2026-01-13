{
  flake.nixosModules.fish =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      stylixFishDisable =
        lib.mkIf (pkgs.stdenv.isLinux && lib.attrsets.hasAttrByPath [ "stylix" "targets" "fish" ] config)
          {
            stylix.targets.fish.enable = lib.mkForce false;
          };
    in
    lib.mkMerge [
      stylixFishDisable
      {
        programs.fish.enable = true;
      }
    ];

  flake.homeModules.fish =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      fileAsSeparatedString =
        path: lib.strings.concatStringsSep "\n" (lib.strings.splitString "\n" (builtins.readFile path));
      stylixFishDisable =
        lib.mkIf (pkgs.stdenv.isLinux && lib.attrsets.hasAttrByPath [ "stylix" "targets" "fish" ] config)
          {
            stylix.targets.fish.enable = lib.mkForce false;
          };
    in
    lib.mkMerge [
      stylixFishDisable
      {
        home.file.".bashrc".source = ./auto-fish.sh;

        programs.fish = {
          enable = true;

          plugins = [
            {
              name = "nix-env";
              src = pkgs.fetchFromGitHub {
                owner = "lilyball";
                repo = "nix-env.fish";
                rev = "7b65bd228429e852c8fdfa07601159130a818cfa";
                hash = "sha256-RG/0rfhgq6aEKNZ0XwIqOaZ6K5S4+/Y5EEMnIdtfPhk";
              };
            }
          ];

          shellAliases = {
            ghb = "cd ~/Code/src/github.com";
          };

          binds = {
            "ctrl-\\[".command = "builtin cd ..; commandline -f repaint";
          };

          interactiveShellInit = fileAsSeparatedString ./interactiveInit.fish;

          functions = {
            magic-enter = {
              description = "Magic Enter";
              body = fileAsSeparatedString ./magic-enter.fish;
            };

            magic-enter-command = {
              description = "Magic Enter AutoCommands";
              body = fileAsSeparatedString ./magic-enter-command.fish;
            };
          };
        };
      }
    ];

  flake.darwinModules.fish =
    { lib, pkgs, ... }:
    {
      programs.fish.enable = true;
      environment.shells = lib.mkAfter [ pkgs.fish ];
    };
}
