{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "foundation";

  home = {
    imports = with inputs.self; [
      homeModules.profiles-users-common
      homeModules.stylix

      appBundles.bat.home
      appBundles.btop.home
      appBundles.eza.home
      appBundles.htop.home
      appBundles.jq.home
      appBundles.misc.home
      appBundles.ripgrep.home

      appBundles.atuin.home
      appBundles.carapace.home
      appBundles.fish.home
      appBundles.nushell.home
      appBundles.starship.home
      appBundles.zoxide.home

      appBundles.git.home
      appBundles.github.home
      appBundles.jj.home
    ];
  };
}
