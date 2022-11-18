package conversion

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"io"
	"sort"

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
	hash := sha256.New()

	writeString := func(v string) {
		_, _ = hash.Write([]byte(v))
		_, _ = hash.Write([]byte{0})
	}
	writeStrings := func(vs []string) {
		for _, v := range vs {
			writeString(v)
		}
	}
	writeInts := func(vs []int32) {
		_ = binary.Write(hash, binary.LittleEndian, vs)
		_, _ = hash.Write([]byte{0})
	}
	writeBools := func(vs ...bool) {
		var m int32
		for i, v := range vs {
			if v {
				m |= (1 << i)
			}
		}

		writeInts([]int32{m})
	}

	for _, occurrence := range document.Occurrences {
		r := scip.NewRange(occurrence.Range)

		writeString("occ")
		writeString(occurrence.Symbol)
		writeStrings(occurrence.OverrideDocumentation)
		writeInts([]int32{r.Start.Line, r.Start.Character, r.End.Line, r.End.Character, occurrence.SymbolRoles, int32(occurrence.SyntaxKind)})

		for _, diagnostic := range occurrence.Diagnostics {
			vs := make([]int32, 0, len(diagnostic.Tags)+1)
			vs = append(vs, int32(diagnostic.Severity))
			for _, tag := range diagnostic.Tags {
				vs = append(vs, int32(tag))
			}

			writeString("dia")
			writeString(diagnostic.Code)
			writeString(diagnostic.Message)
			writeString(diagnostic.Source)
			writeInts(vs)
		}
	}

	for _, symbol := range document.Symbols {
		writeString("sym")
		writeString(symbol.Symbol)
		writeStrings(symbol.Documentation)

		for _, relationship := range symbol.Relationships {
			writeString("rel")
			writeString(relationship.Symbol)
			writeBools(relationship.IsReference, relationship.IsImplementation, relationship.IsTypeDefinition)
		}
	}

	return hash.Sum(nil)
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
