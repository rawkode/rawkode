import * as k8s from "@pulumi/kubernetes";

import { Cluster } from "../cluster/index";
import { Controller } from "../dns/controller";
import { install as installCertManager } from "./certManager";
import { install as installContour } from "./contour";
import { install as installPulumiOperator } from "./pulumiOperator";
import { install as installTyk } from "./tyk";
import { installProjects } from "./projects";

interface PlatformArgs {
  cluster: Cluster;
  domainController: Controller;
}

export const create = async (args: PlatformArgs): Promise<void> => {
  const platformNamespace = new k8s.core.v1.Namespace(
    "platform-system",
    {
      metadata: {
        name: "platform-system",
      },
    },
    {
      provider: args.cluster.provider,
    }
  );

  installContour({
    namespace: platformNamespace.metadata.name,
    provider: args.cluster.provider,
    domainController: args.domainController,
  });

  installCertManager({
    namespace: platformNamespace.metadata.name,
    version: "1.6.2",
    provider: args.cluster.provider,
  });

  installTyk({
    namespace: platformNamespace.metadata.name,
    provider: args.cluster.provider,
  });

  installProjects({
    provider: args.cluster.provider,
    domainController: args.domainController,
  });

  return;
};
