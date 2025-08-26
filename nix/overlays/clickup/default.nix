{ channels, ... }:
final: prev: {
  inherit (channels.clickup) clickup;
}
