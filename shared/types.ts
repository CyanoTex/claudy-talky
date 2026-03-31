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
  unread_count: number;
  undelivered_count: number;
  delivered_unseen_count: number;
  surfaced_unseen_count: number;
  registered_at: string;
  last_seen: string;
}

export interface Message {
  id: number;
  from_id: AgentId;
  to_id: AgentId;
  text: string;
  sent_at: string;
  conversation_id: string;
  reply_to_message_id: number | null;
  delivered: boolean;
  delivered_at: string | null;
  surfaced_at: string | null;
  seen_at: string | null;
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
  auth_token?: string;
}

export interface HeartbeatRequest {
  id: AgentId;
  auth_token?: string;
}

export interface SetSummaryRequest {
  id: AgentId;
  summary: string;
  auth_token?: string;
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
  conversation_id?: string;
  reply_to_message_id?: number | null;
  auth_token?: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  message?: Message;
}

export interface PollMessagesRequest {
  id: AgentId;
  auth_token?: string;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface MarkMessagesSurfacedRequest {
  id: AgentId;
  message_ids: number[];
  auth_token?: string;
}

export interface MarkMessagesSurfacedResponse {
  ok: boolean;
  updated: number;
}

export interface AcknowledgeMessagesRequest {
  id: AgentId;
  message_ids: number[];
  auth_token?: string;
}

export interface AcknowledgeMessagesResponse {
  ok: boolean;
  updated: number;
}

export interface MessageHistoryRequest {
  agent_id: AgentId;
  with_agent_id?: AgentId;
  conversation_id?: string;
  limit?: number;
  auth_token?: string;
}

export interface MessageHistoryResponse {
  messages: Message[];
}

export interface UnregisterRequest {
  id: AgentId;
  auth_token?: string;
}

export interface BrokerHealthResponse {
  status: "ok";
  agents: number;
  peers: number;
  unread_messages: number;
  undelivered_messages: number;
  surfaced_unseen_messages: number;
  db_path: string;
  primary_db_path: string;
  db_fallback: boolean;
  schema_version: number;
}

// Legacy aliases so older integrations can continue compiling against the
// upstream claude-peers names while the repo evolves toward generic agents.
export type PeerId = AgentId;
export type Peer = Agent;
export type RegisterRequest = RegisterAgentRequest;
export type RegisterResponse = RegisterAgentResponse;
export type ListPeersRequest = ListAgentsRequest;
