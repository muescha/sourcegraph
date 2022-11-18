package lsifstore

import (
	"context"
	"testing"

	"github.com/sourcegraph/log/logtest"

	codeintelshared "github.com/sourcegraph/sourcegraph/enterprise/internal/codeintel/shared"
	"github.com/sourcegraph/sourcegraph/internal/database/dbtest"
	"github.com/sourcegraph/sourcegraph/internal/observation"
	"github.com/sourcegraph/sourcegraph/lib/codeintel/lsif/conversion"
)

func TestInsertSCIPDocument(t *testing.T) {
	logger := logtest.Scoped(t)
	codeIntelDB := codeintelshared.NewCodeIntelDB(dbtest.NewDB(logger, t))
	store := New(codeIntelDB, &observation.TestContext)
	ctx := context.Background()

	// TODO - setup

	// TODO - better values
	n, err := store.InsertSCIPDocument(ctx, 24, "foobar.go", nil, nil)
	if err != nil {
		t.Fatalf("failed to write SCIP document: %s", err)
	}

	// TODO - assertions
	_ = n
}

func TestWriteSCIPSymbols(t *testing.T) {
	logger := logtest.Scoped(t)
	codeIntelDB := codeintelshared.NewCodeIntelDB(dbtest.NewDB(logger, t))
	store := New(codeIntelDB, &observation.TestContext)
	ctx := context.Background()

	// TODO - setup

	// TODO - better values
	n, err := store.WriteSCIPSymbols(ctx, 24, 36, []conversion.ProcessedSymbolData{})
	if err != nil {
		t.Fatalf("failed to write SCIP symbols: %s", err)
	}

	// TODO - assertions
	_ = n
}
