import * as kubernetes from "@pulumi/kubernetes";

import { Component, ComponentArgs } from "./abstract";

export class CertManager extends Component {
  protected readonly version = "1.7.1";
  protected readonly crdsUrl =
    "https://github.com/cert-manager/cert-manager/releases/download/v${VERSION}/cert-manager.crds.yaml";

  static getComponentName(): string {
    return "cert-manager";
  }

  constructor(name: string, args: ComponentArgs) {
    super(name, args);

    const crds = new kubernetes.yaml.ConfigFile(
      `${this.name}-crds`,
      { file: this.crdsUrl.replace("${VERSION}", this.version) },
      { provider: this.provider, parent: this }
    );

    const certManagerRelease = new kubernetes.helm.v3.Release(
      this.name,
      {
        skipCrds: true,
        skipAwait: true,
        chart: "cert-manager",
        repositoryOpts: {
          repo: "https://charts.jetstack.io",
        },
        version: this.version,
        namespace: args.namespace,
        values: {},
      },
      {
        parent: this,
        provider: args.provider,
        dependsOn: crds,
      }
    );

    this.resources.push(certManagerRelease);

    this.resources.push(
      new kubernetes.apiextensions.CustomResource(
        "letsencrypt-production",
        {
          apiVersion: "cert-manager.io/v1",
          kind: "ClusterIssuer",
          metadata: {
            // Disable auto-naming, because downstream stacks will rely on this
            name: "letsencrypt-production",
            annotations: {
              "pulumi.com/skipAwait": "true",
            },
          },
          spec: {
            acme: {
              email: "david@rawkode.com",
              privateKeySecretRef: {
                name: "letsencrypt-production",
              },
              server: "https://acme-v02.api.letsencrypt.org/directory",
              solvers: [
                {
                  http01: {
                    ingress: {
                      class: "contour",
                    },
                  },
                },
              ],
            },
          },
        },
        {
          parent: this,
          dependsOn: [certManagerRelease],
          provider: args.provider,
        }
      )
    );
  }
}
