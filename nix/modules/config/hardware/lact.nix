{
  flake.nixosModules.lact = _: {
    services.lact.enable = true;
  };
}
