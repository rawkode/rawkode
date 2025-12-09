import {
  defineModule,
  dock,
  finder,
  missionControl,
  defaults,
} from "@rawkode/dhd"

export default defineModule({
  name: "macos",
  tags: ["system", "macos"],
  when: [{ platformIn: ["darwin"] }],
}).actions([
  ...dock({
    autohide: true,
    autohideDelay: 0,
    autohideTimeModifier: 0.15,
    tileSize: 64,
    magnification: true,
    magnificationSize: 128,
    orientation: "bottom",
    minimizeToApplication: true,
    showIndicatorLights: true,
    showRecents: false,
  }),

  ...finder({
    defaultViewStyle: "Nlsv",
    newWindowTarget: "PfAF",
    desktopShowHardDrives: false,
    desktopShowExternalDrives: true,
    desktopShowRemovableDrives: true,
  }),

  ...missionControl({
    animationSpeed: 0.2,
    groupByApp: true,
    autoRearrangeSpaces: false,
    separateSpaces: true,
    hotCorners: {
      topLeft: "missionControl",
      topRight: "none",
      bottomLeft: "appWindows",
      bottomRight: "desktop",
    },
  }),

  defaults("NSGlobalDomain", "AppleInterfaceStyleSwitchesAutomatically", true),
  defaults("NSGlobalDomain", "NSFileViewer", "com.asiafu.Bloom"),
])
