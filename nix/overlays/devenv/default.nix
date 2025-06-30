{ channels, ... }:
final: prev: {
    # https://github.com/cachix/devenv/issues/1957
    inherit (channels.unstable) devenv;
}
