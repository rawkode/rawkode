{
  flake.nixosModules.garnix = {
    nix = {
      settings = {
        extra-substituters = [ "https://cache.garnix.io" ];
        extra-trusted-public-keys = [ "cache.garnix.io:CTFPyKSLcx5RMJKfLo5EEPUObbA78b0YQ2DTCJXqr9g=" ];
      };
    };
  };
}
