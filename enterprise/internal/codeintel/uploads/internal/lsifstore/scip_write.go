package lsifstore

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"sync/atomic"

	"github.com/keegancsmith/sqlf"

	"github.com/sourcegraph/sourcegraph/internal/database/basestore"
	"github.com/sourcegraph/sourcegraph/internal/database/batch"
	"github.com/sourcegraph/sourcegraph/lib/codeintel/lsif/conversion"
)

func (s *store) InsertSCIPDocument(ctx context.Context, uploadID int, documentPath string, hash []byte, rawSCIPPayload []byte) (int, error) {
	id, _, err := basestore.ScanFirstInt(s.db.Query(ctx, sqlf.Sprintf(
		insertSCIPDocumentQuery,
		hash,
		rawSCIPPayload,
		hash,
		uploadID,
		documentPath,
	)))
	if err != nil {
		return 0, err
	}

	return id, nil
}

const insertSCIPDocumentQuery = `
WITH
new_shared_document AS (
	INSERT INTO codeintel_scip_documents (schema_version, payload_hash, raw_scip_payload)
	VALUES (1, %s, %s)
	ON CONFLICT DO NOTHING
	RETURNING id
),
shared_document AS (
	SELECT id FROM new_shared_document
	UNION ALL
	SELECT id FROM codeintel_scip_documents WHERE payload_hash = %s
)
INSERT INTO codeintel_scip_document_lookup (upload_id, document_path, document_id)
SELECT %s, %s, id FROM shared_document LIMIT 1
RETURNING id
`

func (s *store) WriteSCIPSymbols(ctx context.Context, uploadID, documentLookupID int, symbols []conversion.ProcessedSymbolData) (count uint32, err error) {
	tx, err := s.db.Transact(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { err = tx.Done(err) }()

	if err := tx.Exec(ctx, sqlf.Sprintf(writeSCIPSymbolsTemporaryTableQuery)); err != nil {
		return 0, err
	}

	inserter := func(inserter *batch.Inserter) error {
		for _, symbol := range symbols {
			definitionRanges, err := compactRange(symbol.DefinitionRanges)
			if err != nil {
				return err
			}
			referenceRanges, err := compactRange(symbol.ReferenceRanges)
			if err != nil {
				return err
			}
			implementationRanges, err := compactRange(symbol.ImplementationRanges)
			if err != nil {
				return err
			}
			typeDefinitionRanges, err := compactRange(symbol.TypeDefinitionRanges)
			if err != nil {
				return err
			}

			if err := inserter.Insert(
				ctx,
				uploadID,
				symbol.SymbolName,
				documentLookupID,
				definitionRanges,
				referenceRanges,
				implementationRanges,
				typeDefinitionRanges,
			); err != nil {
				return err
			}

			atomic.AddUint32(&count, 1)
		}

		return nil
	}

	if err := withBatchInserter(
		ctx,
		tx.Handle(),
		"t_codeintel_scip_symbols",
		[]string{
			"upload_id",
			"symbol_name",
			"document_lookup_id",
			"definition_ranges",
			"reference_ranges",
			"implementation_ranges",
			"type_definition_ranges",
		},
		inserter,
	); err != nil {
		return 0, err
	}
	// trace.Log(log.Int("numRecords", int(count)))

	err = tx.Exec(ctx, sqlf.Sprintf(writeSCIPSymbolsInsertQuery, 1))
	if err != nil {
		return 0, err
	}

	return count, nil
}

const writeSCIPSymbolsTemporaryTableQuery = `
CREATE TEMPORARY TABLE t_codeintel_scip_symbols (
	upload_id integer NOT NULL,
	symbol_name text NOT NULL,
	document_lookup_id bigint NOT NULL,
	definition_ranges bytea,
	reference_ranges bytea,
	implementation_ranges bytea,
	type_definition_ranges bytea
) ON COMMIT DROP
`

const writeSCIPSymbolsInsertQuery = `
INSERT INTO codeintel_scip_symbols (
	upload_id,
	symbol_name,
	document_lookup_id,
	schema_version,
	definition_ranges,
	reference_ranges,
	implementation_ranges,
	type_definition_ranges
)
SELECT
	source.upload_id,
	source.symbol_name,
	source.document_lookup_id,
	%s,
	source.definition_ranges,
	source.reference_ranges,
	source.implementation_ranges,
	source.type_definition_ranges,
FROM t_codeintel_scip_symbols source
ON CONFLICT DO NOTHING
`

func compactRange(r []int32) ([]byte, error) {
	switch len(r) {
	case 3:
		return compactIntegerValues(r[0], r[1], r[0], r[2])
	case 4:
		return compactIntegerValues(r[0], r[1], r[2], r[3])

	default:
		return nil, fmt.Errorf("unexpected range length")
	}
}

func compactIntegerValues(vs ...int32) ([]byte, error) {
	buf := bytes.Buffer{}
	if err := binary.Write(&buf, binary.LittleEndian, vs); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}
