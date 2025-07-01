{ channels, ... }:
final: prev: {
  inherit (channels.unstable) claude-code;
}
