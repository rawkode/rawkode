{ channels, ... }:
final: prev: {
  linuxPackages = prev.linuxPackages // {
    v4l2loopback = channels.v4l2.linuxPackages.v4l2loopback;
  };
}
