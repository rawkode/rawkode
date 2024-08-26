{ config, ... }:
{
  home.file."${config.xdg.configHome}/aichat/config.yaml" = {
    source = ./config.yaml;
  };
}
