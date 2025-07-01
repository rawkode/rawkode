{ channels, ... }:
final: prev: {
  inherit (channels.moon) moon;
}
