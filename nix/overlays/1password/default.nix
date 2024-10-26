{ channels, ... }:

final: prev:

{ inherit (channels.unstable) _1password-gui-beta _1password-cli; }