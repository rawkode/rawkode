{
  flake.homeModules.profiles-users-common =
    { inputs, ... }:
    {
      imports = with inputs; [
        nix-index-database.homeModules.nix-index
        nur.modules.homeManager.default

        self.homeModules.ai
        self.homeModules.profiles-home
        self.homeModules.profiles-desktop
        self.homeModules.nix-home
        # Note: stylix is NOT imported here because:
        # - On NixOS: comes from nixosModules.stylix (propagates to home-manager)
        # - On Darwin: should be imported via darwinImports in user config
      ];
    };
}
