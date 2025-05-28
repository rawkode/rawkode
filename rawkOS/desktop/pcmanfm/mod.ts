import { defineModule } from "../../core/module-builder.ts";

export default defineModule("pcmanfm")
  .description("PCManFM file manager")
  .tags("desktop", "file-manager")
  .packageInstall({
    manager: "pacman",
    packages: ["pcmanfm-gtk3"],
  })
  .build();
