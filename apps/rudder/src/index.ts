import * as pulumi from "@pulumi/pulumi";
import * as civo from "@pulumi/civo";
import * as kubernetes from "@pulumi/kubernetes";

const stack = pulumi.runtime.getStack();

const kubernetesCluster = new civo.KubernetesCluster(
  `kubernetesCluster`,
  {
    name: `rudder-${stack}`,
    kubernetesVersion: "1.21.0+k3s1",
    region: "lon1",
    numTargetNodes: 3,
    targetNodesSize: "g3.k3s.small",
  },
  {
    deleteBeforeReplace: true,
  }
);

export const kubernetesClusterUrn = kubernetesCluster.urn;

const provider = new kubernetes.Provider("cluster", {
  kubeconfig: kubernetesCluster.kubeconfig,
});

const argoCDNamespace = new kubernetes.core.v1.Namespace(
  "argocd",
  {
    metadata: {
      name: "argocd",
    },
  },
  {
    provider,
  }
);

const argoDeploy = new kubernetes.yaml.ConfigFile(
  "argo",
  {
    file: "https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml",
  },
  {
    provider,
  }
);
