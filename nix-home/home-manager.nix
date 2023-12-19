{ pkgs, stateVersion, ... }: {
	imports = [
		./home-manager/1password
		./home-manager/alttab
		./home-manager/atuin
		./home-manager/discord
		./home-manager/direnv
		./home-manager/eza
		./home-manager/git
		./home-manager/github
		./home-manager/namespace
		./home-manager/nushell
		./home-manager/raycast
		./home-manager/slack
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
