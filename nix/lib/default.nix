{
  inputs,
  outputs,
  stateVersion,
	username,
  ...
}:
let
  helpers = import ./helpers.nix { inherit username inputs outputs stateVersion; };
in
{
  inherit (helpers) mkHome mkNixos forAllSystems;
}
