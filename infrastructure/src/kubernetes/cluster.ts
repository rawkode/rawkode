import { ComponentResource, Output } from "@pulumi/pulumi";
import * as google from "@pulumi/google-native";
import * as metal from "@pulumi/equinix-metal";
import * as pulumi from "@pulumi/pulumi";

import { PREFIX } from "./meta";
import { WorkerPool, Config as WorkerPoolConfig } from "./worker-pool";
import { ControlPlane, Config as ControlPlaneConfig } from "./control-plane";

interface Config {
  kubernetesVersion: string;
  metro: string;
  projectId: string;
  dnsZone: google.dns.v1.ManagedZone;
}

export class Cluster extends ComponentResource {
  readonly name: string;
  readonly config: Config;
  readonly dnsName: Output<string>;
  readonly dnsWildcard: Output<string>;
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

    this.dnsName = new google.dns.v1.Rrset(`${name}-cluster-dns`, {
      managedZone: config.dnsZone.name,
      project: "rawkode",
      name: pulumi.interpolate`${config.dnsZone.dnsName}`,
      ttl: 300,
      type: "A",
      rrdatas: [this.ingressIp],
    }).name;

    this.dnsWildcard = new google.dns.v1.Rrset(`${name}-cluster-dns-wildcard`, {
      managedZone: config.dnsZone.name,
      project: "rawkode",
      name: pulumi.interpolate`*.${config.dnsZone.dnsName}`,
      ttl: 300,
      type: "A",
      rrdatas: [this.ingressIp],
    }).name;
  }

  public createControlPlane(config: ControlPlaneConfig) {
    if (this.controlPlane) {
      throw new Error(
        `Control plane for cluster ${this.name} already specified`
      );
    }

    this.controlPlane = new ControlPlane(this, {
      highAvailability: config.highAvailability,
      plan: config.plan,
    });
  }

  public joinToken(): Output<string> | undefined {
    return this.controlPlane?.joinToken.token.apply((t) => t);
  }

  public createWorkerPool(name: string, config: WorkerPoolConfig) {
    this.workerPools[name] = new WorkerPool(this, name, config);
  }
}
