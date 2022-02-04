import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const certManagerCrds =
  "https://doc.crds.dev/raw/github.com/cert-manager/cert-manager@v${VERSION}";

interface InstallArgs {
  version: string;
  namespace: string | pulumi.Output<string>;
  provider: k8s.Provider;
}

export const install = async (args: InstallArgs) => {
  const crds = new k8s.yaml.ConfigFile(
    `cert-manager-crds`,
    { file: certManagerCrds.replace("${VERSION}", args.version) },
    { provider: args.provider }
  );

  const certManager = new k8s.helm.v3.Release(
    `cert-manager`,
    {
      chart: "cert-manager",
      repositoryOpts: {
        repo: "https://charts.jetstack.io",
      },
      name: "cert-manager",
      version: "1.7.1",
      namespace: args.namespace,
      values: {},
    },
    {
      provider: args.provider,
      dependsOn: [crds],
    }
  );
};