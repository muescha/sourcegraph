CREATE TABLE IF NOT EXISTS outbound_webhooks (
    id BIGSERIAL NOT NULL PRIMARY KEY,
    created_by INTEGER NULL REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_by INTEGER NULL REFERENCES users (id) ON DELETE SET NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    url BYTEA NOT NULL,
    secret BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_webhook_event_types (
    id BIGSERIAL NOT NULL PRIMARY KEY,
    outbound_webhook_id BIGINT NOT NULL REFERENCES outbound_webhooks (id) ON DELETE CASCADE ON UPDATE CASCADE,
    event_type TEXT NOT NULL,
    scope TEXT NULL
);

CREATE INDEX IF NOT EXISTS outbound_webhook_event_types_event_type_idx
ON outbound_webhook_event_types (event_type);
