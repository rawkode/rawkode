_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "python";

  common.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      cfg = config.rawkOS.development.python;
    in
    {
      options.rawkOS.development.python.extraTools.enable =
        lib.mkEnableOption "extra Python linting and interactive tools"
        // {
          default = true;
        };

      config = {
        home.packages =
          (with pkgs; [
            python3
            uv
          ])
          ++ lib.optionals cfg.extraTools.enable (
            with pkgs;
            [
              python3Packages.pytest
              python3Packages.ipython
              ruff
              pyright
            ]
          );

        home.sessionVariables = {
          UV_CACHE_DIR = "${config.xdg.cacheHome}/uv";
        };
      };
    };
}
