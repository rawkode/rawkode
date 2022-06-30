import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

const cloudflareProviderConfig = new pulumi.Config("cloudflare");

const cloudflareProvider = new cloudflare.Provider("cloudflare-provider", {
  accountId: cloudflareProviderConfig.require("accountId"),
  apiToken: cloudflareProviderConfig.requireSecret("apiToken"),
});

const zone = new cloudflare.Zone(
  "rawkode.link",
  {
    zone: "rawkode.link",
    plan: "free",
  },
  {
    provider: cloudflareProvider,
  }
);

const zoneSettings = new cloudflare.ZoneSettingsOverride(
  "rawkode.link",
  {
    zoneId: zone.id,
    settings: {
      alwaysUseHttps: "on",
      automaticHttpsRewrites: "on",
      ssl: "strict",
      minTlsVersion: "1.2",
      universalSsl: "on",
    },
  },
  {
    provider: cloudflareProvider,
  }
);

const record = new cloudflare.Record(
  "rawkode.link",
  {
    zoneId: zone.id,
    name: "@",
    type: "CNAME",
    proxied: true,
    value: "workers.dev",
  },
  {
    provider: cloudflareProvider,
  }
);

const workerRoute = new cloudflare.WorkerRoute(
  "rawkode.link",
  {
    pattern: pulumi.interpolate`${zone.zone}/*`,
    zoneId: zone.id,
    scriptName: "web-links",
  },
  {
    provider: cloudflareProvider,
  }
);
