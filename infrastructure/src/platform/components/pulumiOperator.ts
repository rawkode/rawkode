import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

import { Component, ComponentArgs } from "./abstract";

export class PulumiOperator extends Component {
  protected readonly version = "1.4.0";
  protected readonly crdsUrl =
    "https://raw.githubusercontent.com/pulumi/pulumi-kubernetes-operator/v${VERSION}/deploy/crds/pulumi.com_stacks.yaml";

  static getComponentName(): string {
    return "pulumi-operator";
  }

  constructor(name: string, args: ComponentArgs) {
    super(name, args);

    new kubernetes.yaml.ConfigFile(
      `${this.name}-crds`,
      { file: this.crdsUrl.replace("${VERSION}", this.version) },
      { provider: this.provider, parent: this }
    );
  }
}
