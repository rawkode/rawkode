import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

import { Cluster } from "../cluster";
import { Component, ComponentArgs } from "./components/abstract";
import { Project, ProjectArgs } from "./projects";

interface PlatformArgs {
  cluster: Cluster;
}

interface AddProjectArgs {
  repository: string;
  directory: string;
  environment: pulumi.Input<{
    [key: string]: pulumi.Input<string>;
  }>;
}

interface ComponentConstructGlue<T> {
  new (name: string, args: ComponentArgs): T;

  getComponentName(): string;
  getDependencies(): string[];
}

export class Platform extends pulumi.ComponentResource {
  private cluster: Cluster;
  private provider: kubernetes.Provider;
  private namespace: kubernetes.core.v1.Namespace;
  private resources: Map<string, Component> = new Map();

  constructor(name: string, args: PlatformArgs) {
    super("rawkode:platform:Platform", name, args, {});

    this.cluster = args.cluster;
    this.provider = this.cluster.kubernetesProvider;

    this.namespace = new kubernetes.core.v1.Namespace(
      "platform",
      {
        metadata: {
          name: "platform",
        },
      },
      {
        parent: this,
        provider: this.provider,
        dependsOn: this.provider,
      }
    );
  }

  public addComponent<T extends Component>(
    name: string,
    c: ComponentConstructGlue<T>
  ): this {
    const componentName = c.getComponentName();
    const dependencies = c.getDependencies();

    const dependsOn: pulumi.Resource[] = dependencies.reduce(
      (acc: pulumi.Resource[], dependency) => {
        const componentResource = this.resources.get(dependency);

        if (componentResource) {
          return acc.concat(componentResource.getResources());
        } else {
          throw new Error(
            `Component ${componentName} depends on ${dependency} but it has not been added to the platform`
          );
        }
      },
      []
    );

    this.resources.set(
      componentName,
      new c(name, {
        parent: this,
        dependsOn,
        namespace: this.namespace.metadata.name,
        provider: this.provider,
      })
    );

    return this;
  }

  private getPlatformResources(): pulumi.Resource[] {
    return Array.from(this.resources.values()).reduce(
      (acc: pulumi.Resource[], component) =>
        acc.concat(component.getResources()),
      []
    );
  }

  public addProject(name: string, args: AddProjectArgs): this {
    new Project(name, {
      ...args,
      provider: this.provider,
      platformDependency: this.getPlatformResources(),
    });
    return this;
  }
}
