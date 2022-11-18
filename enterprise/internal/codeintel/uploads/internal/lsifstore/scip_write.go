package lsifstore

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"sync/atomic"

	"github.com/keegancsmith/sqlf"

	"github.com/sourcegraph/sourcegraph/internal/database/basestore"
	"github.com/sourcegraph/sourcegraph/internal/database/batch"
	"github.com/sourcegraph/sourcegraph/lib/codeintel/lsif/conversion"
	"github.com/sourcegraph/sourcegraph/lib/errors"
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
			definitionRanges, err := encodeRanges(symbol.DefinitionRanges)
			if err != nil {
				return err
			}
			referenceRanges, err := encodeRanges(symbol.ReferenceRanges)
			if err != nil {
				return err
			}
			implementationRanges, err := encodeRanges(symbol.ImplementationRanges)
			if err != nil {
				return err
			}
			typeDefinitionRanges, err := encodeRanges(symbol.TypeDefinitionRanges)
			if err != nil {
				return err
			}

			if err := inserter.Insert(
				ctx,
				uploadID,
				symbol.SymbolName,
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

	err = tx.Exec(ctx, sqlf.Sprintf(writeSCIPSymbolsInsertQuery, documentLookupID, 1))
	if err != nil {
		return 0, err
	}

	return count, nil
}

const writeSCIPSymbolsTemporaryTableQuery = `
CREATE TEMPORARY TABLE t_codeintel_scip_symbols (
	upload_id integer NOT NULL,
	symbol_name text NOT NULL,
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
	%s,
	%s,
	source.definition_ranges,
	source.reference_ranges,
	source.implementation_ranges,
	source.type_definition_ranges
FROM t_codeintel_scip_symbols source
ON CONFLICT DO NOTHING
`

func encodeRanges(vs []int32) (buf []byte, _ error) {
	n := len(vs)

	if n == 0 {
		return nil, nil
	}
	if n%4 != 0 {
		return nil, errors.Newf("unexpected range length - have %d but expected a multiple of 4", n)
	}

	last := int32(0)
	for i := 0; i < n; i += 2 {
		v := vs[i]
		buf = binary.AppendVarint(buf, int64(v-last))
		last = v
	}

	last = 0
	for i := 1; i < n; i += 2 {
		v := vs[i]
		buf = binary.AppendVarint(buf, int64(v-last))
		last = v
	}

	return buf, nil
}

func decodeRanges(encoded []byte) ([]int32, error) {
	if len(encoded) == 0 {
		return nil, nil
	}

	return decodeRangesFromReader(bytes.NewReader(encoded))
}

func decodeRangesFromReader(r io.ByteReader) ([]int32, error) {
	splitDeltas := []int32{}
	for {
		v, err := binary.ReadVarint(r)
		if err != nil {
			if err == io.EOF {
				break
			}

			return nil, err
		}

		splitDeltas = append(splitDeltas, int32(v))
	}

	n := len(splitDeltas)
	h := n / 2

	if n%4 != 0 {
		return nil, errors.Newf("unexpected number of encoded deltas - have %d but expected a multiple of 4", n)
	}

	lastLine := int32(0)
	lastChar := int32(0)
	lineDeltas := splitDeltas[:h]
	charDeltas := splitDeltas[h:]

	combined := make([]int32, 0, n)
	for i := 0; i < h; i++ {
		lastLine = lineDeltas[i] + lastLine
		lastChar = charDeltas[i] + lastChar
		combined = append(combined, lastLine, lastChar)
	}

	return combined, nil
}
