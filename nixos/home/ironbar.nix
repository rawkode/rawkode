{
  "anchor_to_edges" = true;
  position = "top";
  height = 30;
  margin = {
    top = 4;
    bottom = 2;
    left = 8;
    right = 4;
  };
  start = [
    {
      type = "workspaces";
      "all_monitors" = false;
      "name_map" = {
        "11" = "1";
        "12" = "2";
        "13" = "3";
        "14" = "4";
        "15" = "5";
        "16" = "6";
        "17" = "7";
        "18" = "8";
        "19" = "9";
      };
    }
  ];
  center = [
    {
      type = "focused";
      truncate = {
        "max_length" = 50;
        mode = "end";
      };
    }
  ];
  end = [
    { type = "tray"; }
    {
      type = "volume";
      format = "{icon}  {percentage}%";
      "max_volume" = 100;
      icons = {
        "volume_high" = "󰕾";
        "volume_medium" = "󰖀";
        "volume_low" = "󰕿";
        muted = "󰝟";
      };
    }
    {
      type = "clipboard";
      "max_items" = 3;
      truncate = {
        mode = "end";
        length = 50;
      };
    }
    {
      type = "clock";
      format = "%m/%d %H:%M";
    }
    {
      type = "notifications";
      "show_count" = true;
      icons = {
        "closed_none" = "󰍥";
        "closed_some" = "󱥂";
        "closed_dnd" = "󱅯";
        "open_none" = "󰍡";
        "open_some" = "󱥁";
        "open_dnd" = "󱅮";
      };
    }
  ];
}
