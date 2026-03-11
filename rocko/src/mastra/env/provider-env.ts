const getTrimmedEnv = (name: string) => process.env[name]?.trim();

export const normalizeModelProviderEnv = () => {
  const googleApiKey =
    getTrimmedEnv('GOOGLE_GENERATIVE_AI_API_KEY') ??
    getTrimmedEnv('GOOGLE_API_KEY');

  if (googleApiKey) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= googleApiKey;
    process.env.GOOGLE_API_KEY ??= googleApiKey;
  }

  return {
    googleApiKey,
  };
};

export const getGoogleApiKey = () => normalizeModelProviderEnv().googleApiKey;

normalizeModelProviderEnv();
