{ pkgs, stateVersion, ... }: {
	imports = [
		./home-manager/atuin
		./home-manager/direnv
		./home-manager/eza
		./home-manager/git
		./home-manager/github
		./home-manager/namespace
		./home-manager/nushell
		./home-manager/starship
		./home-manager/wezterm
		./home-manager/zellij
		./home-manager/zoxide
	];

  home = {
		stateVersion = stateVersion;

    packages = with pkgs; [
      coreutils
      findutils
      tree
      unzip
      wget
      zstd
    ]
    ;
  };
}
