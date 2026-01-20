{
  flake.homeModules.profiles-users-common =
    { inputs, ... }:
    {
      imports = [
        inputs.nix-index-database.homeModules.nix-index
        inputs.nur.modules.homeManager.default

        inputs.self.homeModules.ai
        inputs.self.homeModules.profiles-home
        inputs.self.homeModules.profiles-desktop
        inputs.self.homeModules.nix-home
        # Note: stylix is NOT imported here because:
        # - On NixOS: comes from nixosModules.stylix (propagates to home-manager)
        # - On Darwin: should be imported via darwinImports in user config
      ];
    };
}
