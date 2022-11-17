package conversion

import (
	"context"
	"io"

	"github.com/sourcegraph/scip/bindings/go/scip"
	"google.golang.org/protobuf/proto"

	"github.com/sourcegraph/sourcegraph/lib/codeintel/pathexistence"
)

type ProcessedSCIPDocument struct {
	DocumentPath   string
	Hash           [256]byte
	RawSCIPPayload []byte
	Symbols        []ProcessedSymbolData
}

type ProcessedSymbolData struct {
	SymbolName           string
	DefinitionRanges     []int32 // TODO - encode as bytes instead
	ReferenceRanges      []int32 // TODO - encode as bytes instead
	ImplementationRanges []int32 // TODO - encode as bytes instead
	TypeDefinitionRanges []int32 // TODO - encode as bytes instead
}

func CorrelateSCIP(ctx context.Context, r io.Reader, root string, getChildren pathexistence.GetChildrenFunc) (<-chan ProcessedSCIPDocument, error) {
	content, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}

	var index scip.Index
	if err := proto.Unmarshal(content, &index); err != nil {
		return nil, err
	}

	data := make(chan ProcessedSCIPDocument)

	go func() {
		defer close(data)

		for _, document := range index.Documents {
			symbols := make([]ProcessedSymbolData, 0, len(document.Occurrences))
			for _, occurrence := range document.Occurrences {
				if occurrence.Symbol == "" {
					continue
				}

				if occurrence.SymbolRoles&int32(scip.SymbolRole_Definition) != 0 {
					symbols = append(symbols, ProcessedSymbolData{
						SymbolName:           occurrence.Symbol,
						DefinitionRanges:     occurrence.Range, // TODO
						ReferenceRanges:      nil,
						ImplementationRanges: nil,
						TypeDefinitionRanges: nil,
					})
				} else {
					symbols = append(symbols, ProcessedSymbolData{
						SymbolName:           occurrence.Symbol,
						DefinitionRanges:     nil,
						ReferenceRanges:      occurrence.Range, // TODO
						ImplementationRanges: nil,
						TypeDefinitionRanges: nil,
					})
				}
			}

			data <- ProcessedSCIPDocument{
				DocumentPath:   document.RelativePath, // TODO
				Hash:           [256]byte{},           // TODO
				RawSCIPPayload: nil,                   // TODO
				Symbols:        symbols,
			}
		}
	}()

	return data, nil
}
