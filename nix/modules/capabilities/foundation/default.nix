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

      appBundles.atuin.home
      appBundles.bat.home
      appBundles.btop.home
      appBundles.carapace.home
      appBundles.eza.home
      appBundles.fish.home
      appBundles.git.home
      appBundles.github.home
      appBundles.htop.home
      appBundles.jj.home
      appBundles.jq.home
      appBundles.misc.home
      appBundles.nushell.home
      appBundles.ouch.home
      appBundles.ripgrep.home
      appBundles.starship.home
      appBundles.zoxide.home
    ];
  };
}
