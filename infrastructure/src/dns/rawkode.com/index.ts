import { Controller } from "../controller";

const DOMAIN = "rawkode.com";

const zone = new Controller(DOMAIN);

zone.createMxRecord("@", 10, "in1-smtp.messagingengine.com");
zone.createMxRecord("@", 20, "in2-smtp.messagingengine.com");

zone.createRecord("fm1._domainkey", "CNAME", [
  "fm1.rawkode.com.dkim.fmhosted.com",
]);
zone.createRecord("fm2._domainkey", "CNAME", [
  "fm2.rawkode.com.dkim.fmhosted.com",
]);
zone.createRecord("fm3._domainkey", "CNAME", [
  "fm3.rawkode.com.dkim.fmhosted.com",
]);

zone.createRecord("@", "TXT", [
  `"v=spf1 include:spf.messagingengine.com ?all"`,
  `"google-site-verification=tLlIPrsVkjMI2Klec6nYm_m6bNNwKOgvQZlyyxg0nBQ"`,
]);
zone.createRecord("_dmarc", "TXT", [
  `"v=DMARC1; p=none; pct=100; rua=mailto:re+byrfffpf3zm@dmarc.postmarkapp.com; sp=none; aspf=r;"`,
]);

// Cloud DNS needs the key broken into 255 byte segments. Unbelievable
// https://www.mailhardener.com/tools/dns-record-splitter
zone.createRecord("google._domainkey", "TXT", [
  `"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAikTg1HGzUusOgiX03hgNMqLPFIfXHGdK2e78bibzfoLTZDhQ0HciN+04bbr4AYJFjd+v0sQMoLJ7018rlKpREuD3EXiPjk+KUYXKwDdeYsA62BP56SNCfoNJ7Q0/VUdZGxTrTz1DC52iNOTjhkU/9nIax+15vSw+G22f3fQSMQvHn9+QZCxCLZi+GuOUlFbiD" "lYQr2ATPSe/aX4bumgMYgH2l+7l3uZpmw7bRaeHDQhFIOo+mvFKjX6M4ZYegH5wIMMrMnAFKE/P9UPFnZTAvESnbg9shHLIOgrHM0FiwQZsv/aUeA9zpm4ZNc6PvOpG0RGk6XgJ5CH0rJ1w8XE2aQIDAQAB"`,
]);

zone.createRecord("@", "A", ["76.76.21.21"]);
zone.createRecord("www", "CNAME", [`${DOMAIN}`]);

zone.createRecord("store", "A", ["23.227.38.65"]);

zone.createRecord("share", "CNAME", [`cname.cleanshot.cloud`]);

export default zone;
