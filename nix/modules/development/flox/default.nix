_: {
  flake.homeModules.development-flox = {
    nix = {
      settings = {
        extra-substituters = [ "https://cache.flox.dev" ];
        extra-trusted-public-keys = [ "flox-cache-public-1:7F4OyH7ZCnFhcze3fJdfyXYLQw/aV7GEed86nQ7IsOs=" ];
      };
    };
  };
}
