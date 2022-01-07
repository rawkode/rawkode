package svelte

import "alpha.dagger.io/dagger"
import "alpha.dagger.io/os"
import "alpha.dagger.io/js/yarn"

#Build: {
  src: dagger.#Artifact & dagger.#Input
  path: string

  code: os.#Dir & {
    from: src
    path: path
  }

  yarn.#Package & {
    source:   code
    cwd:      "."
    buildDir: path + "/.vercel_build_output"
    script: "build"
  }
}
