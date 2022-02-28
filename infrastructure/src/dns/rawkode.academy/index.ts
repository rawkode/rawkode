import { Controller } from "../controller";

const DOMAIN = "rawkode.academy";

const zone = new Controller(DOMAIN);

zone.createRecord("@", "TXT", [
  `"google-site-verification=dlh9jxVzubowYFoVO82naJOotuUwY8zNG2VYGWlDhsU"`,
  `"v=spf1 include:_spf.google.com ~all"`,
]);

zone.createMxRecord("@", 1, "aspmx.l.google.com");
zone.createMxRecord("@", 5, "alt1.aspmx.l.google.com");
zone.createMxRecord("@", 5, "alt2.aspmx.l.google.com");
zone.createMxRecord("@", 10, "alt3.aspmx.l.google.com");
zone.createMxRecord("@", 10, "alt4.aspmx.l.google.com");

zone.createRecord("@", "A", ["76.76.21.21"]);
zone.createRecord("schema", "CNAME", [`${DOMAIN}`]);

export default zone;
