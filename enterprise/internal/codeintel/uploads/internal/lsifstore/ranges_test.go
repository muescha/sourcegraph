package lsifstore

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestRangeEncoding(t *testing.T) {
	ranges := []int32{
		100, 10, 100, 20,
		101, 15, 101, 25,
		103, 16, 103, 26,
		103, 31, 103, 41,
		103, 55, 103, 65,
		151, 10, 151, 20,
		152, 15, 152, 25,
		154, 25, 154, 35,
		154, 50, 154, 60,
	}

	encoded, err := encodeRanges(ranges)
	if err != nil {
		t.Fatalf("unexpected error encoding ranges: %s", err)
	}

	decoded, err := decodeRanges(encoded)
	if err != nil {
		t.Fatalf("unexpected error decode ranges: %s", err)
	}
	if diff := cmp.Diff(ranges, decoded); diff != "" {
		t.Fatalf("unexpected ranges (-want +got):\n%s", diff)
	}
}
