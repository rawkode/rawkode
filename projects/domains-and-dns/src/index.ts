import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
interface DnsRecord {
  name: string;
  type: "A" | "CNAME" | "TXT" | "MX";
  value: string;
  proxied: boolean;
}

interface MxRecord extends DnsRecord {
  type: "MX";
  proxied: false;
  priority: number;
}

interface Domain {
  name: string;
  domain: string;
  records: {
    [name: string]: DnsRecord | MxRecord;
  };
}

const rawkodeEmail: Domain = {
  name: "rawkode-email",
  domain: "rawkode.email",
  records: {
    mx1: {
      name: "@",
      type: "MX",
      value: "in1-smtp.messagingengine.com",
      priority: 10,
      proxied: false,
    },
    mx2: {
      name: "@",
      type: "MX",
      value: "in2-smtp.messagingengine.com",
      priority: 20,
      proxied: false,
    },
    dkim1: {
      name: "fm1._domainkey",
      type: "CNAME",
      value: "fm1.rawkode.email.dkim.fmhosted.com",
      proxied: false,
    },
    dkim2: {
      name: "fm2._domainkey",
      type: "CNAME",
      value: "fm2.rawkode.email.dkim.fmhosted.com",
      proxied: false,
    },
    dkim3: {
      name: "fm3._domainkey",
      type: "CNAME",
      value: "fm3.rawkode.email.dkim.fmhosted.com",
      proxied: false,
    },
    spf1: {
      name: "@",
      type: "TXT",
      value: "v=spf1 include:spf.messagingengine.com ?all",
      proxied: false,
    },
  },
};

const rawkodeNews: Domain = {
  name: "rawkode-news",
  domain: "rawkode.news",
  records: {
    mx1: {
      name: "@",
      type: "MX",
      value: "in1-smtp.messagingengine.com",
      priority: 10,
      proxied: false,
    },
    mx2: {
      name: "@",
      type: "MX",
      value: "in2-smtp.messagingengine.com",
      priority: 20,
      proxied: false,
    },
    dkim1: {
      name: "fm1._domainkey",
      type: "CNAME",
      value: "fm1.rawkode.news.dkim.fmhosted.com",
      proxied: false,
    },
    dkim2: {
      name: "fm2._domainkey",
      type: "CNAME",
      value: "fm2.rawkode.news.dkim.fmhosted.com",
      proxied: false,
    },
    dkim3: {
      name: "fm3._domainkey",
      type: "CNAME",
      value: "fm3.rawkode.news.dkim.fmhosted.com",
      proxied: false,
    },
    spf1: {
      name: "@",
      type: "TXT",
      value: "v=spf1 include:spf.messagingengine.com ?all",
      proxied: false,
    },
  },
};

const reconcileDomain = (domain: Domain) => {
  const zone = new cloudflare.Zone(domain.name, {
    zone: domain.domain,
    jumpStart: false,
    paused: false,
    plan: "free",
    type: "full",
  });

  const zoneSettings = new cloudflare.ZoneSettingsOverride(
    domain.name,
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
      parent: zone,
    }
  );

  const recordKeys = Object.keys(domain.records);
  recordKeys.forEach((key) => {
    const record = domain.records[key];

    new cloudflare.Record(
      `${domain.name}-${key}`,
      {
        zoneId: zone.id,
        ...record,
      },
      {
        parent: zone,
      }
    );
  });
};

reconcileDomain(rawkodeEmail);
reconcileDomain(rawkodeNews);
