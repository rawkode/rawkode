import { Controller } from "../controller";

const DOMAIN = "rawkode.community";

const zone = new Controller(DOMAIN);
zone.disableEmail();

export default zone;
