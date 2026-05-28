package main

import (
	"strings"
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
		for i, n := range order {
			if n == name {
				return i
			}
		}
		return -1
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

func TestExprToZodNullableUnion(t *testing.T) {
	t.Parallel()

	expr := bindings.Union(kw(bindings.KeywordString), &bindings.Null{})
	result := exprToZod(expr, "")

	if result != "z.string().nullable()" {
		t.Errorf("expected z.string().nullable(), got %q", result)
	}
}

func TestExprToZodSingleMemberUnion(t *testing.T) {
	t.Parallel()

	expr := bindings.Union(kw(bindings.KeywordString))
	result := exprToZod(expr, "")

	if result != "z.string()" {
		t.Errorf("expected z.string(), got %q", result)
	}
}

func TestExprToZodRecord(t *testing.T) {
	t.Parallel()

	expr := bindings.Reference(
		bindings.Identifier{Name: "Record"},
		kw(bindings.KeywordString),
		kw(bindings.KeywordString),
	)
	result := exprToZod(expr, "")

	if result != "z.record(z.string(), z.string())" {
		t.Errorf("expected z.record(...), got %q", result)
	}
}

func TestExprToZodSelfReference(t *testing.T) {
	t.Parallel()

	expr := ref("Tree")
	result := exprToZod(expr, "Tree")

	if !strings.Contains(result, "z.lazy") {
		t.Errorf("expected z.lazy() for self-reference, got %q", result)
	}
}

func TestExprToZodNonSelfReference(t *testing.T) {
	t.Parallel()

	expr := ref("Other")
	result := exprToZod(expr, "Tree")

	if result != "OtherSchema" {
		t.Errorf("expected OtherSchema, got %q", result)
	}
}

func TestSerializeNodeInterface(t *testing.T) {
	t.Parallel()

	node := &bindings.Interface{
		Name: bindings.Identifier{Name: "Foo"},
		Fields: []*bindings.PropertySignature{
			{Name: "name", Type: kw(bindings.KeywordString)},
		},
	}

	result := serializeNode("Foo", node)

	if !strings.Contains(result, "export const FooSchema = z.object(") {
		t.Errorf("expected z.object declaration, got:\n%s", result)
	}
	if !strings.Contains(result, "name: z.string()") {
		t.Errorf("expected name field, got:\n%s", result)
	}
}

func TestSerializeNodeAlias(t *testing.T) {
	t.Parallel()

	node := &bindings.Alias{
		Name: bindings.Identifier{Name: "MyString"},
		Type: kw(bindings.KeywordString),
	}

	result := serializeNode("MyString", node)

	if !strings.Contains(result, "export const MyStringSchema = z.string()") {
		t.Errorf("expected z.string() alias, got:\n%s", result)
	}
	if !strings.Contains(result, "export type MyString = z.infer<typeof MyStringSchema>") {
		t.Errorf("expected type export, got:\n%s", result)
	}
}

func TestSerializeNodeUnknownReturnsEmpty(t *testing.T) {
	t.Parallel()

	// LiteralKeyword is a Node but not Interface or Alias.
	kword := bindings.KeywordString
	result := serializeNode("X", &kword)

	if result != "" {
		t.Errorf("expected empty string for unknown node type, got %q", result)
	}
}

func TestSerializeInterfaceWithHeritage(t *testing.T) {
	t.Parallel()

	iface := &bindings.Interface{
		Name: bindings.Identifier{Name: "Child"},
		Heritage: []*bindings.HeritageClause{
			bindings.HeritageClauseExtends(ref("Parent")),
		},
		Fields: []*bindings.PropertySignature{
			{Name: "extra", Type: kw(bindings.KeywordString)},
		},
	}

	result := serializeInterface("Child", iface)

	if !strings.Contains(result, "ParentSchema.extend") {
		t.Errorf("expected ParentSchema.extend, got:\n%s", result)
	}
	if !strings.Contains(result, "extra: z.string()") {
		t.Errorf("expected extra field, got:\n%s", result)
	}
}

func TestSerializeStringEnum(t *testing.T) {
	t.Parallel()

	union := &bindings.UnionType{
		Types: []bindings.ExpressionType{
			&bindings.LiteralType{Value: "a"},
			&bindings.LiteralType{Value: "b"},
		},
	}

	result := serializeStringEnum("Status", union)

	if !strings.Contains(result, `z.enum([`) {
		t.Errorf("expected z.enum, got:\n%s", result)
	}
	if !strings.Contains(result, `"a"`) || !strings.Contains(result, `"b"`) {
		t.Errorf("expected enum values, got:\n%s", result)
	}
}

func TestObjectLiteralToZod(t *testing.T) {
	t.Parallel()

	tl := &bindings.TypeLiteralNode{
		Members: []*bindings.PropertySignature{
			{Name: "x", Type: kw(bindings.KeywordNumber)},
			{Name: "y", Type: kw(bindings.KeywordString), QuestionToken: true},
		},
	}

	result := objectLiteralToZod(tl, "")

	if !strings.Contains(result, "z.object(") {
		t.Errorf("expected z.object, got:\n%s", result)
	}
	if !strings.Contains(result, "x: z.number()") {
		t.Errorf("expected x field, got:\n%s", result)
	}
	if !strings.Contains(result, "y: z.string().optional()") {
		t.Errorf("expected optional y field, got:\n%s", result)
	}
}

func TestIntersectionToZod(t *testing.T) {
	t.Parallel()

	t.Run("empty", func(t *testing.T) {
		t.Parallel()
		inter := &bindings.TypeIntersection{}
		if got := intersectionToZod(inter, ""); got != "z.unknown()" {
			t.Errorf("expected z.unknown(), got %q", got)
		}
	})

	t.Run("single", func(t *testing.T) {
		t.Parallel()
		inter := &bindings.TypeIntersection{
			Types: []bindings.ExpressionType{kw(bindings.KeywordString)},
		}
		if got := intersectionToZod(inter, ""); got != "z.string()" {
			t.Errorf("expected z.string(), got %q", got)
		}
	})

	t.Run("two types", func(t *testing.T) {
		t.Parallel()
		inter := &bindings.TypeIntersection{
			Types: []bindings.ExpressionType{
				ref("A"),
				ref("B"),
			},
		}
		got := intersectionToZod(inter, "")
		if !strings.Contains(got, "z.intersection(ASchema, BSchema)") {
			t.Errorf("expected z.intersection(ASchema, BSchema), got %q", got)
		}
	})

	t.Run("three types nested", func(t *testing.T) {
		t.Parallel()
		inter := &bindings.TypeIntersection{
			Types: []bindings.ExpressionType{
				ref("A"),
				ref("B"),
				ref("C"),
			},
		}
		got := intersectionToZod(inter, "")
		expected := "z.intersection(z.intersection(ASchema, BSchema), CSchema)"
		if got != expected {
			t.Errorf("expected %q, got %q", expected, got)
		}
	})
}

func TestSerializeNodeSelfReferenceUsesLazy(t *testing.T) {
	t.Parallel()

	node := &bindings.Interface{
		Name: bindings.Identifier{Name: "Tree"},
		Fields: []*bindings.PropertySignature{
			{Name: "children", Type: bindings.Array(ref("Tree"))},
		},
	}

	result := serializeNode("Tree", node)

	if !strings.Contains(result, "z.lazy(") {
		t.Errorf("expected z.lazy for self-reference, got:\n%s", result)
	}
}

func ref(name string) *bindings.ReferenceType {
	return bindings.Reference(bindings.Identifier{Name: name})
}

func kw(k bindings.LiteralKeyword) *bindings.LiteralKeyword {
	return &k
}
