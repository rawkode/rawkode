import * as pulumi from "@pulumi/pulumi";
import * as gcpLegacy from "@pulumi/gcp";
import * as gcp from "@pulumi/google-native";

const enableCloudResourceManager = new gcpLegacy.projects.Service(
  "cloud-resource-manager",
  {
    service: "cloudresourcemanager.googleapis.com",
  }
);

const enableCloudRun = new gcpLegacy.projects.Service("cloud-run", {
  service: "run.googleapis.com",
});

const enableCloudFunctions = new gcpLegacy.projects.Service("cloud-functions", {
  service: "cloudfunctions.googleapis.com",
});

const bucket = new gcp.storage.v1.Bucket(
  "opengraph.rawkode.dev",
  {
    name: "opengraph.rawkode.dev",
    location: "europe-west4",
  },
  {
    // We don't need to protect this,
    // as all images stored here are only
    // a cache
    deleteBeforeReplace: true,
  }
);
