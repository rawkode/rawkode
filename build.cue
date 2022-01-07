package main

import "alpha.dagger.io/dagger"
import "rawkode.dev/websites/opengraph.rawkode.dev:opengraph"
import "rawkode.dev/websites/rawkode.dev:website"

src: dagger.#Artifact & dagger.#Input

websites: {
  "opengraph.rawkode.dev": opengraph,
  "rawkode.dev": website,
}
