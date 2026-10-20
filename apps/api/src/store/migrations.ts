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
  {
    id: 3,
    name: "conversation_title_revision",
    sql: `
-- Increases on every title change, so a device's rename can carry the revision it last saw and the
-- server can reject a stale one deterministically.
ALTER TABLE conversations ADD COLUMN title_rev integer NOT NULL DEFAULT 0;
`,
  },
  {
    id: 4,
    name: "encrypt_titles_and_message_content",
    sql: `
-- Titles and message content move to AES-256-GCM ciphertext (same keyring as documents).
-- Phase 1 (this migration): add ciphertext columns and allow the plaintext columns to be NULL.
-- New writes store ciphertext only. Existing plaintext rows are encrypted by the backfill
-- (automatic at start-up outside production, or: pnpm --filter @dash-ai/api data:encrypt).
-- Phase 2 (a later migration, once the backfill reports zero plaintext rows): drop the
-- plaintext columns.
ALTER TABLE conversations ALTER COLUMN title DROP NOT NULL;
ALTER TABLE conversations ADD COLUMN title_enc bytea, ADD COLUMN title_key_id text;
ALTER TABLE messages ALTER COLUMN content DROP NOT NULL;
ALTER TABLE messages ADD COLUMN content_enc bytea, ADD COLUMN content_key_id text;
`,
  },
  {
    id: 5,
    name: "tool_execution_ledger",
    sql: `
-- At-most-once ledger for tools that change things (declared idempotency "per-message"). The key is
-- a SHA-256 of user, conversation, user message, tool and canonical arguments: no arguments,
-- results or content are stored. A row is claimed before the tool runs and is never re-claimed, so
-- a retried stream, a reconnecting client or a server restart cannot run the same action twice.
CREATE TABLE tool_executions (
  key_hash    text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX tool_executions_user_idx ON tool_executions (user_id);
`,
  },
  {
    id: 6,
    name: "tool_invocations_by_conversation",
    sql: `
-- Reopening a conversation shows the tool calls recorded for its messages (names and outcomes only).
CREATE INDEX tool_invocations_conversation_idx ON tool_invocations (conversation_id, id);
`,
  },
  {
    id: 7,
    name: "automations",
    sql: `
-- DASH Automates: scheduled tasks the server runs for a person, their results, and in-app notices.
-- Names, prompts and results are user content: AES-256-GCM ciphertext (same keyring as messages).
CREATE TABLE automations (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name_enc     bytea NOT NULL,
  prompt_enc   bytea NOT NULL,
  enc_key_id   text NOT NULL,
  mode         text NOT NULL,
  -- {"kind":"daily","time":"08:00"} etc., interpreted in time_zone (an IANA name).
  schedule     jsonb NOT NULL,
  time_zone    text NOT NULL,
  status       text NOT NULL,
  next_run_at  timestamptz,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE INDEX automations_user_idx ON automations (user_id, created_at DESC);
-- The scheduler's question: which active automations are due?
CREATE INDEX automations_due_idx ON automations (next_run_at) WHERE status = 'active';

-- Runs double as the work queue: "queued" rows are claimed with FOR UPDATE SKIP LOCKED by whichever
-- instance gets there first; a "running" row's lease lets another instance recover it if its
-- instance stops. Provider and model are internal diagnostics, never returned to clients.
CREATE TABLE automation_runs (
  id             text PRIMARY KEY,
  automation_id  text NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  trigger        text NOT NULL,
  status         text NOT NULL,
  content_enc    bytea,
  content_key_id text,
  error_code     text,
  position       bigint GENERATED ALWAYS AS IDENTITY,
  created_at     timestamptz NOT NULL,
  started_at     timestamptz,
  finished_at    timestamptz,
  lease_until    timestamptz,
  edited_at      timestamptz,
  provider       text,
  model          text,
  demo           boolean NOT NULL DEFAULT false
);
CREATE INDEX automation_runs_automation_idx ON automation_runs (automation_id, position DESC);
CREATE INDEX automation_runs_queued_idx ON automation_runs (position) WHERE status = 'queued';
CREATE INDEX automation_runs_running_idx ON automation_runs (lease_until) WHERE status = 'running';
-- At most one queued or running run per automation, enforced by the database.
CREATE UNIQUE INDEX automation_runs_in_flight_key ON automation_runs (automation_id) WHERE status IN ('queued', 'running');

CREATE TABLE notifications (
  id            text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  automation_id text NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  run_id        text NOT NULL REFERENCES automation_runs (id) ON DELETE CASCADE,
  position      bigint GENERATED ALWAYS AS IDENTITY,
  created_at    timestamptz NOT NULL,
  read_at       timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, position DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
`,
  },
  {
    id: 8,
    name: "push_notifications",
    sql: `
-- Push notifications for DASH Automates (docs/push-notifications.md).
-- The account's choice: Automates pushes on or off. Automations run either way.
ALTER TABLE users ADD COLUMN push_automates boolean NOT NULL DEFAULT true;

-- One registered device per signed-in session. The row belongs to the session, so signing out (here or
-- everywhere), the session expiring and deleting the account all remove it. The push token is a
-- delivery credential: AES-256-GCM ciphertext bound to the row, plus a SHA-256 hash so one token is
-- registered once (signing in to another account on the same phone moves it, never shares it).
CREATE TABLE push_devices (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_hash text NOT NULL REFERENCES sessions (token_hash) ON DELETE CASCADE,
  platform     text NOT NULL,
  token_hash   text NOT NULL,
  token_enc    bytea NOT NULL,
  token_key_id text NOT NULL,
  app_version  text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE UNIQUE INDEX push_devices_token_key ON push_devices (token_hash);
CREATE UNIQUE INDEX push_devices_session_key ON push_devices (session_hash);
CREATE INDEX push_devices_user_idx ON push_devices (user_id);

-- One delivery per (notification, device), written in the same transaction as the notification, so a
-- finished run fans out exactly once however many instances, retries or reconnects there are. Rows are
-- also the retry queue: "pending" rows are claimed with FOR UPDATE SKIP LOCKED; a "sending" row whose
-- lease expired (its instance stopped) is claimed again. last_error is a normalized code, never
-- provider text. Removing a device or a notification removes its deliveries.
CREATE TABLE push_deliveries (
  id              text PRIMARY KEY,
  notification_id text NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  device_id       text NOT NULL REFERENCES push_devices (id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          text NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_until     timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX push_deliveries_once_key ON push_deliveries (notification_id, device_id);
CREATE INDEX push_deliveries_device_idx ON push_deliveries (device_id);
CREATE INDEX push_deliveries_user_idx ON push_deliveries (user_id);
CREATE INDEX push_deliveries_due_idx ON push_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX push_deliveries_sending_idx ON push_deliveries (lease_until) WHERE status = 'sending';
`,
  },
  {
    id: 9,
    name: "usage_estimated_cost",
    sql: `
-- Estimated USD cost of each real answer (internal cost ledger; never in consumer responses).
-- NULL = unknown (no price for the model, or the provider did not report token counts); 0 = demo.
-- Rows written before this migration stay NULL.
ALTER TABLE usage_records ADD COLUMN estimated_cost_usd double precision;
`,
  },
  {
    id: 10,
    name: "inference_ledger",
    sql: `
-- The inference ledger: one append-only row per AI provider attempt (retries, fallbacks and tool
-- rounds included) with tokens, latency, outcome, cost and routing metadata. No prompt, answer or tool
-- content. Deleting an account keeps the accounting rows and removes the account link (SET NULL).
CREATE TABLE inference_attempts (
  id                      text PRIMARY KEY,
  inference_id            text NOT NULL,
  user_id                 text REFERENCES users (id) ON DELETE SET NULL,
  plan                    text NOT NULL,
  task                    text NOT NULL,
  mode                    text,
  provider                text NOT NULL,
  model                   text NOT NULL,
  pricing                 text NOT NULL,
  created_at              timestamptz NOT NULL,
  latency_ms              integer NOT NULL,
  outcome                 text NOT NULL,
  error_code              text,
  http_status             integer,
  retry                   integer NOT NULL,
  round                   integer NOT NULL,
  fallback_index          integer NOT NULL,
  input_tokens            bigint,
  output_tokens           bigint,
  cached_input_tokens     bigint,
  estimated_input_tokens  bigint NOT NULL,
  estimated_output_tokens bigint NOT NULL,
  token_source            text NOT NULL,
  estimated_cost_usd      double precision,
  provider_cost_usd       double precision,
  currency                text NOT NULL,
  route                   jsonb NOT NULL
);
CREATE INDEX inference_attempts_created_idx ON inference_attempts (created_at);
CREATE INDEX inference_attempts_user_created_idx ON inference_attempts (user_id, created_at);
CREATE INDEX inference_attempts_inference_idx ON inference_attempts (inference_id);
`,
  },
  {
    id: 11,
    name: "inference_ledger_integrity",
    sql: `
-- Integrity rules for the append-only inference ledger, which feeds the spend circuit breakers: a
-- negative cost or an unknown pricing class would silently loosen a spend limit, so the database
-- refuses impossible rows. Also records the configured model whose price is used when a provider
-- reports a served model id that MODEL_PRICES does not list. Additive: no row is changed or deleted.
ALTER TABLE inference_attempts ADD COLUMN configured_model text;
ALTER TABLE inference_attempts
  ADD CONSTRAINT inference_attempts_pricing_check CHECK (pricing IN ('free', 'promotional', 'paid', 'demo')),
  ADD CONSTRAINT inference_attempts_outcome_check CHECK (outcome IN ('success', 'failure', 'cancelled')),
  ADD CONSTRAINT inference_attempts_token_source_check CHECK (token_source IN ('provider', 'estimated')),
  ADD CONSTRAINT inference_attempts_currency_check CHECK (currency = 'USD'),
  ADD CONSTRAINT inference_attempts_counts_check CHECK (
    latency_ms >= 0 AND retry >= 0 AND round >= 0 AND fallback_index >= 0
    AND estimated_input_tokens >= 0 AND estimated_output_tokens >= 0
    AND (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (cached_input_tokens IS NULL OR cached_input_tokens >= 0)),
  ADD CONSTRAINT inference_attempts_cost_check CHECK (
    (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
    AND (provider_cost_usd IS NULL OR provider_cost_usd >= 0));
`,
  },
  {
    id: 12,
    name: "spend_reservations",
    sql: `
-- In-flight spend reservations: a temporary hold on a request's worst-case paid cost, taken atomically at
-- admission (under per-scope advisory locks) and settled against the inference ledger when the request
-- ends. A hold is never a charge: the ledger stays the only record of actual spend, and while a request
-- runs only the part of its hold not yet matched by its own ledger rows is counted. One row per logical
-- request (inference_id). Operational accounting metadata only: no prompt, answer, tool content or
-- credential. Deleting an account removes the account link (SET NULL), like the ledger.
CREATE TABLE spend_reservations (
  id           text PRIMARY KEY,
  inference_id text NOT NULL,
  user_id      text REFERENCES users (id) ON DELETE SET NULL,
  plan         text NOT NULL,
  task         text NOT NULL,
  provider     text NOT NULL,
  model        text,
  reserved_usd numeric(20, 10) NOT NULL,
  actual_usd   numeric(20, 10),
  status       text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  CONSTRAINT spend_reservations_status_check CHECK (status IN ('active', 'settled', 'released', 'expired')),
  CONSTRAINT spend_reservations_amounts_check CHECK (reserved_usd >= 0 AND (actual_usd IS NULL OR actual_usd >= 0)),
  CONSTRAINT spend_reservations_lease_check CHECK (expires_at > created_at),
  CONSTRAINT spend_reservations_finished_check CHECK ((status = 'active') = (finished_at IS NULL)),
  CONSTRAINT spend_reservations_settled_check CHECK (status NOT IN ('settled', 'released') OR actual_usd IS NOT NULL)
);
CREATE UNIQUE INDEX spend_reservations_inference_key ON spend_reservations (inference_id);
-- Admission reads only active rows: system scope by expiry, plan and person scopes by their key.
CREATE INDEX spend_reservations_active_idx ON spend_reservations (expires_at) WHERE status = 'active';
CREATE INDEX spend_reservations_active_user_idx ON spend_reservations (user_id) WHERE status = 'active';
CREATE INDEX spend_reservations_active_plan_idx ON spend_reservations (plan) WHERE status = 'active';
CREATE INDEX spend_reservations_finished_idx ON spend_reservations (finished_at) WHERE status <> 'active';
-- Plan-limit sums read paid rows of one plan since the start of the UTC day.
CREATE INDEX inference_attempts_paid_plan_created_idx ON inference_attempts (plan, created_at) WHERE pricing = 'paid';
`,
  },
];
