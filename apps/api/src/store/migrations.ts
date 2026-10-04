/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped: add a new one.
 * Each runs in its own transaction; its checksum is recorded and verified on later runs.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL,
  -- Per-user change counter used as the sync cursor (see conversations.sync_seq).
  sync_counter  bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE conversations (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title           text NOT NULL,
  title_is_custom boolean NOT NULL,
  mode            text NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  -- Deleted conversations stay as tombstones so other devices learn about the deletion.
  deleted_at      timestamptz,
  sync_seq        bigint NOT NULL DEFAULT 0
);
CREATE INDEX conversations_user_updated_idx ON conversations (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX conversations_user_seq_idx ON conversations (user_id, sync_seq);

CREATE TABLE messages (
  -- Message ids are chosen by clients, so they are only unique within a conversation.
  conversation_id  text NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  id               text NOT NULL,
  position         bigint GENERATED ALWAYS AS IDENTITY,
  role             text NOT NULL,
  content          text NOT NULL,
  origin           text,
  model            text,
  demo             boolean NOT NULL,
  status           text NOT NULL,
  compare_group_id text,
  attachment_ids   text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, id)
);
CREATE INDEX messages_conversation_position_idx ON messages (conversation_id, position);

CREATE TABLE documents (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name               text NOT NULL,
  kind               text NOT NULL,
  mime_type          text NOT NULL,
  size_bytes         bigint NOT NULL,
  status             text NOT NULL,
  status_detail      text NOT NULL,
  extracted_chars    integer NOT NULL,
  -- AES-256-GCM ciphertext of the extracted text; the key never touches the database.
  extracted_text_enc bytea NOT NULL,
  enc_key_id         text NOT NULL,
  page_count         integer,
  created_at         timestamptz NOT NULL
);
CREATE INDEX documents_user_created_idx ON documents (user_id, created_at DESC);

CREATE TABLE usage_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  message_id      text NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  demo            boolean NOT NULL,
  input_tokens    bigint,
  output_tokens   bigint,
  created_at      timestamptz NOT NULL
);
CREATE INDEX usage_user_idx ON usage_records (user_id, id);
`,
  },
  {
    id: 2,
    name: "plugins_and_tool_audit",
    sql: `
-- A user's explicit choices about optional plugins. No row = never configured = disabled.
CREATE TABLE plugin_settings (
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plugin_id      text NOT NULL,
  enabled        boolean NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL,
  PRIMARY KEY (user_id, plugin_id)
);

-- Audit trail of tool calls: metadata only. Arguments and results are deliberately never stored.
CREATE TABLE tool_invocations (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  message_id      text NOT NULL,
  call_id         text NOT NULL,
  provider        text NOT NULL,
  plugin_id       text NOT NULL,
  tool_name       text NOT NULL,
  status          text NOT NULL,
  duration_ms     integer NOT NULL,
  arg_bytes       integer NOT NULL,
  result_chars    integer NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX tool_invocations_user_idx ON tool_invocations (user_id, id DESC);
`,
  },
];
