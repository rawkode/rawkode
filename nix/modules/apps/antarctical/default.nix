{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;

  kororaCache = {
    extra-substituters = [ "https://korora-tech.cachix.org" ];
    extra-trusted-public-keys = [
      "korora-tech.cachix.org-1:42bs8TVW3uvxvMnuJtkXP5lkHFK7++Sral9uRDautuA="
    ];
  };
in
mkApp {
  name = "antarctical";

  linux.home =
    { pkgs, ... }:
    {
      nix.settings = kororaCache;
      home.packages = [ inputs.antarctical.packages.${pkgs.stdenv.hostPlatform.system}.default ];
    };

  linux.system = _: {
    nix.settings = kororaCache;
  };
}
