import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { Controller } from "../dns/controller";

interface InstallArgs {
  namespace: string | pulumi.Output<string>;
  provider: k8s.Provider;
  domainController: Controller;
}

export const install = async (args: InstallArgs) => {
  const ingressController = new k8s.helm.v3.Release(
    "ingress-controller",
    {
      chart: "contour",
      name: "contour",
      repositoryOpts: {
        repo: "https://charts.bitnami.com/bitnami",
      },
      version: "7.3.3",
      namespace: args.namespace,
      values: {
        defaultBackend: {
          enabled: true,
          containerPorts: {
            http: 8080,
          },
        },
        envoy: {
          useHostPort: false,
        },
      },
      skipAwait: true,
    },
    {
      provider: args.provider,
    }
  );

  const svc = k8s.core.v1.Service.get(
    "ingress-controller-service",
    pulumi.interpolate`${ingressController.status.namespace}/${ingressController.status.name}-envoy`,
    {
      provider: args.provider,
    }
  );

  svc.status.loadBalancer.ingress[0].ip.apply((ip) => {
    args.domainController.createRecord("@", "A", [ip]);
    args.domainController.createRecord("*", "A", [ip]);
  });
};
