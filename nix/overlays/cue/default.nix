{ channels, ... }:
final: prev: {
  inherit (channels.cue) cue;
}
