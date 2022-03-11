import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

import { Controller } from "../dns/controller";
import { install as installCertManager } from "./certManager";
import { install as installContour } from "./contour";
import { install as installTyk } from "./tyk";
import { install as installRedpanda } from "./redpanda";

export { Project } from "./projects";

interface PlatformArgs {
  provider: kubernetes.Provider;
  domainController: Controller;
}

type PlatformResult = pulumi.Resource;

export const create = async (args: PlatformArgs): Promise<PlatformResult> => {
  const provider = args.provider;

  const platformNamespace = new kubernetes.core.v1.Namespace(
    "platform-system",
    {
      metadata: {
        name: "platform-system",
      },
    },
    {
      provider,
    }
  );

  const contourDependency = await installContour({
    namespace: platformNamespace.metadata.name,
    provider,
    domainController: args.domainController,
  });

  const certManagerDependency = await installCertManager({
    namespace: platformNamespace.metadata.name,
    version: "1.6.2",
    provider,
  });

  const tykDependency = await installTyk({
    namespace: platformNamespace.metadata.name,
    provider,
  });

  const redPandaDependency = await installRedpanda({
    namespace: platformNamespace.metadata.name,
    provider,
    version: "21.11.9",
    dependsOn: [certManagerDependency],
  });

  const pulumiStackDependency = new kubernetes.yaml.ConfigFile(
    "crds",
    {
      file: "https://raw.githubusercontent.com/pulumi/pulumi-kubernetes-operator/v1.4.0/deploy/crds/pulumi.com_stacks.yaml",
    },
    {
      provider,
      dependsOn: [
        contourDependency,
        certManagerDependency,
        tykDependency,
        redPandaDependency,
      ],
    }
  );

  return pulumiStackDependency;
};
