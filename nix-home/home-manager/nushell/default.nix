{ pkgs, ... }: {
  programs.nushell = {
    enable = true;
		configFile.source = ./config/config.nu;
		envFile.source = ./config/env.nu;
  };
}
