package website

import "alpha.dagger.io/os"
import "alpha.dagger.io/js/yarn"

code: os.#Dir & {
  from: src
  path: "./websites/rawkode.dev"
}

yarn.#Package & {
  source:   code
  cwd:      "."
  buildDir: ".vercel_build_output"
  script: "build"
}
