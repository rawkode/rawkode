{
  flake.nixosModules.below = {
    services.below.enable = true;

    # The zstd-sys crate links the system libzstd through pkg-config, which
    # nixpkgs' below package does not list as a build input. The NixOS module
    # has no package option, so the fix has to be an overlay.
    nixpkgs.overlays = [
      (_final: prev: {
        below = prev.below.overrideAttrs (old: {
          buildInputs = (old.buildInputs or [ ]) ++ [ prev.zstd ];
        });
      })
    ];
  };
}
