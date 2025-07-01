{ config, lib, pkgs, ... }:

let
  cfg = config.programs.docker;
in
{
  options.programs.docker = {
    enable = lib.mkEnableOption "Docker container runtime";
    
    enableDockerCompose = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to install docker-compose";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = with pkgs; lib.mkMerge [
      [ docker-client ]
      (lib.mkIf cfg.enableDockerCompose [ docker-compose ])
    ];

    # Docker configuration
    xdg.configFile."docker/config.json".text = ''
{
  "auths": {},
  "credsStore": "secretservice"
}
    '';
  };
}