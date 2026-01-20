# NOTE: App imports have been removed from this profile.
# Apps should now be managed via the `apps` parameter in mkUser,
# which provides type-safe, explicit app management via appBundles.
#
# This profile now only contains infrastructure-level home-manager config.
{
  flake.homeModules.profiles-home = _: {
    # Infrastructure-level home-manager settings can go here
    # Apps should be added via the `apps` parameter in mkUser
  };
}
