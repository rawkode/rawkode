{
  flake.darwinModules.fonts =
    { config, lib, pkgs, ... }:
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
