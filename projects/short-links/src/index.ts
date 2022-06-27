import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as command from "@pulumi/command";
import * as github from "@pulumi/github";
import * as fs from "fs";
import { PlanetScaleDatabase, PlanetScalePassword } from "./planetscale";

const config = new pulumi.Config();
const planetScaleConfig = new pulumi.Config("planetscale");
const githubConfig = new pulumi.Config("github");

const database = new PlanetScaleDatabase("short-links", {
  name: "short-links",
  organization: "rawkode",
  region: "eu-west",
  token: planetScaleConfig.requireSecret("token"),
});

const databasePassword = new PlanetScalePassword("short-links-password", {
  organization: "rawkode",
  branch: "main",
  database: database.name,
  name: "test",
  token: planetScaleConfig.requireSecret("token"),
});

const githubProvider = new github.Provider("github", {
  owner: githubConfig.require("owner"),
  token: githubConfig.requireSecret("token"),
});

const actionsSecret = new github.ActionsSecret(
  "short-links-connection-string",
  {
    repository: config.require("githubRepository"),
    secretName: "SHORT_LINKS_CONNECTION_STRING",
    plaintextValue: databasePassword.prismaConnectionString,
  },
  {
    provider: githubProvider,
  }
);

console.log(new Date().toISOString());

const compileWorker = new command.local.Command("worker", {
  create: "npm install && npx tsc",
  dir: "../worker",
  triggers: [new Date().toISOString()],
});

const linkZoneNames = ["rawkode.link"];

const linkZones = linkZoneNames.map((zone) => {
  const z = new cloudflare.Zone(zone, {
    zone,
    plan: "free",
  });

  new cloudflare.ZoneSettingsOverride(zone, {
    zoneId: z.id,
    settings: {
      alwaysUseHttps: "on",
      automaticHttpsRewrites: "on",
      ssl: "strict",
      minTlsVersion: "1.2",
      universalSsl: "on",
    },
  });

  return z;
});

const worker = new cloudflare.WorkerScript(
  "links",
  {
    name: "links",
    content: fs.readFileSync("../worker/dist/index.js").toString(),
  },
  {
    deleteBeforeReplace: true,
    dependsOn: [compileWorker],
  }
);

linkZones.forEach((zone) => {
  zone.zone.apply((zoneName) => {
    new cloudflare.Record(
      zoneName,
      {
        zoneId: zone.id,
        name: "@",
        type: "CNAME",
        value: "workers.dev",
        proxied: true,
      },
      {
        deleteBeforeReplace: true,
      }
    );

    new cloudflare.WorkerRoute(
      zoneName,
      {
        zoneId: zone.id,
        pattern: pulumi.interpolate`${zone.zone}/*`,
        scriptName: worker.name,
      },
      { dependsOn: [worker] }
    );
  });
});
