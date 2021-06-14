import * as pulumi from "@pulumi/pulumi";
import * as civo from "@pulumi/civo";
import * as kubernetes from "@pulumi/kubernetes";
import * as ns1 from "@pulumi/ns1";

const stack = pulumi.runtime.getStack();

const config = new pulumi.Config();
const dnsName = config.require("dnsName");

const kubernetesCluster = new civo.KubernetesCluster(
  `awesome-o`,
  {
    name: `awesome-o-${stack}`,
    // kubernetesVersion: "1.21.0+k3s1",
    region: "lon1",
    numTargetNodes: 3,
    targetNodesSize: "g3.k3s.small",
    applications: "-Traefik",
  },
  {
    deleteBeforeReplace: true,
  }
);

export const kubernetesClusterUrn = kubernetesCluster.urn;
export const kubernetesConfig = kubernetesCluster.kubeconfig;

const clusterZone = new ns1.Zone("awesome-o", {
  zone: dnsName,
});

const clusterZoneRecord = new ns1.Record("awesome-o-root", {
  domain: clusterZone.zone,
  zone: clusterZone.zone,
  type: "CNAME",
  ttl: 60,
  answers: [
    {
      answer: kubernetesCluster.dnsEntry,
    },
  ],
});

const wildcardZoneRecord = new ns1.Record("awesome-o-wildcard", {
  domain: pulumi.interpolate`*.${clusterZone.zone}`,
  zone: clusterZone.zone,
  type: "CNAME",
  ttl: 60,
  answers: [
    {
      answer: kubernetesCluster.dnsEntry,
    },
  ],
});

const provider = new kubernetes.Provider(
  "awesome-o",
  {
    kubeconfig: kubernetesCluster.kubeconfig,
  },
  {
    dependsOn: [kubernetesCluster],
  }
);

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
    transformations: [
      (obj: any) => {
        obj.metadata.namespace = argoCDNamespace.metadata.name;
      },
    ],
  },
  {
    provider,
  }
);

const argoTopLevelApp = new kubernetes.apiextensions.CustomResource(
  "cluster-addons",
  {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: "cluster-addons",
      namespace: argoCDNamespace.metadata.name,
    },
    spec: {
      destination: {
        namespace: "default",
        server: "https://kubernetes.default.svc",
      },
      project: "default",
      source: {
        path: "./apps/awesome-o/opt/gitops/cluster-addons",
        repoURL: "https://github.com/rawkode/rawkode",
        targetRevision: "main",
      },
    },
  },
  {
    provider,
  }
);
