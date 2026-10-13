export const LOCAL_PROFILE_ID = "local_embedded";
export const CONNECTIONS_FILE_NAME = "connections.json";
export const CONNECTIONS_FILE_VERSION = 1;

export type ConnectionMode = "local_embedded" | "remote_existing";
export type ConnectionHealth =
  | "healthy"
  | "auth_required"
  | "unsupported"
  | "unreachable"
  | "unknown";
export type DeploymentMode = "local_trusted" | "authenticated";
export type DeploymentExposure = "private" | "public";
export type SessionState = "signed_in" | "signed_out" | "unknown";
export type BootstrapStatus = "ready" | "bootstrap_pending";
export type RemotePreflightFailureReason =
  | "invalid_url"
  | "unreachable"
  | "tls_error"
  | "not_paperclip"
  | "unsupported_local_trusted"
  | "incompatible_version"
  | "auth_not_ready";

export interface ConnectionProfile {
  id: string;
  name: string;
  mode: ConnectionMode;
  remoteUrl?: string;
  allowInsecureHttp?: boolean;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt?: string;
  lastHealth?: ConnectionHealth;
  lastDeploymentMode?: DeploymentMode | null;
  lastSessionState?: SessionState;
  /** Company prefix used to build `/{prefix}/office`; overrides the global setting. */
  companyPrefix?: string;
  /** Origin-relative path of the last view in this connection (no origin stored). */
  lastViewPath?: string;
}

export interface ConnectionState {
  activeProfileId: string | null;
  alwaysShowChooser: boolean;
  autoConnectLastProfile: boolean;
  chooserMode: ConnectionMode;
  localProfileName: string;
  localLastConnectedAt?: string;
  localLastHealth?: ConnectionHealth;
  /** Global company prefix for the office start path; per-profile values win. */
  officeCompanyPrefix?: string;
  /** Origin-relative path of the last view on the local server (no origin stored). */
  localLastViewPath?: string;
}

export interface PersistedConnectionsFile {
  version: number;
  state: ConnectionState;
  remoteProfiles: ConnectionProfile[];
}

export interface RemotePreflightResult {
  ok: boolean;
  normalizedUrl: string;
  origin: string;
  insecureTransport: boolean;
  paperclipDetected: boolean;
  deploymentMode: DeploymentMode | null;
  deploymentExposure: DeploymentExposure | null;
  authReady: boolean | null;
  bootstrapStatus: BootstrapStatus | null;
  bootstrapInviteActive: boolean | null;
  sessionState: SessionState;
  version: string | null;
  reason?: RemotePreflightFailureReason;
  warning?: string;
  detail?: string;
}
