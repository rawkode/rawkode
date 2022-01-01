import * as pulumi from "@pulumi/pulumi";
import * as gcpLegacy from "@pulumi/gcp";
import * as gcp from "@pulumi/google-native";

const enableCloudResourceManager = new gcpLegacy.projects.Service(
  "cloud-resource-manager",
  {
    service: "cloudresourcemanager.googleapis.com",
  }
);

const enableCloudBuild = new gcpLegacy.projects.Service("cloud-build", {
  service: "cloudbuild.googleapis.com",
});

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

let funcArchive = new pulumi.asset.AssetArchive({
  ".": new pulumi.asset.FileArchive("../cloud-function"),
});

const s = new gcp.storage.v1.BucketObject("function-opengraph", {
  bucket: bucket.name,
  source: funcArchive,
});

const func = new gcp.cloudfunctions.v1.Function(
  "opengraph",
  {
    location: "europe-west3",
    runtime: "nodejs14",
    entryPoint: "handler",
    sourceArchiveUrl: pulumi.interpolate`gs://opengraph.rawkode.dev/${s.name}`,
    httpsTrigger: {
      securityLevel: "SECURE_ALWAYS",
    },
  },
  {
    dependsOn: [enableCloudFunctions, enableCloudBuild],
  }
);
