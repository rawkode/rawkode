import { defineModule, install } from "@rawkode/dhd"

export default defineModule({
  name: "google-cloud",
  tags: ["cloud", "development"],
  when: [{ platformIn: ["linux", "darwin"] }],
}).actions([
  // Install Google Cloud SDK
  install("google-cloud-sdk", { brew: "google-cloud-sdk" }),

  // Note: Additional components can be installed with:
  // gcloud components install COMPONENT_ID
  // For example:
  // - gke-gcloud-auth-plugin (included in some package managers)
  // - kubectl
  // - docker-credential-gcr
])
