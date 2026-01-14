{
  flake.nixosModules.fonts =
    { pkgs, ... }:
    {
      fonts = {
        enableDefaultPackages = false;
        enableGhostscriptFonts = true;

        fontconfig = {
          enable = true;

          antialias = true;
          hinting.enable = true;
          hinting.autohint = true;

          allowBitmaps = true;
          useEmbeddedBitmaps = true;

          defaultFonts = {
            sansSerif = [ "Nato Sans" ];
            serif = [ "Nato" ];
            monospace = [ "Monaspace Argon" ];
            emoji = [
              "JoyPixels"
              "Noto Color Emoji"
              "Noto Emoji"
            ];
          };
        };

        fontDir.enable = true;

        packages = with pkgs; [
          corefonts
          joypixels
          monaspace
          nerd-fonts.monaspace
          nerd-fonts.symbols-only
          noto-fonts
          noto-fonts-color-emoji
        ];
      };
    };

  flake.darwinModules.fonts =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.fonts;
    in
    {
      options.rawkOS.darwin.fonts = {
        enable = lib.mkEnableOption "font installation via nix on darwin";

        packages = lib.mkOption {
          type = lib.types.listOf lib.types.package;
          default = [ ];
          example = lib.literalExpression ''
            with pkgs; [
              monaspace
              nerd-fonts.monaspace
              nerd-fonts.symbols-only
            ]
          '';
          description = "Font packages to install system-wide";
        };
      };

      config = lib.mkIf cfg.enable {
        fonts.packages = cfg.packages;
      };
    };
}
