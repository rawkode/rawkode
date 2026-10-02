{ inputs, ... }:
{
  machines.p4x-studio = inputs.rawkos.devenvMachines.p4x-studio // {
    target.host = "rawkode@p4x-studio";
  };
}
