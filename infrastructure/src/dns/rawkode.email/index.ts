import { Controller } from "../controller";

const DOMAIN = "rawkode.email";

const zone = new Controller(DOMAIN);

zone.createMxRecord("@", 10, "in1-smtp.messagingengine.com");
zone.createMxRecord("@", 20, "in2-smtp.messagingengine.com");

zone.createRecord("fm1._domainkey", "CNAME", [
  "fm1.rawkode.email.dkim.fmhosted.com",
]);
zone.createRecord("fm2._domainkey", "CNAME", [
  "fm2.rawkode.email.dkim.fmhosted.com",
]);
zone.createRecord("fm3._domainkey", "CNAME", [
  "fm3.rawkode.email.dkim.fmhosted.com",
]);

zone.createRecord("@", "TXT", [
  `"v=spf1 include:spf.messagingengine.com ?all"`,
  `"google-site-verification=RnbvxDOTdobTiAetVoa-U3Xc0Irk76nan_OcRCGuQTM"`,
]);

zone.createRecord("_dmarc", "TXT", [
  `"v=DMARC1; p=none; pct=100; rua=mailto:re+pa1p2daooug@dmarc.postmarkapp.com; sp=none; aspf=r;"`,
]);

export default zone;
