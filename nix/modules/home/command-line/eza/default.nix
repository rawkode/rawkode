{ pkgs, ... }:
{
  home.packages = with pkgs; [
    eza
  ];

  programs = {
		eza = {
			enable = true;
			enableFishIntegration = true;

			colors = "always";
			git = true;
			icons = "always";

			extraOptions = [
				"--time-style"
				"relative"
				"--git-ignore"
				"--group-directories-first"
				"--no-quotes"
			];
		};
  };
}
