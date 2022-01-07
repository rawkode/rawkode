package opengraphrawkodedev

import "alpha.dagger.io/os"
import "alpha.dagger.io/js/yarn"

#Build: {
  dir: os.#Dir

  yarn.#Package & {
    source:   dir
    cwd:      "."
    buildDir: dir.path + "/.vercel_build_output"
    script: "build"
  }
}
