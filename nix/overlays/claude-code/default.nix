{ channels, ... }:

final: prev: {
  inherit (channels.nixpkgs-unstable) claude-code;
}
