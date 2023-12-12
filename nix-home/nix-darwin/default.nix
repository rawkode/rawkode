{ overlays
, pkgs
}:

{
  fonts = {
    fontDir.enable = true;
    fonts = with pkgs; [
      monaspace
    ];
  };

  nixpkgs = {
    config = {
      allowBroken = true;
      allowUnfree = true;
      allowUnsupportedSystem = true;
    };
    inherit overlays;
  };

	nix = {
    package = pkgs.nix;
    gc = {
      automatic = true;
      interval.Day = 7;
      options = "--delete-older-than 7d";
    };
    extraOptions = ''
      auto-optimise-store = true
      experimental-features = nix-command flakes
    '';
  };

  security.pam.enableSudoTouchIdAuth = true;

  services.nix-daemon.enable = true;

  system = import ./macos.nix { inherit pkgs; };

	programs.zsh.enable = true;

	# programs.nushell.enable = true;

  users.users.${pkgs.username} = {
    name = pkgs.username;
    home = pkgs.homeDirectory;
		shell = pkgs.nushell;
  };

	# environment = {
  #   shells = with pkgs; [ nushell ];
	# 	variables = {                         # Environment Variables
  #     DAVID = "RAWKODE";
  #   };
	# }
}
