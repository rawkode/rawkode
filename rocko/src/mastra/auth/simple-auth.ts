import { SimpleAuth } from '@mastra/core/server';

type RockoAuthUser = {
  id: string;
  name: string;
  role: 'client';
};

const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required auth env var: ${name}`);
  }

  return value;
};

export const getRockoAuthToken = () => requiredEnv('ROCKO_AUTH_TOKEN');

export const createRockoSimpleAuth = () =>
  new SimpleAuth<RockoAuthUser>({
    tokens: {
      [getRockoAuthToken()]: {
        id: 'rocko-client',
        name: 'Rocko Client',
        role: 'client',
      },
    },
  });
