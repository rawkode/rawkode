{
  flake.homeModules.jj = {
    programs.jujutsu = {
      enable = true;
    };

    xdg.configFile."jj/config.toml".source = ./jj.toml;
  };
}
