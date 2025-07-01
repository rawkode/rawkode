{ config, lib, pkgs, ... }:

let
  cfg = config.programs.python;
in
{
  options.programs.python = {
    enable = lib.mkEnableOption "Python programming language";
    
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.python3;
      description = "The Python package to use";
    };
    
    useUv = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to use uv for Python package management";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = with pkgs; lib.mkMerge [
      [ cfg.package ]
      (lib.mkIf cfg.useUv [ uv ])
      # Common Python development tools
      [
        python3Packages.pip
        python3Packages.virtualenv
        python3Packages.black
        python3Packages.isort
        python3Packages.flake8
        python3Packages.mypy
        python3Packages.pytest
        python3Packages.ipython
        ruff
        pyright
      ]
    ];

    home.sessionVariables = lib.mkIf cfg.useUv {
      UV_CACHE_DIR = "${config.xdg.cacheHome}/uv";
    };
  };
}