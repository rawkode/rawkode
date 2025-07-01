{ config, lib, pkgs, ... }:

let
  cfg = config.programs.podman;
in
{
  options.programs.podman = {
    enable = lib.mkEnableOption "Podman container runtime";
    
    enableCompose = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to install podman-compose";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = with pkgs; lib.mkMerge [
      [ podman ]
      (lib.mkIf cfg.enableCompose [ podman-compose ])
    ];

    # Podman registries configuration
    xdg.configFile."containers/registries.conf.d/gcr.io.conf".text = ''
unqualified-search-registries = ["mirror.gcr.io"]
    '';

    # Podman storage configuration for rootless mode
    xdg.configFile."containers/storage.conf".text = ''
[storage]
  driver = "overlay"
  runroot = "$XDG_RUNTIME_DIR/containers"
  graphroot = "$HOME/.local/share/containers/storage"

[storage.options]
  ignore_chown_errors = "true"
    '';
  };
}