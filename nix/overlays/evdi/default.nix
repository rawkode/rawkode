{ channels, ... }:

final: prev:

{ inherit (channels.nixpkgs-unstable) linuxKernel; }
