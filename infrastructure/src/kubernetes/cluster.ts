import { ComponentResource, Output } from "@pulumi/pulumi";
import * as metal from "@pulumi/equinix-metal";

import { PREFIX } from "./meta";
import { Controller as DnsController } from "../dns/controller";
import { WorkerPool, Config as WorkerPoolConfig } from "./worker-pool";
import { ControlPlane, Config as ControlPlaneConfig } from "./control-plane";

interface Config {
  kubernetesVersion: string;
  metro: string;
  projectId: string;
  dns: DnsController;
}

export class Cluster extends ComponentResource {
  readonly name: string;
  readonly config: Config;
  readonly controlPlaneIp: Output<string>;
  readonly ingressIp: Output<string>;
  public controlPlane?: ControlPlane;
  private workerPools: { [name: string]: WorkerPool } = {};

  constructor(name: string, config: Config) {
    super(`${PREFIX}:kubernetes:Cluster`, name, config, {});

    this.name = name;
    this.config = config;

    this.controlPlaneIp = new metal.ReservedIpBlock(
      `${name}-control-plane`,
      {
        projectId: config.projectId,
        metro: config.metro,
        type: "public_ipv4",
        quantity: 1,
      },
      {
        parent: this,
      }
    ).address;

    this.ingressIp = new metal.ReservedIpBlock(
      `${name}-ingress`,
      {
        projectId: config.projectId,
        metro: config.metro,
        type: "public_ipv4",
        quantity: 1,
      },
      {
        parent: this,
      }
    ).address;

    this.ingressIp.apply((ip) => config.dns.createRecord("", "A", ip));
    this.ingressIp.apply((ip) => config.dns.createRecord("*", "A", ip));
  }

  public createControlPlane(config: ControlPlaneConfig) {
    if (this.controlPlane) {
      throw new Error(
        `Control plane for cluster ${this.name} already specified`
      );
    }

    this.controlPlane = new ControlPlane(this, {
      ...config,
    });
  }

  public joinToken(): Output<string> | undefined {
    return this.controlPlane?.joinToken.token.apply((t) => t);
  }

  public createWorkerPool(name: string, config: WorkerPoolConfig) {
    this.workerPools[name] = new WorkerPool(this, name, config);
  }
}
