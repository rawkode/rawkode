const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required Cloudflare deployment env var: ${name}`);
  }

  return value;
};

export const getRockoPublicUrl = () => {
  const raw = requiredEnv('ROCKO_PUBLIC_URL');
  const url = new URL(raw);

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error(
      `ROCKO_PUBLIC_URL must use http or https, received: ${url.protocol}`,
    );
  }

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      'ROCKO_PUBLIC_URL must be an origin only, for example https://rocko.example.com',
    );
  }

  if (url.port) {
    throw new Error(
      'ROCKO_PUBLIC_URL must not include an explicit port when deploying to Cloudflare custom domains',
    );
  }

  return url;
};

export const getCloudflareZoneName = () =>
  requiredEnv('CLOUDFLARE_ZONE_NAME');

export const buildCloudflareRouteConfig = () => {
  const publicUrl = getRockoPublicUrl();

  return {
    workers_dev: false,
    routes: [
      {
        pattern: publicUrl.host,
        zone_name: getCloudflareZoneName(),
        custom_domain: true,
      },
    ],
  };
};
