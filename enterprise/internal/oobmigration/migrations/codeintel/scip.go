package codeintel

import (
	"context"
	"errors"
	"time"

	"github.com/sourcegraph/sourcegraph/internal/database/basestore"
)

type scipMigrator struct {
	store *basestore.Store
}

func NewSCIPMigrator(store *basestore.Store) *scipMigrator {
	return &scipMigrator{store: store}
}

func (m *scipMigrator) ID() int                 { return 18 }
func (m *scipMigrator) Interval() time.Duration { return time.Second }

func (m *scipMigrator) Progress(ctx context.Context, applyReverse bool) (float64, error) {
	// TODO
	return 0, errors.New("Progress is unimplemented!")
}

func (m *scipMigrator) Up(ctx context.Context) error {
	// TODO
	return errors.New("Up is unimplemented!")
}

func (m *scipMigrator) Down(ctx context.Context) error {
	// TODO
	return errors.New("Down is unimplemented!")
}
