import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as scaleway from "@jaxxstorm/pulumi-scaleway";

import { managedDomains as domains } from "./dns";
import { Cluster } from "./cluster";

export const managedDomains = domains.reduce(
  (zones, domain) =>
    Object.assign(zones, { [domain.domainName]: domain.zone.id }),
  {}
);

const clusterDomain = domains.find(
  (domain) => domain.domainName === "rawkode.sh"
);

if (!clusterDomain) {
  throw new Error("clusterDomain, rawkode.sh, not found");
}

const scalewayCluster = new scaleway.KubernetesCluster("rawkode-production", {
  name: "rawkode-production",
  cni: "cilium",
  version: "1.23.2",
  type: "kapsule",
  deleteAdditionalResources: true,
});

const scalewayNodePoolEssential = new scaleway.KubernetesNodePool("essential", {
  clusterId: scalewayCluster.id,
  nodeType: "GP1-XS",
  containerRuntime: "containerd",
  minSize: 1,
  maxSize: 3,
  size: 1,
  autoscaling: false,
  autohealing: true,
});

const scalewayNodePoolEphemeral = new scaleway.KubernetesNodePool("ephemeral", {
  clusterId: scalewayCluster.id,
  nodeType: "DEV1-L",
  containerRuntime: "containerd",
  minSize: 1,
  maxSize: 5,
  size: 1,
  autoscaling: true,
  autohealing: true,
});

const config = new pulumi.Config();

const cluster: Cluster = {
  provider: new k8s.Provider("platform", {
    kubeconfig: scalewayCluster.kubeconfigs[0].configFile,
  }),
};

import { create as createPlatform } from "./platform";
createPlatform({
  cluster,
});

// IngressController
// const ingressController = new k8s.helm.v3.Release(
//   "ingress-controller",
//   {
//     chart: "contour",
//     name: "contour",
//     repositoryOpts: {
//       repo: "https://charts.bitnami.com/bitnami",
//     },
//     version: "7.3.3",
//     namespace: "kube-system",
//     values: {
//       defaultBackend: {
//         enabled: true,
//         containerPorts: {
//           http: 8080,
//         },
//       },
//       envoy: {
//         useHostPort: false,
//       },
//     },
//     skipAwait: true,
//   },
//   {
//     provider: cluster.provider,
//   }
// );

// const svc = k8s.core.v1.Service.get(
//   "ingress-controller-service",
//   pulumi.interpolate`${ingressController.status.namespace}/${ingressController.status.name}-contour-envoy`,
//   {
//     provider: cluster.provider,
//   }
// );

// svc.status.loadBalancer.ingress[0].ip.apply((ip) => {
//   clusterDomain.createRecord("@", "A", [ip]);
//   clusterDomain.createRecord("*", "A", [ip]);
// });

// import { install as installPulumiOperator } from "./pulumi-operator";

// Until fix for #971 is released
// const academyNamespace = new k8s.core.v1.Namespace(
//   "academy",
//   {
//     metadata: {
//       name: "academy",
//     },
//   },
//   {
//     provider: cluster.provider,
//   }
// );

// const academyNamespace = k8s.core.v1.Namespace.get(
//   "academy-namespace",
//   "default"
// );

// const operatorDeployment = installPulumiOperator(
//   cluster.provider,
//   academyNamespace.metadata.name
// );

// const pulumiConfig = new pulumi.Config();
// const pulumiAccessToken = pulumiConfig.requireSecret("pulumiAccessToken");

// const accessToken = new k8x.Secret(
//   "accesstoken",
//   {
//     metadata: {
//       namespace: academyNamespace.metadata.name,
//     },
//     stringData: { accessToken: pulumiAccessToken },
//   },
//   {
//     provider: cluster.provider,
//   }
// );

// const rawkodeAcademyPlatform = new k8s.apiextensions.CustomResource(
//   "rawkode-academy-platform",
//   {
//     apiVersion: "pulumi.com/v1",
//     kind: "Stack",
//     metadata: {
//       namespace: academyNamespace.metadata.name,
//     },
//     spec: {
//       envRefs: {
//         PULUMI_ACCESS_TOKEN: {
//           type: "Secret",
//           secret: {
//             name: accessToken.metadata.name,
//             namespace: accessToken.metadata.namespace,
//             key: "accessToken",
//           },
//         },
//       },
//       stack: clusterDomain.domainName,
//       projectRepo: "https://github.com/rawkode-academy/platform",
//       branch: "refs/heads/main",
//       destroyOnFinalize: true,
//     },
//   },
//   {
//     provider: cluster.provider,
//     dependsOn: [operatorDeployment],
//   }
// );
