// Declare only the server module we use, without merging Workers' HTMLRewriter
// Element into the browser DOM types used by Astro's client scripts.
declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}
