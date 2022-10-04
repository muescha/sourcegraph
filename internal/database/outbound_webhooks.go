package database

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/keegancsmith/sqlf"

	"github.com/sourcegraph/sourcegraph/internal/database/basestore"
	"github.com/sourcegraph/sourcegraph/internal/database/dbutil"
	"github.com/sourcegraph/sourcegraph/internal/encryption"
	"github.com/sourcegraph/sourcegraph/internal/encryption/keyring"
	"github.com/sourcegraph/sourcegraph/internal/types"
	"github.com/sourcegraph/sourcegraph/lib/errors"
)

type OutboundWebhookStore interface {
	basestore.ShareableStore

	Create(context.Context, *types.OutboundWebhook, ...*types.OutboundWebhookEventType) error
	GetByID(context.Context, int64) (*types.OutboundWebhook, error)
	List(context.Context, OutboundWebhookListOpts) ([]*types.OutboundWebhook, int64, error)
	Delete(context.Context, int64) error
	Update(context.Context, *types.OutboundWebhook, ...*types.OutboundWebhookEventType) error

	GetEventTypes(context.Context, int64) ([]*types.OutboundWebhookEventType, error)
}

type OutboundWebhookNotFoundErr struct{ args []any }

func (err OutboundWebhookNotFoundErr) Error() string {
	return fmt.Sprintf("outbound webhook not found: %v", err.args)
}

func (OutboundWebhookNotFoundErr) NotFound() bool { return true }

type outboundWebhookStore struct {
	*basestore.Store
	key encryption.Key
}

var _ OutboundWebhookStore = &outboundWebhookStore{}

func OutboundWebhooksWith(other basestore.ShareableStore, key encryption.Key) *outboundWebhookStore {
	return &outboundWebhookStore{
		Store: basestore.NewWithHandle(other.Handle()),
		key:   key,
	}
}

func (s *outboundWebhookStore) With(other basestore.ShareableStore) OutboundWebhookStore {
	return &outboundWebhookStore{
		Store: s.Store.With(other),
		key:   s.key,
	}
}

func (s *outboundWebhookStore) Transact(ctx context.Context) (OutboundWebhookStore, error) {
	tx, err := s.Store.Transact(ctx)
	return &outboundWebhookStore{
		Store: tx,
		key:   s.key,
	}, err
}

func (s *outboundWebhookStore) Create(ctx context.Context, webhook *types.OutboundWebhook, types ...*types.OutboundWebhookEventType) error {
	key := s.getEncryptionKey()
	rawURL, _, err := webhook.URL.Encrypt(ctx, key)
	if err != nil {
		return err
	}
	rawSecret, _, err := webhook.URL.Encrypt(ctx, key)
	if err != nil {
		return err
	}

	q := sqlf.Sprintf(
		outboundWebhookCreateQueryFmtstr,
		webhook.CreatedBy,
		webhook.UpdatedBy,
		[]byte(rawURL),
		[]byte(rawSecret),
		sqlf.Join(outboundWebhookColumns, ","),
	)

	row := s.QueryRow(ctx, q)
	if err := s.scanOutboundWebhook(ctx, webhook, row); err != nil {
		return errors.Wrap(err, "scanning outbound webhook")
	}

	return nil
}

func (s *outboundWebhookStore) GetByID(ctx context.Context, id int64) (*types.OutboundWebhook, error) {
	q := sqlf.Sprintf(
		outboundWebhookGetByIDQueryFmtstr,
		sqlf.Join(outboundWebhookColumns, ","),
		id,
	)

	webhook := types.OutboundWebhook{}
	if err := s.scanOutboundWebhook(ctx, &webhook, s.QueryRow(ctx, q)); err == sql.ErrNoRows {
		return nil, OutboundWebhookNotFoundErr{args: []any{id}}
	} else if err != nil {
		return nil, err
	}

	return &webhook, nil
}

type OutboundWebhookListOpts struct {
	Limit  int
	Cursor int64

	EventTypes []string
}

func (s *outboundWebhookStore) List(_ context.Context, _ OutboundWebhookListOpts) ([]*types.OutboundWebhook, int64, error) {
	panic("not implemented") // TODO: Implement
}

func (s *outboundWebhookStore) Delete(ctx context.Context, id int64) error {
	q := sqlf.Sprintf(outboundWebhookDeleteQueryFmtstr, id)
	_, err := s.Query(ctx, q)

	return err
}

func (s *outboundWebhookStore) Update(_ context.Context, _ *types.OutboundWebhook, _ ...*types.OutboundWebhookEventType) error {
	panic("not implemented") // TODO: Implement
}

func (s *outboundWebhookStore) GetEventTypes(_ context.Context, _ int64) ([]*types.OutboundWebhookEventType, error) {
	panic("not implemented") // TODO: Implement
}

var outboundWebhookColumns = []*sqlf.Query{
	sqlf.Sprintf("id"),
	sqlf.Sprintf("created_by"),
	sqlf.Sprintf("created_at"),
	sqlf.Sprintf("updated_by"),
	sqlf.Sprintf("updated_at"),
	sqlf.Sprintf("encryption_key_id"),
	sqlf.Sprintf("url"),
	sqlf.Sprintf("secret"),
}

var outboundWebhookEventTypeColumns = []*sqlf.Query{
	sqlf.Sprintf("id"),
	sqlf.Sprintf("outbound_webhook_id"),
	sqlf.Sprintf("event_type"),
	sqlf.Sprintf("scope"),
}

const outboundWebhookCreateQueryFmtstr = `
-- source: internal/database/outbound_webhooks.go:Create
WITH
	outbound_webhook AS (
		INSERT INTO
			outbound_webhooks (
				created_by,
				updated_by,
				url,
				secret
			)
			VALUES (
				%s,
				%s,
				%s,
				%s
			)
			RETURNING %s
	),
	data (event_type, scope) AS (
		VALUES %s
	),
	event_types AS (
		INSERT INTO
			outbound_webhook_event_types (
				outbound_webhook_id,
				event_type,
				scope
			)
		SELECT
			outbound_webhook.id,
			data.event_type,
			data.scope
		FROM
			outbound_webhook CROSS JOIN data
	)
SELECT
	%s
FROM
	outbound_webhook
`

const outboundWebhookDeleteQueryFmtstr = `
-- source: internal/database/outbound_webhooks.go:Delete
DELETE FROM
	outbound_webhooks
WHERE
	id = %s
`

const outboundWebhookGetByIDQueryFmtstr = `
-- source: internal/database/outbound_webhooks.go:GetByID
SELECT
	%s
FROM
	outbound_webhooks
WHERE
	id = %s
`

func (s *outboundWebhookStore) scanOutboundWebhook(ctx context.Context, webhook *types.OutboundWebhook, sc dbutil.Scanner) error {
	var (
		rawURL, rawSecret []byte
		keyID             string
	)

	if err := sc.Scan(
		&webhook.ID,
		&webhook.CreatedBy,
		&webhook.CreatedAt,
		&webhook.UpdatedBy,
		&webhook.UpdatedAt,
		&keyID,
		&rawURL,
		&rawSecret,
	); err != nil {
		return err
	}

	webhook.URL = encryption.NewEncrypted(string(rawURL), keyID, s.getEncryptionKey())
	webhook.Secret = encryption.NewEncrypted(string(rawSecret), keyID, s.getEncryptionKey())

	return nil
}

func (s *outboundWebhookStore) getEncryptionKey() encryption.Key {
	if s.key != nil {
		return s.key
	}
	return keyring.Default().OutboundWebhookKey
}
