export interface OAuthProvider {
  id: string;
  name: string;
  identityScopes: string[];
  presets: { id: string; name: string; description: string; scopes: string[] }[];
}

export interface OAuthApp {
  id: string;
  name: string;
  providerId: string;
  clientId: string;
  scopes: string[];
  redirectUri: string;
  createdAt: number;
}

export interface CreateAppInput {
  name: string;
  providerId: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export interface Connection {
  id: string;
  ownerId: string;
  appId: string;
  appName: string;
  providerId: string;
  accountId: string;
  accountLabel: string;
  scopes: string[];
  status: "connected" | "reconnect_required";
  expiresAt: number;
  createdAt: number;
  services: string[];
}

export interface AccessToken {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: number;
  scopes: string[];
}

export interface OAuthAdminApi {
  getConfiguration(): Promise<{ providers: OAuthProvider[]; serviceIds: string[]; redirectOrigin: string }>;
  listApps(): Promise<OAuthApp[]>;
  createApp(input: CreateAppInput): Promise<OAuthApp>;
  listConnections(): Promise<Connection[]>;
  beginConnection(input: { appId: string; browserBindingHash: string }): Promise<{
    authorizationUrl: string;
    stateId: string;
  }>;
  disconnect(connectionId: string): Promise<void>;
  grantService(connectionId: string, serviceId: string): Promise<void>;
  revokeService(connectionId: string, serviceId: string): Promise<void>;
}

export interface OAuthIntegrationApi {
  listConnections(): Promise<Connection[]>;
  getAccessToken(connectionId: string, requiredScopes: string[]): Promise<AccessToken>;
}
