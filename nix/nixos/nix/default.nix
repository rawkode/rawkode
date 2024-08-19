{
  lib,
  pkgs,
  outputs,
  platform,
  username,
  ...
}:
{
  imports = [ ./substituters.nix ];

  nix = {
    package = pkgs.nixVersions.git;

    gc = {
      automatic = true;
      dates = "daily";
      options = "--delete-older-than 7d";
    };

    optimise.automatic = true;
    settings = {
      trusted-users = [ username ];
      auto-optimise-store = true;
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      warn-dirty = false;

      # for direnv GC roots
      keep-derivations = true;
      keep-outputs = true;
    };
  };

  nixpkgs = {
    hostPlatform = lib.mkDefault "${platform}";

    overlays = [
      outputs.overlays.stable-packages
    ];

    config = {
      allowUnfree = true;
    };
  };
}
