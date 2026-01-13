{ inputs, ... }:
{
  flake.nixosModules.profiles-amd =
    { ... }:
    {
      imports = [
        inputs.self.nixosModules.amdctl
        inputs.self.nixosModules.lact
        inputs.self.nixosModules.hardware-amd
        inputs.self.nixosModules.hardware-cpu-amd
        inputs.self.nixosModules.hardware-gpu-amd
      ];
    };
}
