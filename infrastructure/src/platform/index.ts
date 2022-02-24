import * as k8s from "@pulumi/kubernetes";

import { Controller } from "../dns/controller";
import { install as installCertManager } from "./certManager";
import { install as installContour } from "./contour";
import { install as installPulumiOperator } from "./pulumiOperator";
import { install as installTyk } from "./tyk";
import { install as installRedpanda } from "./redpanda";
import { installProjects } from "./projects";

interface PlatformArgs {
  cluster: k8s.Provider;
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
      provider: args.cluster,
    }
  );

  installContour({
    namespace: platformNamespace.metadata.name,
    provider: args.cluster,
    domainController: args.domainController,
  });

  const certManagerResources = await installCertManager({
    namespace: platformNamespace.metadata.name,
    version: "1.6.2",
    provider: args.cluster,
  });

  installTyk({
    namespace: platformNamespace.metadata.name,
    provider: args.cluster,
  });

  // installRedpanda({
  //   namespace: platformNamespace.metadata.name,
  //   provider: args.cluster,
  //   version: "21.11.8",
  //   dependsOn: certManagerResources,
  // });

  installProjects({
    provider: args.cluster,
    domainController: args.domainController,
  });

  return;
};
