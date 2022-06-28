import { Controller } from "../controller";

const DOMAIN = "rawkode.dev";

const zone = new Controller(DOMAIN);

zone.createMxRecord("@", 10, "in1-smtp.messagingengine.com");
zone.createMxRecord("@", 20, "in2-smtp.messagingengine.com");

zone.createRecord("fm1._domainkey", "CNAME", [
  "fm1.rawkode.dev.dkim.fmhosted.com",
]);
zone.createRecord("fm2._domainkey", "CNAME", [
  "fm2.rawkode.dev.dkim.fmhosted.com",
]);
zone.createRecord("fm3._domainkey", "CNAME", [
  "fm3.rawkode.dev.dkim.fmhosted.com",
]);

zone.createRecord("@", "TXT", [
  `"v=spf1 include:spf.messagingengine.com ?all"`,
  `"google-site-verification=RnbvxDOTdobTiAetVoa-U3Xc0Irk76nan_OcRCGuQTM"`,
]);

zone.createRecord("_dmarc", "TXT", [
  `"v=DMARC1; p=none; pct=100; rua=mailto:re+pa1p2daooug@dmarc.postmarkapp.com; sp=none; aspf=r;"`,
]);

// Cloud DNS needs the key broken into 255 byte segments. Unbelievable
// https://www.mailhardener.com/tools/dns-record-splitter
zone.createRecord("google._domainkey", "TXT", [
  `"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjVevTfr7SjzrYEQ1YoI4yvBAnAfd2yqp6IQNZqZqm6HXJNXl2rBiy181NZU31Z9n6fGdoGT8yECZQBOL/9Ph9J9w/VO6ozOn0FkyEhYHkzq+twLHl5jWy07V0YeW4cg7CrV3oMSdv1kn5UgMSiB8zHoYQxlFsxM+MYg86OnY7ueT3jNbf+cVJUqFAV0R74I+n" "FoEerC92Gz7poMBRACRqs+wP9MHlzQnW+cjqMNci1fZwGRprTCTFPuWkDr75gnZDIPGa+cQAiVvtwZw6EK0KSytPAl5sDL7dHS12fGUPpaa05kJGezEhSn6wej37qFd+mn0NK0+H9ONsMtWAPQ72QIDAQAB"`,
]);

zone.createRecord("@", "A", ["76.76.21.21"]);
zone.createRecord("www", "CNAME", [`${DOMAIN}`]);
zone.createRecord("capture", "CNAME", [`${DOMAIN}`]);
zone.createRecord("cms", "CNAME", [`${DOMAIN}`]);
zone.createRecord("opengraph", "CNAME", [`${DOMAIN}`]);
zone.createRecord("share", "CNAME", [`cname.cleanshot.cloud`]);
zone.createRecord("plausible", "CNAME", [`${DOMAIN}`]);
zone.createRecord("schema", "CNAME", [`${DOMAIN}`]);

zone.createProxiedRecord("api", "CNAME", ["ypvmf3jx.api.sanity.io"]);

export default zone;
