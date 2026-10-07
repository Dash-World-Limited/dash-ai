import type {
  AssistantMode,
  ChatStreamRequest,
  Conversation,
  ConversationMessage,
  MessageToolActivity,
  StreamEvent,
} from "@dash-ai/contracts";
import type { ToolUse } from "../logic/presentation";

export type MsgStatus = "streaming" | "complete" | "stopped" | "failed";

export interface Attachment {
  id: string;
  name: string;
  kind: "pdf" | "docx" | "txt" | "image";
  sizeBytes: number;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: MsgStatus;
  demo: boolean;
  replyToId: string | null;
  createdAt: string;
  attachments: Attachment[];
  errorMessage: string | null;
  retryable: boolean;
  recovery?: { attempts: number };
  tools: ToolUse[];
  finishReason: "stop" | "length" | "refusal" | "cancelled" | null;
}

/** Where conversations live and answers come from: the DASH AI API, or Demo Mode on this device. */
export interface ChatBackend {
  readonly demo: boolean;
  list(): Promise<Conversation[]>;
  /** A saved conversation, with the tool calls recorded for its answers (none from older servers). */
  get(id: string): Promise<{ conversation: Conversation; messages: ConversationMessage[]; toolActivity?: MessageToolActivity[] } | null>;
  stream(request: ChatStreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent>;
  cancel(streamId: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Demo Mode only: keep the finished conversation on this device. */
  save?(conversation: Conversation, messages: ChatMsg[]): void;
}

export type { AssistantMode };

/** A file in the composer: uploading, ready, or refused with a reason. */
export interface PendingAttachment {
  localId: string;
  name: string;
  sizeBytes: number;
  progress: number;
  error: string | null;
  attachment: Attachment | null;
}
