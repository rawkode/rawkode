{ channels, ... }:

final: prev: {
  inherit (channels.nixpkgs-unstable) deno;
}
