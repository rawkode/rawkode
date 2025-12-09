import { defaults } from "../api.ts";
import type { ActionT } from "../schema.ts";

// Dock configuration
export interface DockOptions {
  autohide?: boolean;
  autohideDelay?: number;
  autohideTimeModifier?: number;
  magnification?: boolean;
  magnificationSize?: number;
  tileSize?: number;
  orientation?: "bottom" | "left" | "right";
  minimizeEffect?: "genie" | "scale" | "suck";
  minimizeToApplication?: boolean;
  showIndicatorLights?: boolean;
  showRecents?: boolean;
  staticOnly?: boolean;
  scrollToOpen?: boolean;
}

export function dock(options: DockOptions): ActionT[] {
  const actions: ActionT[] = [];
  const domain = "com.apple.dock";

  if (options.autohide !== undefined) {
    actions.push(defaults(domain, "autohide", options.autohide));
  }
  if (options.autohideDelay !== undefined) {
    actions.push(defaults(domain, "autohide-delay", options.autohideDelay, { valueType: "float" }));
  }
  if (options.autohideTimeModifier !== undefined) {
    actions.push(
      defaults(domain, "autohide-time-modifier", options.autohideTimeModifier, {
        valueType: "float",
      }),
    );
  }
  if (options.magnification !== undefined) {
    actions.push(defaults(domain, "magnification", options.magnification));
  }
  if (options.magnificationSize !== undefined) {
    actions.push(defaults(domain, "largesize", options.magnificationSize, { valueType: "int" }));
  }
  if (options.tileSize !== undefined) {
    actions.push(defaults(domain, "tilesize", options.tileSize, { valueType: "int" }));
  }
  if (options.orientation !== undefined) {
    actions.push(defaults(domain, "orientation", options.orientation));
  }
  if (options.minimizeEffect !== undefined) {
    actions.push(defaults(domain, "mineffect", options.minimizeEffect));
  }
  if (options.minimizeToApplication !== undefined) {
    actions.push(defaults(domain, "minimize-to-application", options.minimizeToApplication));
  }
  if (options.showIndicatorLights !== undefined) {
    actions.push(defaults(domain, "show-process-indicators", options.showIndicatorLights));
  }
  if (options.showRecents !== undefined) {
    actions.push(defaults(domain, "show-recents", options.showRecents));
  }
  if (options.staticOnly !== undefined) {
    actions.push(defaults(domain, "static-only", options.staticOnly));
  }
  if (options.scrollToOpen !== undefined) {
    actions.push(defaults(domain, "scroll-to-open", options.scrollToOpen));
  }

  return actions;
}

// Finder configuration
export interface FinderOptions {
  showHiddenFiles?: boolean;
  showPathBar?: boolean;
  showStatusBar?: boolean;
  showExtensions?: boolean;
  defaultViewStyle?: "icnv" | "Nlsv" | "clmv" | "Flwv";
  newWindowTarget?: "PfHm" | "PfDe" | "PfDo" | "PfAF";
  desktopShowHardDrives?: boolean;
  desktopShowExternalDrives?: boolean;
  desktopShowRemovableDrives?: boolean;
  desktopShowServers?: boolean;
  warningOnEmptyTrash?: boolean;
  warningOnChangeExtension?: boolean;
  searchScope?: "SCev" | "SCcf" | "SCsp";
  keepFoldersOnTop?: boolean;
}

export function finder(options: FinderOptions): ActionT[] {
  const actions: ActionT[] = [];
  const domain = "com.apple.finder";

  if (options.showHiddenFiles !== undefined) {
    actions.push(defaults(domain, "AppleShowAllFiles", options.showHiddenFiles));
  }
  if (options.showPathBar !== undefined) {
    actions.push(defaults(domain, "ShowPathbar", options.showPathBar));
  }
  if (options.showStatusBar !== undefined) {
    actions.push(defaults(domain, "ShowStatusBar", options.showStatusBar));
  }
  if (options.showExtensions !== undefined) {
    actions.push(defaults("NSGlobalDomain", "AppleShowAllExtensions", options.showExtensions));
  }
  if (options.defaultViewStyle !== undefined) {
    actions.push(defaults(domain, "FXPreferredViewStyle", options.defaultViewStyle));
  }
  if (options.newWindowTarget !== undefined) {
    actions.push(defaults(domain, "NewWindowTarget", options.newWindowTarget));
  }
  if (options.desktopShowHardDrives !== undefined) {
    actions.push(defaults(domain, "ShowHardDrivesOnDesktop", options.desktopShowHardDrives));
  }
  if (options.desktopShowExternalDrives !== undefined) {
    actions.push(
      defaults(domain, "ShowExternalHardDrivesOnDesktop", options.desktopShowExternalDrives),
    );
  }
  if (options.desktopShowRemovableDrives !== undefined) {
    actions.push(
      defaults(domain, "ShowRemovableMediaOnDesktop", options.desktopShowRemovableDrives),
    );
  }
  if (options.desktopShowServers !== undefined) {
    actions.push(defaults(domain, "ShowMountedServersOnDesktop", options.desktopShowServers));
  }
  if (options.warningOnEmptyTrash !== undefined) {
    actions.push(defaults(domain, "WarnOnEmptyTrash", options.warningOnEmptyTrash));
  }
  if (options.warningOnChangeExtension !== undefined) {
    actions.push(
      defaults(domain, "FXEnableExtensionChangeWarning", options.warningOnChangeExtension),
    );
  }
  if (options.searchScope !== undefined) {
    actions.push(defaults(domain, "FXDefaultSearchScope", options.searchScope));
  }
  if (options.keepFoldersOnTop !== undefined) {
    actions.push(defaults(domain, "_FXSortFoldersFirst", options.keepFoldersOnTop));
  }

  return actions;
}

// Keyboard configuration
export interface KeyboardOptions {
  keyRepeatRate?: number;
  keyRepeatDelay?: number;
  automaticCapitalization?: boolean;
  automaticSpelling?: boolean;
  automaticPeriodSubstitution?: boolean;
  automaticQuoteSubstitution?: boolean;
  automaticDashSubstitution?: boolean;
  pressAndHoldEnabled?: boolean;
}

export function keyboard(options: KeyboardOptions): ActionT[] {
  const actions: ActionT[] = [];

  if (options.keyRepeatRate !== undefined) {
    actions.push(
      defaults("NSGlobalDomain", "KeyRepeat", options.keyRepeatRate, { valueType: "int" }),
    );
  }
  if (options.keyRepeatDelay !== undefined) {
    actions.push(
      defaults("NSGlobalDomain", "InitialKeyRepeat", options.keyRepeatDelay, { valueType: "int" }),
    );
  }
  if (options.automaticCapitalization !== undefined) {
    actions.push(
      defaults(
        "NSGlobalDomain",
        "NSAutomaticCapitalizationEnabled",
        options.automaticCapitalization,
      ),
    );
  }
  if (options.automaticSpelling !== undefined) {
    actions.push(
      defaults("NSGlobalDomain", "NSAutomaticSpellingCorrectionEnabled", options.automaticSpelling),
    );
  }
  if (options.automaticPeriodSubstitution !== undefined) {
    actions.push(
      defaults(
        "NSGlobalDomain",
        "NSAutomaticPeriodSubstitutionEnabled",
        options.automaticPeriodSubstitution,
      ),
    );
  }
  if (options.automaticQuoteSubstitution !== undefined) {
    actions.push(
      defaults(
        "NSGlobalDomain",
        "NSAutomaticQuoteSubstitutionEnabled",
        options.automaticQuoteSubstitution,
      ),
    );
  }
  if (options.automaticDashSubstitution !== undefined) {
    actions.push(
      defaults(
        "NSGlobalDomain",
        "NSAutomaticDashSubstitutionEnabled",
        options.automaticDashSubstitution,
      ),
    );
  }
  if (options.pressAndHoldEnabled !== undefined) {
    actions.push(
      defaults("NSGlobalDomain", "ApplePressAndHoldEnabled", options.pressAndHoldEnabled),
    );
  }

  return actions;
}

// Trackpad configuration
export interface TrackpadOptions {
  tapToClick?: boolean;
  naturalScrolling?: boolean;
  trackingSpeed?: number;
  threeFingerDrag?: boolean;
}

export function trackpad(options: TrackpadOptions): ActionT[] {
  const actions: ActionT[] = [];

  if (options.tapToClick !== undefined) {
    actions.push(defaults("com.apple.AppleMultitouchTrackpad", "Clicking", options.tapToClick));
    actions.push(
      defaults(
        "com.apple.driver.AppleBluetoothMultitouch.trackpad",
        "Clicking",
        options.tapToClick,
      ),
    );
    actions.push(
      defaults("NSGlobalDomain", "com.apple.mouse.tapBehavior", options.tapToClick ? 1 : 0, {
        valueType: "int",
        host: "currentHost",
      }),
    );
  }
  if (options.naturalScrolling !== undefined) {
    actions.push(
      defaults("NSGlobalDomain", "com.apple.swipescrolldirection", options.naturalScrolling),
    );
  }
  if (options.trackingSpeed !== undefined) {
    actions.push(
      defaults("NSGlobalDomain", "com.apple.trackpad.scaling", options.trackingSpeed, {
        valueType: "float",
      }),
    );
  }
  if (options.threeFingerDrag !== undefined) {
    actions.push(
      defaults(
        "com.apple.AppleMultitouchTrackpad",
        "TrackpadThreeFingerDrag",
        options.threeFingerDrag,
      ),
    );
    actions.push(
      defaults(
        "com.apple.driver.AppleBluetoothMultitouch.trackpad",
        "TrackpadThreeFingerDrag",
        options.threeFingerDrag,
      ),
    );
  }

  return actions;
}

// Mission Control configuration
export type HotCornerAction =
  | "none"
  | "missionControl"
  | "appWindows"
  | "desktop"
  | "startScreenSaver"
  | "disableScreenSaver"
  | "dashboard"
  | "sleep"
  | "launchpad"
  | "notificationCenter"
  | "lockScreen";

const hotCornerValues: Record<HotCornerAction, number> = {
  none: 0,
  missionControl: 2,
  appWindows: 3,
  desktop: 4,
  startScreenSaver: 5,
  disableScreenSaver: 6,
  dashboard: 7,
  sleep: 10,
  launchpad: 11,
  notificationCenter: 12,
  lockScreen: 13,
};

export interface MissionControlOptions {
  animationSpeed?: number;
  groupByApp?: boolean;
  separateSpaces?: boolean;
  autoRearrangeSpaces?: boolean;
  hotCorners?: {
    topLeft?: HotCornerAction;
    topRight?: HotCornerAction;
    bottomLeft?: HotCornerAction;
    bottomRight?: HotCornerAction;
  };
}

export function missionControl(options: MissionControlOptions): ActionT[] {
  const actions: ActionT[] = [];
  const domain = "com.apple.dock";

  if (options.animationSpeed !== undefined) {
    actions.push(
      defaults(domain, "expose-animation-duration", options.animationSpeed, { valueType: "float" }),
    );
  }
  if (options.groupByApp !== undefined) {
    actions.push(defaults(domain, "expose-group-apps", options.groupByApp));
  }
  if (options.separateSpaces !== undefined) {
    actions.push(defaults("com.apple.spaces", "spans-displays", !options.separateSpaces));
  }
  if (options.autoRearrangeSpaces !== undefined) {
    actions.push(defaults(domain, "mru-spaces", options.autoRearrangeSpaces));
  }

  if (options.hotCorners) {
    const corners = [
      { key: "wvous-tl-corner", mod: "wvous-tl-modifier", value: options.hotCorners.topLeft },
      { key: "wvous-tr-corner", mod: "wvous-tr-modifier", value: options.hotCorners.topRight },
      { key: "wvous-bl-corner", mod: "wvous-bl-modifier", value: options.hotCorners.bottomLeft },
      { key: "wvous-br-corner", mod: "wvous-br-modifier", value: options.hotCorners.bottomRight },
    ];
    for (const corner of corners) {
      if (corner.value !== undefined) {
        actions.push(
          defaults(domain, corner.key, hotCornerValues[corner.value], { valueType: "int" }),
        );
        actions.push(defaults(domain, corner.mod, 0, { valueType: "int" }));
      }
    }
  }

  return actions;
}

// Screen saver and security
export interface ScreenSaverOptions {
  requirePasswordAfterSleep?: boolean;
  passwordDelay?: number;
}

export function screenSaver(options: ScreenSaverOptions): ActionT[] {
  const actions: ActionT[] = [];

  if (options.requirePasswordAfterSleep !== undefined) {
    actions.push(
      defaults(
        "com.apple.screensaver",
        "askForPassword",
        options.requirePasswordAfterSleep ? 1 : 0,
        { valueType: "int" },
      ),
    );
  }
  if (options.passwordDelay !== undefined) {
    actions.push(
      defaults("com.apple.screensaver", "askForPasswordDelay", options.passwordDelay, {
        valueType: "int",
      }),
    );
  }

  return actions;
}
