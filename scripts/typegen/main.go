// codegen generates Zod v4 schemas from codersdk Go types via guts.
//
// Usage: make gen
//
// The output replaces hand-maintained API schemas. Action-specific
// schemas (inputs, outputs) remain hand-written in schemas.ts.
package main

import (
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/coder/guts"
	"github.com/coder/guts/bindings"
	"github.com/coder/guts/bindings/walk"
	"github.com/coder/guts/config"

	"github.com/coder/agents-chat-action/scripts/typegen/zod"
)

// Types the action needs from the Coder API. Only root types that
// are not pulled transitively belong here. Everything else is
// excluded to keep the generated file small and the bundle lean.
var wantedTypes = map[string]bool{
	"Chat":                     true,
	"CreateChatMessageRequest": true,
	"CreateChatRequest":        true,
	"Organization":             true,
	"User":                     true,
}

func main() {
	gen, err := guts.NewGolangParser()
	if err != nil {
		log.Fatalf("new parser: %v", err)
	}

	err = gen.IncludeGenerate("github.com/coder/coder/v2/codersdk")
	if err != nil {
		log.Fatalf("include generate: %v", err)
	}

	gen.IncludeCustomDeclaration(config.StandardMappings())
	gen.IncludeCustomDeclaration(map[string]guts.TypeOverride{
		"encoding/json.RawMessage": func() bindings.ExpressionType {
			kw := bindings.KeywordUnknown
			return &kw
		},
		// ChatMessagePart uses a discriminated union in Go (via
		// `variants` struct tags) that guts flattens into a single
		// object with all fields required. The API returns
		// part-type-specific subsets, so strict validation fails.
		// The action never inspects message parts directly.
		"github.com/coder/coder/v2/codersdk.ChatMessagePart": func() bindings.ExpressionType {
			kw := bindings.KeywordUnknown
			return &kw
		},
	})

	ts, err := gen.ToTypescript()
	if err != nil {
		log.Fatalf("to typescript: %v", err)
	}

	// Pre-Zod mutations that reshape enums and optional fields.
	ts.ApplyMutations(
		config.EnumAsTypes,
		config.SimplifyOmitEmpty,
	)

	// Compute wanted types before Zod rewrites the AST
	// (collectRefs works on Interface/Alias).
	allNodes := make(map[string]bindings.Node)
	ts.ForEach(func(name string, node bindings.Node) {
		allNodes[name] = node
	})
	included := resolveTransitive(allNodes, wantedTypes)
	wantedNames := make(map[string]bool, len(included))
	for name := range included {
		wantedNames[name] = true
	}

	// Rewrite Interface/Alias into Zod schemas, then export.
	ts.ApplyMutations(
		zod.AsSchemas,
		config.ExportTypes,
	)

	// Serialize only the wanted types, sorted by dependencies.
	output, err := ts.SerializeInOrder(func(nodes map[string]bindings.Node) []bindings.Node {
		// Filter to wanted types and their schema bindings.
		filtered := make(map[string]bindings.Node, len(wantedNames)*2)
		for name, node := range nodes {
			baseName := strings.TrimSuffix(name, "Schema")
			if wantedNames[baseName] {
				filtered[name] = node
			}
		}
		return zod.SortByDependencies(filtered)
	})
	if err != nil {
		log.Fatalf("serialize: %v", err)
	}

	_, _ = fmt.Fprint(os.Stdout, output)
}

// resolveTransitive starts from the seeds and pulls in any
// referenced types that exist in allNodes.
func resolveTransitive(allNodes map[string]bindings.Node, seeds map[string]bool) map[string]bindings.Node {
	result := make(map[string]bindings.Node)
	var visit func(name string)
	visit = func(name string) {
		if _, ok := result[name]; ok {
			return
		}
		node, exists := allNodes[name]
		if !exists {
			return
		}
		result[name] = node
		for _, ref := range collectRefs(node) {
			visit(ref)
		}
	}
	for name := range seeds {
		visit(name)
	}
	return result
}

// collectRefs extracts all type reference names from a node
// using the generic AST walker.
func collectRefs(node bindings.Node) []string {
	v := &refVisitor{}
	walk.Walk(v, node)
	return v.refs
}

type refVisitor struct {
	refs []string
}

func (v *refVisitor) Visit(node bindings.Node) walk.Visitor {
	if ref, ok := node.(*bindings.ReferenceType); ok {
		v.refs = append(v.refs, ref.Name.Ref())
	}
	return v
}
