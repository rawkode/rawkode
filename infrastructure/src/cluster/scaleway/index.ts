import * as scaleway from "@jaxxstorm/pulumi-scaleway";
import * as kubernetes from "@pulumi/kubernetes";
import { ClusterArgs } from "../";

export const createCluster = (config: ClusterArgs): kubernetes.Provider => {
  const scalewayCluster = new scaleway.KubernetesCluster(config.name, {
    cni: "cilium",
    version: "1.23.2",
    type: "kapsule",
    deleteAdditionalResources: true,
  });

  const scalewayNodePoolEssential = new scaleway.KubernetesNodePool(
    "essential",
    {
      clusterId: scalewayCluster.id,
      nodeType: "GP1-XS",
      containerRuntime: "containerd",
      minSize: 1,
      maxSize: 3,
      size: 1,
      autoscaling: false,
      autohealing: true,
    }
  );

  const scalewayNodePoolEphemeral = new scaleway.KubernetesNodePool(
    "ephemeral",
    {
      clusterId: scalewayCluster.id,
      nodeType: "DEV1-L",
      containerRuntime: "containerd",
      minSize: 1,
      maxSize: 5,
      size: 1,
      autoscaling: true,
      autohealing: true,
    }
  );

  return new kubernetes.Provider("platform", {
    kubeconfig: scalewayCluster.kubeconfigs[0].configFile,
  });
};
