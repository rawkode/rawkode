{ pkgs }:

{
	packages = with pkgs; [
		wezterm
	];

	configFiles.source = ./config;
}
