{ channels, ... }:
final: prev: {
  inherit (channels.master) moon;
}
