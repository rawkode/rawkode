{ pkgs, ... }: {
  home.packages = with pkgs; [
		namespace-cli
	];
}
