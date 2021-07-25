import * as pulumi from "@pulumi/pulumi";
import * as metal from "@pulumi/equinix-metal";
import rawkodeSh from "./dns/rawkode.sh";
import rawkodeDev from "./dns/rawkode.dev";
import { Cluster } from "./kubernetes";

const config = new pulumi.Config();

const kubernetesCluster = new Cluster("rawkode", {
  kubernetesVersion: "1.21.2",
  metro: "am",
  projectId: "a5e0d3df-649a-4566-898f-5d96fb0ccff7",
  dns: rawkodeSh,
});

kubernetesCluster.createControlPlane({
  highAvailability: false,
  plan: metal.Plan.C1SmallX86,
  metalAuthToken: config.requireSecret("metalAuthToken"),
});

kubernetesCluster.createWorkerPool("stateless", {
  kubernetesVersion: "1.21.2",
  plan: metal.Plan.C1SmallX86,
  replicas: 1,
});
