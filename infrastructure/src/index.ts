import * as pulumi from "@pulumi/pulumi";
import * as metal from "@pulumi/equinix-metal";
import { Cluster } from "./kubernetes";
import { zone as rawkodeSh } from "./dns/rawkode.sh";

const stackName = pulumi.getStack();
const config = new pulumi.Config();

const kubernetesCluster = new Cluster(stackName, {
  kubernetesVersion: "1.21.2",
  metro: "am",
  projectId: "a5e0d3df-649a-4566-898f-5d96fb0ccff7",
  dnsZone: rawkodeSh,
});

kubernetesCluster.createControlPlane({
  highAvailability: false,
  plan: metal.Plan.C1SmallX86,
});

kubernetesCluster.createWorkerPool("stateless", {
  kubernetesVersion: "1.21.2",
  plan: metal.Plan.C1SmallX86,
  replicas: 1,
});
