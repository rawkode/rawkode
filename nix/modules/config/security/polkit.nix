{
  flake.nixosModules.polkit = _: {
    # Ensure the system-wide polkit daemon is running
    security.polkit.enable = true;
  };
}
