import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

import { Cluster } from "../cluster";
import {
  Component,
  ComponentArgs,
  IngressComponent,
} from "./components/abstract";
import { Project, ProjectArgs } from "./projects";

interface PlatformArgs {
  cluster: Cluster;
}

interface AddProjectArgs {
  repository: string;
  directory: string;
  ingressComponent?: string;
  environment: { [key: string]: string };
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
  private components: Map<string, Component> = new Map();
  private ingressComponents: Map<string, IngressComponent> = new Map();

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

  public addIngressComponent<T extends IngressComponent>(
    name: string,
    c: ComponentConstructGlue<T>
  ): this {
    const componentName = c.getComponentName();
    const dependencies = c.getDependencies();

    const dependsOn: pulumi.Resource[] = dependencies.reduce(
      (acc: pulumi.Resource[], dependency) => {
        const componentResource = this.components.get(dependency);

        if (componentResource) {
          return acc.concat(componentResource.getResources());
        } else {
          throw new Error(
            `IngressComponent ${componentName} depends on ${dependency} but it has not been added to the platform`
          );
        }
      },
      []
    );

    this.ingressComponents.set(
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

  public addComponent<T extends Component>(
    name: string,
    c: ComponentConstructGlue<T>
  ): this {
    const componentName = c.getComponentName();
    const dependencies = c.getDependencies();

    const dependsOn: pulumi.Resource[] = dependencies.reduce(
      (acc: pulumi.Resource[], dependency) => {
        const componentResource = this.components.get(dependency);

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

    this.components.set(
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
    return Array.from(this.components.values()).reduce(
      (acc: pulumi.Resource[], component) =>
        acc.concat(component.getResources()),
      []
    );
  }

  public addProject(name: string, args: AddProjectArgs): this {
    const ingressComponent = args.ingressComponent
      ? this.ingressComponents.get(args.ingressComponent)
      : undefined;

    new Project(name, {
      ...args,
      provider: this.provider,
      platformDependency: this.getPlatformResources(),
      ingressComponent,
    });
    return this;
  }
}
