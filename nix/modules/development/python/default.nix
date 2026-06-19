{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
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
            python3Packages.pip
            python3Packages.virtualenv
          ])
          ++ lib.optionals cfg.extraTools.enable (
            with pkgs;
            [
              python3Packages.black
              python3Packages.isort
              python3Packages.flake8
              python3Packages.mypy
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
