// Zod v4 serializer for guts AST nodes.
//
// Local copy of the unreleased github.com/coder/guts/zod package.
// Replace with an import when released.
package main

import (
	"fmt"
	"strings"

	"github.com/coder/guts/bindings"
)

func serializeNode(name string, node bindings.Node) string {
	switch n := node.(type) {
	case *bindings.Interface:
		return serializeInterface(name, n)
	case *bindings.Alias:
		return serializeAlias(name, n)
	default:
		return ""
	}
}

func serializeInterface(name string, iface *bindings.Interface) string {
	schema := schemaName(name)
	var b strings.Builder

	// Handle struct embedding (heritage clauses) via .extend().
	base := ""
	for _, h := range iface.Heritage {
		for _, arg := range h.Args {
			found := ""
			if ewta, ok := arg.(*bindings.ExpressionWithTypeArguments); ok {
				if r, ok := ewta.Expression.(*bindings.ReferenceType); ok {
					found = schemaName(r.Name.Ref())
				}
			}
			if rt, ok := arg.(*bindings.ReferenceType); ok {
				found = schemaName(rt.Name.Ref())
			}
			if found != "" {
				if base != "" {
					panic(fmt.Sprintf("serializeInterface(%q): multiple heritage bases (%s, %s); Zod does not support multiple inheritance", name, base, found))
				}
				base = found
			}
		}
	}

	if base != "" && len(iface.Fields) > 0 {
		b.WriteString(fmt.Sprintf("export const %s = %s.extend({\n", schema, base))
	} else if base != "" {
		b.WriteString(fmt.Sprintf("export const %s = %s;\n", schema, base))
		b.WriteString(fmt.Sprintf("export type %s = z.infer<typeof %s>;\n", name, schema))
		return b.String()
	} else {
		b.WriteString(fmt.Sprintf("export const %s = z.object({\n", schema))
	}
	for _, f := range iface.Fields {
		zodType := exprToZod(f.Type, name)
		if f.QuestionToken {
			zodType += ".optional()"
		}
		b.WriteString(fmt.Sprintf("  %s: %s,\n", f.Name, zodType))
	}
	b.WriteString("});\n")
	b.WriteString(fmt.Sprintf("export type %s = z.infer<typeof %s>;\n", name, schema))
	return b.String()
}

func serializeAlias(name string, alias *bindings.Alias) string {
	if union, ok := alias.Type.(*bindings.UnionType); ok {
		if isStringLiteralUnion(union) {
			return serializeStringEnum(name, union)
		}
	}

	schema := schemaName(name)
	zodType := exprToZod(alias.Type, name)
	var b strings.Builder
	b.WriteString(fmt.Sprintf("export const %s = %s;\n", schema, zodType))
	b.WriteString(fmt.Sprintf("export type %s = z.infer<typeof %s>;\n", name, schema))
	return b.String()
}

func serializeStringEnum(name string, union *bindings.UnionType) string {
	schema := schemaName(name)
	var values []string
	for _, t := range union.Types {
		if lit, ok := t.(*bindings.LiteralType); ok {
			values = append(values, fmt.Sprintf("  %q", lit.Value))
		}
	}
	var b strings.Builder
	b.WriteString(fmt.Sprintf("export const %s = z.enum([\n", schema))
	b.WriteString(strings.Join(values, ",\n"))
	b.WriteString(",\n]);\n")
	b.WriteString(fmt.Sprintf("export type %s = z.infer<typeof %s>;\n", name, schema))
	return b.String()
}

func exprToZod(expr bindings.ExpressionType, selfName string) string {
	if expr == nil {
		return "z.unknown()"
	}
	switch e := expr.(type) {
	case *bindings.LiteralKeyword:
		return keywordToZod(e)
	case *bindings.LiteralType:
		return literalToZod(e)
	case *bindings.ReferenceType:
		return referenceToZod(e, selfName)
	case *bindings.ArrayType:
		return fmt.Sprintf("z.array(%s)", exprToZod(e.Node, selfName))
	case *bindings.UnionType:
		return unionToZod(e, selfName)
	case *bindings.Null:
		return "z.null()"
	case *bindings.TypeLiteralNode:
		return objectLiteralToZod(e, selfName)
	case *bindings.TypeIntersection:
		return intersectionToZod(e, selfName)
	case *bindings.TupleType:
		return fmt.Sprintf("z.array(%s)", exprToZod(e.Node, selfName))
	case *bindings.OperatorNodeType:
		return exprToZod(e.Type, selfName)
	default:
		return "z.unknown()"
	}
}

func keywordToZod(kw *bindings.LiteralKeyword) string {
	switch *kw {
	case bindings.KeywordString:
		return "z.string()"
	case bindings.KeywordNumber:
		return "z.number()"
	case bindings.KeywordBoolean:
		return "z.boolean()"
	case bindings.KeywordAny, bindings.KeywordUnknown:
		return "z.unknown()"
	case bindings.KeywordVoid, bindings.KeywordUndefined:
		return "z.undefined()"
	case bindings.KeywordNever:
		return "z.never()"
	default:
		return "z.unknown()"
	}
}

func literalToZod(lit *bindings.LiteralType) string {
	switch v := lit.Value.(type) {
	case string:
		return fmt.Sprintf("z.literal(%q)", v)
	case bool:
		return fmt.Sprintf("z.literal(%t)", v)
	case int64:
		return fmt.Sprintf("z.literal(%d)", v)
	case float64:
		return fmt.Sprintf("z.literal(%g)", v)
	default:
		return fmt.Sprintf("z.literal(%v)", v)
	}
}

func referenceToZod(ref *bindings.ReferenceType, selfName string) string {
	name := ref.Name.Ref()
	if name == "Record" && len(ref.Arguments) == 2 {
		return fmt.Sprintf("z.record(%s, %s)",
			exprToZod(ref.Arguments[0], selfName),
			exprToZod(ref.Arguments[1], selfName),
		)
	}
	switch name {
	case "Omit", "Pick", "Partial", "Required":
		return "z.unknown()"
	}
	// Self-referential types need z.lazy() to avoid
	// reference-before-declaration errors.
	if selfName != "" && name == selfName {
		return fmt.Sprintf("z.lazy((): z.ZodType => %s)", schemaName(name))
	}
	return schemaName(name)
}

func unionToZod(u *bindings.UnionType, selfName string) string {
	nonNull := make([]bindings.ExpressionType, 0, len(u.Types))
	hasNull := false
	for _, t := range u.Types {
		if _, ok := t.(*bindings.Null); ok {
			hasNull = true
		} else {
			nonNull = append(nonNull, t)
		}
	}
	if hasNull && len(nonNull) == 1 {
		return exprToZod(nonNull[0], selfName) + ".nullable()"
	}
	if !hasNull && len(nonNull) == 1 {
		return exprToZod(nonNull[0], selfName)
	}
	parts := make([]string, 0, len(u.Types))
	for _, t := range u.Types {
		parts = append(parts, exprToZod(t, selfName))
	}
	return fmt.Sprintf("z.union([%s])", strings.Join(parts, ", "))
}

func objectLiteralToZod(tl *bindings.TypeLiteralNode, selfName string) string {
	var b strings.Builder
	b.WriteString("z.object({\n")
	for _, f := range tl.Members {
		zodType := exprToZod(f.Type, selfName)
		if f.QuestionToken {
			zodType += ".optional()"
		}
		b.WriteString(fmt.Sprintf("    %s: %s,\n", f.Name, zodType))
	}
	b.WriteString("  })")
	return b.String()
}

func intersectionToZod(inter *bindings.TypeIntersection, selfName string) string {
	if len(inter.Types) == 0 {
		return "z.unknown()"
	}
	if len(inter.Types) == 1 {
		return exprToZod(inter.Types[0], selfName)
	}
	parts := make([]string, 0, len(inter.Types))
	for _, t := range inter.Types {
		parts = append(parts, exprToZod(t, selfName))
	}
	result := parts[0]
	for _, p := range parts[1:] {
		result = fmt.Sprintf("z.intersection(%s, %s)", result, p)
	}
	return result
}

func isStringLiteralUnion(u *bindings.UnionType) bool {
	if len(u.Types) == 0 {
		return false
	}
	for _, t := range u.Types {
		lit, ok := t.(*bindings.LiteralType)
		if !ok {
			return false
		}
		if _, ok := lit.Value.(string); !ok {
			return false
		}
	}
	return true
}

func schemaName(typeName string) string {
	return typeName + "Schema"
}
