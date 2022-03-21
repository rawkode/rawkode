import { Controller } from "../controller";

const DOMAIN = "rawkode.live";

const zone = new Controller(DOMAIN);

zone.disableEmail();
zone.createRecord("@", "A", ["18.184.197.212", "52.59.165.42"]);

export default zone;
