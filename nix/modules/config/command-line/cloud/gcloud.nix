{
  flake.darwinModules.gcloud =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "gcloud-cli" ];
      };
    };
}
