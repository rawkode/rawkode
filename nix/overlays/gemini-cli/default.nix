{ channels, ... }:
final: prev: {
  inherit (channels.unstable) gemini-cli;
}
