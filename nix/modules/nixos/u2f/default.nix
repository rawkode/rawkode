{ ... }:
{
  security.pam = {
    services = {
      login.u2fAuth = false;
      sudo.u2fAuth = true;
    };

    yubico = {
      enable = true;
      debug = false;
      mode = "challenge-response";
      id = [ "9093048" ];
    };
  };
}
