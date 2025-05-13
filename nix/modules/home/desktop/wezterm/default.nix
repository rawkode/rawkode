{ inputs, system, ... }:
{
	# This is broken atm
  # home.packages = [
  #   inputs.wezterm.packages.${system}.default
  # ];

  xdg.configFile."wezterm" = {
    source = ./config;
    recursive = true;
  };
}
