import { Controller } from "../controller";

const DOMAIN = "rawkode.live";

const zone = new Controller(DOMAIN);

zone.createRecord("@", "A", ["18.184.197.212", "52.59.165.42"]);
zone.createRecord("@", "TXT", [`"v=spf1 -all"`]);

export default zone;
