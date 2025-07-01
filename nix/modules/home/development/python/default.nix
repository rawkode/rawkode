{ config, lib, pkgs, ... }:
{
  home.packages = with pkgs; [
    python3
    uv
    # Common Python development tools
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
  ];

  home.sessionVariables = {
    UV_CACHE_DIR = "${config.xdg.cacheHome}/uv";
  };
}
