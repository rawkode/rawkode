import { Controller } from "../controller";

const DOMAIN = "rawkode.news";

const zone = new Controller(DOMAIN);

zone.createProxiedRecord("@", "CNAME", ["www.getrevue.co"]);
zone.createRecord("@", "TXT", [`"v=spf1 -all"`]);

export default zone;
