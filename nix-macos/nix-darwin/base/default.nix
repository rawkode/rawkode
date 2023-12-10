{ overlays
, pkgs
}:

{
  fonts = {
    fontDir.enable = true;
    fonts = with pkgs; [
      recursive
    ];
  };

  networking.computerName = "${pkgs.username}-${pkgs.system}";

  nix = import ./nix.nix;

  nixpkgs = {
    config = {
      allowBroken = true;
      allowUnfree = true;
      allowUnsupportedSystem = true;
    };
    inherit overlays;
  };

  programs = {
    ssh = {
      knownHosts = {
        nixbuild = {
          hostNames = [ "eu.nixbuild.net" ];
          publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPIQCZc54poJ8vqawd8TraNryQeJnvH1eLpIDgbiqymM";
        };
      };
    };
  };

  security.pam.enableSudoTouchIdAuth = true;

  services.nix-daemon.enable = true;

  system = import ./macos.nix { inherit pkgs; };

  users.users.${pkgs.username} = {
    name = pkgs.username;
    home = pkgs.homeDirectory;
  };
}