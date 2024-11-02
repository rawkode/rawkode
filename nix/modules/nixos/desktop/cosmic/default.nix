{
  services.desktopManager.cosmic.enable = true;
  services.displayManager.cosmic-greeter.enable = false;

  nix = {
    settings = {
      substituters = [ "https://cosmic.cachix.org" ];
      trusted-public-keys =
        [ "cosmic.cachix.org-1:Dya9IyXD4xdBehWjrkPv6rtxpmMdRel02smYzA85dPE=" ];
    };
  };
}
