_:
let
  noopModule = _: { };

  toModule =
    value:
    if value == null then
      noopModule
    else if builtins.isList value then
      { ... }:
      {
        imports = value;
      }
    else
      value;
in
{
  name,
  home ? null,
  nixos ? null,
  darwin ? null,
}:
let
  homeModule = toModule home;
  nixosModule = toModule nixos;
  darwinModule = toModule darwin;
in
{
  flake.homeModules.${name} = homeModule;
  flake.nixosModules.${name} = nixosModule;
  flake.darwinModules.${name} = darwinModule;

  flake.capabilityBundles.${name} = {
    home = homeModule;
    nixos = nixosModule;
    darwin = darwinModule;
  };
}
