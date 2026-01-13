{
  flake.homeModules.development =
    # Development tools and environments
    {
      inputs,
      ...
    }:

    {
      imports = with inputs.self.homeModules; [
        development-bun
        development-dagger
        development-deno
        development-devenv
        development-distrobox
        development-flox
        development-go
        development-kubernetes
        development-moon
        development-nix
        development-podman
        development-python
        development-rust
      ];
    };
}
