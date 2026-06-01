package main

import (
	"slices"
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

func TestTopoSort(t *testing.T) {
	t.Parallel()

	nodes := map[string]bindings.Node{
		"C": &bindings.Interface{
			Name:   bindings.Identifier{Name: "C"},
			Fields: []*bindings.PropertySignature{{Name: "x", Type: kw(bindings.KeywordString)}},
		},
		"B": &bindings.Interface{
			Name:   bindings.Identifier{Name: "B"},
			Fields: []*bindings.PropertySignature{{Name: "c", Type: ref("C")}},
		},
		"A": &bindings.Interface{
			Name:   bindings.Identifier{Name: "A"},
			Fields: []*bindings.PropertySignature{{Name: "b", Type: ref("B")}},
		},
	}

	order := topoSort(nodes)

	indexOf := func(name string) int {
		return slices.Index(order, name)
	}

	if indexOf("C") > indexOf("B") {
		t.Error("C should appear before B (B depends on C)")
	}
	if indexOf("B") > indexOf("A") {
		t.Error("B should appear before A (A depends on B)")
	}
}

func TestTopoSortSelfReference(t *testing.T) {
	t.Parallel()

	nodes := map[string]bindings.Node{
		"Tree": &bindings.Interface{
			Name: bindings.Identifier{Name: "Tree"},
			Fields: []*bindings.PropertySignature{
				{Name: "children", Type: bindings.Array(ref("Tree"))},
			},
		},
	}

	order := topoSort(nodes)

	if len(order) != 1 || order[0] != "Tree" {
		t.Errorf("expected [Tree], got %v", order)
	}
}

func TestCollectRefsFindsNestedRefs(t *testing.T) {
	t.Parallel()

	node := &bindings.Interface{
		Name: bindings.Identifier{Name: "Test"},
		Fields: []*bindings.PropertySignature{
			{Name: "a", Type: ref("A")},
			{Name: "b", Type: bindings.Array(ref("B"))},
			{Name: "c", Type: bindings.Union(ref("C"), &bindings.Null{})},
		},
	}

	refs := collectRefs(node)
	refSet := make(map[string]bool)
	for _, r := range refs {
		refSet[r] = true
	}

	for _, want := range []string{"A", "B", "C"} {
		if !refSet[want] {
			t.Errorf("expected ref %q in results", want)
		}
	}
}

func TestCollectRefsArrayLiteralType(t *testing.T) {
	t.Parallel()

	node := &bindings.Alias{
		Name: bindings.Identifier{Name: "Test"},
		Type: &bindings.ArrayLiteralType{
			Elements: []bindings.ExpressionType{
				ref("Foo"),
				ref("Bar"),
			},
		},
	}

	refs := collectRefs(node)
	refSet := make(map[string]bool)
	for _, r := range refs {
		refSet[r] = true
	}

	for _, want := range []string{"Foo", "Bar"} {
		if !refSet[want] {
			t.Errorf("expected ref %q in results", want)
		}
	}
}

func ref(name string) *bindings.ReferenceType {
	return bindings.Reference(bindings.Identifier{Name: name})
}

func kw(k bindings.LiteralKeyword) *bindings.LiteralKeyword {
	return &k
}
