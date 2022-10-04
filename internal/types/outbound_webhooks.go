package types

import (
	"time"

	"github.com/sourcegraph/sourcegraph/internal/encryption"
)

type OutboundWebhook struct {
	ID        int64
	CreatedBy int32
	CreatedAt time.Time
	UpdatedBy int32
	UpdatedAt time.Time
	URL       *encryption.Encryptable
	Secret    *encryption.Encryptable
}

type OutboundWebhookEventType struct {
	ID                int64
	OutboundWebhookID int64
	EventType         string
	Scope             *string
}
