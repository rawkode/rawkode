{
  flake.homeModules.profiles-users-common =
    { inputs, ... }:
    {
      imports = [
        inputs.nix-index-database.homeModules.nix-index
        inputs.nur.modules.homeManager.default
        inputs.self.homeModules.nix-home
      ];
    };
}
