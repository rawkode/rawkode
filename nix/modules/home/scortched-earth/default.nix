{ ... }:
{
  home.persistence = {
  "/persist/home" = {
    directories = [
      "Code"
      "Documents"
      "Downloads"
      "Pictures"
      "Videos"
    ];
    
    allowOther = true;
  };
};
}