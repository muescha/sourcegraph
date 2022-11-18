package conversion

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"hash"
	"io"
	"sort"
	"strings"

	"github.com/sourcegraph/scip/bindings/go/scip"
	"google.golang.org/protobuf/proto"

	"github.com/sourcegraph/sourcegraph/lib/codeintel/pathexistence"
	"github.com/sourcegraph/sourcegraph/lib/codeintel/precise"
)

type ProcessedSCIPDocument struct {
	DocumentPath   string
	Hash           []byte
	RawSCIPPayload []byte
	Symbols        []ProcessedSymbolData
	Err            error
}

type ProcessedSymbolData struct {
	SymbolName           string
	DefinitionRanges     []int32
	ReferenceRanges      []int32
	ImplementationRanges []int32
	TypeDefinitionRanges []int32
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
			data <- processDocument(document)
		}
	}()

	return data, nil
}

func processDocument(document *scip.Document) ProcessedSCIPDocument {
	path := document.RelativePath
	canonicalizeDocument(document)

	payload, err := proto.Marshal(document)
	if err != nil {
		return ProcessedSCIPDocument{
			DocumentPath: path,
			Err:          err,
		}
	}

	return ProcessedSCIPDocument{
		DocumentPath:   path,
		Hash:           hashDocument(document),
		RawSCIPPayload: payload,
		Symbols:        extractSymbols(document),
	}
}

func canonicalizeDocument(document *scip.Document) {
	document.RelativePath = ""
	precise.SortOccurrences(document.Occurrences)
	sort.Slice(document.Symbols, func(i, j int) bool {
		return document.Symbols[i].Symbol < document.Symbols[j].Symbol
	})

	for _, occurrence := range document.Occurrences {
		occurrence.Range = scip.NewRange(occurrence.Range).SCIPRange()
		_ = occurrence.Diagnostics // TODO - sort diagnostics/tags?
	}

	for _, symbol := range document.Symbols {
		sort.Slice(symbol.Relationships, func(i, j int) bool {
			return symbol.Relationships[i].Symbol < symbol.Relationships[j].Symbol
		})
	}
}

func hashDocument(document *scip.Document) []byte {
	hash := &hasher{h: sha256.New()}

	for _, occurrence := range document.Occurrences {
		r := scip.NewRange(occurrence.Range)

		hash.Write(markerOccurrence)
		hash.WriteString(occurrence.Symbol)
		hash.WriteStringSlice(occurrence.OverrideDocumentation)
		hash.WriteInts(
			r.Start.Line,
			r.Start.Character,
			r.End.Line,
			r.End.Character,
			occurrence.SymbolRoles,
			int32(occurrence.SyntaxKind),
		)

		for _, diagnostic := range occurrence.Diagnostics {
			vs := make([]int32, 0, len(diagnostic.Tags)+1)
			vs = append(vs, int32(diagnostic.Severity))
			for _, tag := range diagnostic.Tags {
				vs = append(vs, int32(tag))
			}

			hash.Write(markerDiagnostic)
			hash.WriteString(diagnostic.Code)
			hash.WriteString(diagnostic.Message)
			hash.WriteString(diagnostic.Source)
			hash.WriteInts(vs...)
		}
	}

	for _, symbol := range document.Symbols {
		hash.Write(markerSymbol)
		hash.WriteString(symbol.Symbol)
		hash.WriteStringSlice(symbol.Documentation)

		for _, relationship := range symbol.Relationships {
			hash.Write(markerSymbolRelationship)
			hash.WriteString(relationship.Symbol)
			hash.WriteBools(relationship.IsReference, relationship.IsImplementation, relationship.IsTypeDefinition)
		}
	}

	return hash.Sum()
}

var (
	sep                      = []byte{0}
	markerOccurrence         = []byte{1}
	markerDiagnostic         = []byte{2}
	markerSymbol             = []byte{3}
	markerSymbolRelationship = []byte{4}
)

type hasher struct {
	h hash.Hash
}

func (h *hasher) Write(v []byte)               { h.writeBytes(v) }
func (h *hasher) WriteString(v string)         { h.writeBytes([]byte(v)) }
func (h *hasher) WriteStringSlice(vs []string) { h.WriteString(strings.Join(vs, string(sep))) }
func (h *hasher) WriteInt(v int32)             { h.writeAny(v) }
func (h *hasher) WriteInts(vs ...int32)        { h.writeAny(vs) }
func (h *hasher) WriteBools(vs ...bool)        { h.writeAny(vs) }
func (h *hasher) Sum() []byte                  { return h.h.Sum(nil) }

func (h *hasher) writeAny(v any) {
	_ = binary.Write(h.h, binary.LittleEndian, v)
	_, _ = h.h.Write(sep)
}

func (h *hasher) writeBytes(v []byte) {
	_, _ = h.h.Write(v)
	_, _ = h.h.Write(sep)
}

func extractSymbols(document *scip.Document) []ProcessedSymbolData {
	symbolsByName := make(map[string]ProcessedSymbolData, len(document.Occurrences))
	for _, occurrence := range document.Occurrences {
		if occurrence.Symbol == "" {
			continue
		}

		symbol, ok := symbolsByName[occurrence.Symbol]
		if !ok {
			symbolsByName[occurrence.Symbol] = ProcessedSymbolData{SymbolName: occurrence.Symbol}
		}

		if occurrence.SymbolRoles&int32(scip.SymbolRole_Definition) != 0 {
			symbol.DefinitionRanges = addRange(symbol.DefinitionRanges, occurrence.Range)
		} else {
			symbol.ReferenceRanges = addRange(symbol.ReferenceRanges, occurrence.Range)
		}

		symbolsByName[occurrence.Symbol] = symbol
	}

	symbols := make([]ProcessedSymbolData, 0, len(symbolsByName))
	for _, symbol := range symbolsByName {
		symbols = append(symbols, symbol)
	}
	sort.Slice(symbols, func(i, j int) bool {
		return symbols[i].SymbolName < symbols[j].SymbolName
	})

	return symbols
}

func addRange(s []int32, compactRange []int32) []int32 {
	fullRange := scip.NewRange(compactRange)
	return append(s, fullRange.Start.Line, fullRange.Start.Character, fullRange.End.Line, fullRange.End.Character)
}
