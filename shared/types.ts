export type AgentId = string;
export type DiscoveryScope = "machine" | "directory" | "repo";

export interface Agent {
  id: AgentId;
  pid: number | null;
  name: string;
  kind: string;
  transport: string;
  cwd: string | null;
  git_root: string | null;
  tty: string | null;
  summary: string;
  capabilities: string[];
  metadata: Record<string, unknown>;
  registered_at: string;
  last_seen: string;
}

export interface Message {
  id: number;
  from_id: AgentId;
  to_id: AgentId;
  text: string;
  sent_at: string;
  delivered: boolean;
}

export interface RegisterAgentRequest {
  pid?: number | null;
  name?: string;
  kind: string;
  transport?: string;
  cwd?: string | null;
  git_root?: string | null;
  tty?: string | null;
  summary?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

export interface RegisterAgentResponse {
  id: AgentId;
}

export interface HeartbeatRequest {
  id: AgentId;
}

export interface SetSummaryRequest {
  id: AgentId;
  summary: string;
}

export interface ListAgentsRequest {
  scope: DiscoveryScope;
  cwd?: string | null;
  git_root?: string | null;
  kind?: string;
  capability?: string;
  exclude_id?: AgentId;
}

export interface SendMessageRequest {
  from_id: AgentId;
  to_id: AgentId;
  text: string;
}

export interface PollMessagesRequest {
  id: AgentId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

// Legacy aliases so older integrations can continue compiling against the
// upstream claude-peers names while the repo evolves toward generic agents.
export type PeerId = AgentId;
export type Peer = Agent;
export type RegisterRequest = RegisterAgentRequest;
export type RegisterResponse = RegisterAgentResponse;
export type ListPeersRequest = ListAgentsRequest;
