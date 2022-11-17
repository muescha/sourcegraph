package lsifstore

import (
	"context"
	"strings"

	"github.com/keegancsmith/sqlf"
	"github.com/lib/pq"
	"github.com/opentracing/opentracing-go/log"
	"github.com/sourcegraph/scip/bindings/go/scip"

	"github.com/sourcegraph/sourcegraph/enterprise/internal/codeintel/shared/types"
	"github.com/sourcegraph/sourcegraph/internal/observation"
	"github.com/sourcegraph/sourcegraph/lib/codeintel/precise"
)

// GetHover returns the hover text of the symbol at the given position.
func (s *store) GetHover(ctx context.Context, bundleID int, path string, line, character int) (_ string, _ types.Range, _ bool, err error) {
	ctx, trace, endObservation := s.operations.getHover.With(ctx, &err, observation.Args{LogFields: []log.Field{
		log.Int("bundleID", bundleID),
		log.String("path", path),
		log.Int("line", line),
		log.Int("character", character),
	}})
	defer endObservation(1, observation.Args{})

	documentData, exists, err := s.scanFirstDocumentData(s.db.Query(ctx, sqlf.Sprintf(
		hoverDocumentQuery,
		bundleID,
		path,
		bundleID,
		path,
	)))
	if err != nil || !exists {
		return "", types.Range{}, false, err
	}

	if documentData.SCIPData != nil {
		trace.Log(log.Int("numOccurrences", len(documentData.SCIPData.Occurrences)))
		occurrences := precise.FindOccurrences(documentData.SCIPData.Occurrences, line, character)
		trace.Log(log.Int("numIntersectingOccurrences", len(occurrences)))

		rangeBySymbol := map[string]types.Range{}
		var symbolNames []string
		for _, o := range occurrences {
			r := translateRange(scip.NewRange(o.Range))

			if len(o.OverrideDocumentation) > 0 {
				return strings.Join(o.OverrideDocumentation, "\n"), r, true, nil
			}

			for _, s := range documentData.SCIPData.Symbols {
				if s.Symbol == o.Symbol {
					return strings.Join(s.Documentation, "\n"), r, true, nil
				}
			}

			if _, ok := rangeBySymbol[o.Symbol]; !ok {
				rangeBySymbol[o.Symbol] = r
				symbolNames = append(symbolNames, o.Symbol)
			}
		}

		documents, err := s.scanDocumentData(s.db.Query(ctx, sqlf.Sprintf(
			hoverSymbolsQuery,
			bundleID,
			pq.Array(symbolNames),
		)))
		if err != nil {
			return "", types.Range{}, false, err
		}

		for _, symbol := range symbolNames {
			for _, document := range documents {
				for _, s := range document.SCIPData.Symbols {
					if s.Symbol == symbol {
						// TODO - consider combining multiple definitions of the same symbol
						return strings.Join(s.Documentation, "\n"), rangeBySymbol[symbol], true, nil
					}
				}
			}
		}

		return "", types.Range{}, false, nil
	}

	trace.Log(log.Int("numRanges", len(documentData.LSIFData.Ranges)))
	ranges := precise.FindRanges(documentData.LSIFData.Ranges, line, character)
	trace.Log(log.Int("numIntersectingRanges", len(ranges)))

	for _, r := range ranges {
		if text, ok := documentData.LSIFData.HoverResults[r.HoverResultID]; ok {
			return text, newRange(r.StartLine, r.StartCharacter, r.EndLine, r.EndCharacter), true, nil
		}
	}

	return "", types.Range{}, false, nil
}

const hoverDocumentQuery = `
(
	SELECT
		sd.id,
		sid.document_path,
		NULL AS data,
		NULL AS ranges,
		NULL AS hovers,
		NULL AS monikers,
		NULL AS packages,
		NULL AS diagnostics,
		sd.raw_scip_payload AS scip_document
	FROM codeintel_scip_index_documents sid
	JOIN codeintel_scip_documents sd ON sd.id = sid.document_id
	WHERE
		sid.upload_id = %s AND
		sid.document_path = %s
	LIMIT 1
) UNION (
	SELECT
		dump_id,
		path,
		data,
		ranges,
		hovers,
		NULL AS monikers,
		NULL AS packages,
		NULL AS diagnostics,
		NULL AS scip_document
	FROM
		lsif_data_documents
	WHERE
		dump_id = %s AND
		path = %s
	LIMIT 1
)
`

const hoverSymbolsQuery = `
SELECT
	sd.id,
	sid.document_path,
	NULL AS data,
	NULL AS ranges,
	NULL AS hovers,
	NULL AS monikers,
	NULL AS packages,
	NULL AS diagnostics,
	sd.raw_scip_payload AS scip_document
FROM codeintel_scip_index_documents sid
JOIN codeintel_scip_documents sd ON sd.id = sid.document_id
WHERE EXISTS (
	SELECT 1
	FROM codeintel_scip_symbols ss
	WHERE
		ss.upload_id = %s AND
		ss.symbol_name = ANY(%s) AND
		ss.index_document_id = sid.id AND
		ss.definition_ranges IS NOT NULL
)
`
