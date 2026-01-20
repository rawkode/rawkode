{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "flox";

  common.home = {
    nix = {
      settings = {
        extra-substituters = [ "https://cache.flox.dev" ];
        extra-trusted-public-keys = [ "flox-cache-public-1:7F4OyH7ZCnFhcze3fJdfyXYLQw/aV7GEed86nQ7IsOs=" ];
      };
    };
  };
}
