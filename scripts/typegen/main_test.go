package main

import (
	"testing"

	"github.com/coder/guts/bindings"
)

func TestResolveTransitive(t *testing.T) {
	t.Parallel()

	nodes := map[string]bindings.Node{
		"A": &bindings.Interface{
			Name:   bindings.Identifier{Name: "A"},
			Fields: []*bindings.PropertySignature{{Name: "b", Type: ref("B")}},
		},
		"B": &bindings.Interface{
			Name:   bindings.Identifier{Name: "B"},
			Fields: []*bindings.PropertySignature{{Name: "c", Type: ref("C")}},
		},
		"C": &bindings.Interface{
			Name:   bindings.Identifier{Name: "C"},
			Fields: []*bindings.PropertySignature{{Name: "x", Type: kw(bindings.KeywordString)}},
		},
		"Unrelated": &bindings.Interface{
			Name:   bindings.Identifier{Name: "Unrelated"},
			Fields: []*bindings.PropertySignature{{Name: "x", Type: kw(bindings.KeywordNumber)}},
		},
	}

	result := resolveTransitive(nodes, map[string]bool{"A": true})

	if _, ok := result["A"]; !ok {
		t.Error("expected A in result")
	}
	if _, ok := result["B"]; !ok {
		t.Error("expected B (transitive dep of A)")
	}
	if _, ok := result["C"]; !ok {
		t.Error("expected C (transitive dep of B)")
	}
	if _, ok := result["Unrelated"]; ok {
		t.Error("Unrelated should not be included")
	}
}

func TestResolveTransitiveStopsAtMissingRefs(t *testing.T) {
	t.Parallel()

	nodes := map[string]bindings.Node{
		"A": &bindings.Interface{
			Name:   bindings.Identifier{Name: "A"},
			Fields: []*bindings.PropertySignature{{Name: "x", Type: ref("Missing")}},
		},
	}

	result := resolveTransitive(nodes, map[string]bool{"A": true})

	if _, ok := result["A"]; !ok {
		t.Error("expected A in result")
	}
	if len(result) != 1 {
		t.Errorf("expected 1 node, got %d", len(result))
	}
}

func ref(name string) *bindings.ReferenceType {
	return bindings.Reference(bindings.Identifier{Name: name})
}

func kw(k bindings.LiteralKeyword) *bindings.LiteralKeyword {
	return &k
}
