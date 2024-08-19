{
  imports = [
    ./1password.nix
    ./containers.nix
    # ./espanso.nix
    ./tailscale.nix
    ./waydroid.nix
  ];

  programs = {
    command-not-found.enable = false;

    dconf = {
      enable = true;
      profiles.gdm.databases = [
        { settings."org/gnome/login-screen".enable-fingerprint-authentication = true; }
      ];
    };

    fish.enable = true;

    git.enable = true;

    kdeconnect.enable = true;

    zsh.enable = true;
  };
}
