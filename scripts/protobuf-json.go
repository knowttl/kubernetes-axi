package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strconv"
	"strings"
)

func main() {
	result := map[string]map[string]string{}
	for _, file := range os.Args[1:] {
		if file == "--" { continue }
		source, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
		if err != nil { panic(err) }
		imports := map[string]string{}
		for _, entry := range source.Imports {
			path, err := strconv.Unquote(entry.Path.Value)
			if err != nil { panic(err) }
			name := path[strings.LastIndex(path, "/")+1:]
			if entry.Name != nil { name = entry.Name.Name }
			imports[name] = strings.ReplaceAll(path, "/", ".")
		}
		ast.Inspect(source, func(node ast.Node) bool {
			declaration, ok := node.(*ast.TypeSpec)
			if !ok { return true }
			structure, ok := declaration.Type.(*ast.StructType)
			if !ok {
				if reference, ok := declaration.Type.(*ast.SelectorExpr); ok {
					if namespace, ok := reference.X.(*ast.Ident); ok {
						result[declaration.Name.Name] = map[string]string{"@": imports[namespace.Name] + "." + reference.Sel.Name}
					}
				}
				return false
			}
			fields := map[string]string{}
			for _, field := range structure.Fields.List {
				if field.Tag == nil { continue }
				literal, err := strconv.Unquote(field.Tag.Value)
				if err != nil { panic(err) }
				tag := reflect.StructTag(literal)
				name, found := tag.Lookup("json")
				if !found {
					if len(field.Names) == 0 { continue }
					name = field.Names[0].Name
				}
				parts := strings.Split(tag.Get("protobuf"), ",")
				if len(parts) > 1 {
					fields[parts[1]] = strings.Split(name, ",")[0]
				}
			}
			result[declaration.Name.Name] = fields
			return false
		})
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil { panic(err) }
}
