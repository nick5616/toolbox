package store

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"toolbox/core"
)

// Library browser queries (Phase 19, SPEC.md §3.2).

type libCursor struct {
	S  string `json:"s"` // sort
	N  int64  `json:"n"` // numeric key (newest/oldest/size)
	T  string `json:"t"` // text key (name)
	ID string `json:"i"`
}

// QueryLibrary pages through outputs with the Library's filters. libraryDir
// resolves q.Folder (direct children only). The cursor is opaque
// (base64url JSON of the sort key and the last row's ID).
func (d *DB) QueryLibrary(ctx context.Context, q core.LibraryQuery, libraryDir string) (core.OutputPage, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	sortName := q.Sort
	if sortName == "" {
		sortName = core.SortNewest
	}
	var keyExpr, dir string
	text := false
	switch sortName {
	case core.SortNewest:
		keyExpr, dir = "created_at", "DESC"
	case core.SortOldest:
		keyExpr, dir = "created_at", "ASC"
	case core.SortSize:
		keyExpr, dir = "size_bytes", "DESC"
	case core.SortName:
		keyExpr, dir, text = "lower(name)", "ASC", true
	default:
		return core.OutputPage{}, core.Errorf(core.CodeValidation, "Unknown sort %q", string(q.Sort))
	}

	var where []string
	var args []any
	if q.ModuleID != "" {
		where = append(where, "module_id = ?")
		args = append(args, q.ModuleID)
	}
	if q.Search != "" {
		where = append(where, `name LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(q.Search)+"%")
	}
	if len(q.Kinds) > 0 {
		ph := make([]string, len(q.Kinds))
		for i, k := range q.Kinds {
			ph[i] = "?"
			args = append(args, string(k))
		}
		where = append(where, "kind IN ("+strings.Join(ph, ",")+")")
	}
	if q.Since > 0 {
		where = append(where, "created_at >= ?")
		args = append(args, q.Since)
	}
	if q.Until > 0 {
		where = append(where, "created_at <= ?")
		args = append(args, q.Until)
	}
	if q.Folder != "" {
		prefix := strings.TrimRight(libraryDir, `/\`)
		for _, part := range strings.FieldsFunc(q.Folder, func(r rune) bool { return r == '/' || r == '\\' }) {
			prefix += string(os.PathSeparator) + part
		}
		prefix += string(os.PathSeparator)
		n := utf8.RuneCountInString(prefix)
		where = append(where, "lower(substr(path, 1, ?)) = lower(?)", "instr(substr(path, ?), ?) = 0")
		args = append(args, n, prefix, n+1, string(os.PathSeparator))
	}
	if q.Cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(q.Cursor)
		var c libCursor
		if err != nil || json.Unmarshal(raw, &c) != nil || c.S != string(sortName) {
			return core.OutputPage{}, core.Errorf(core.CodeValidation, "Invalid page cursor")
		}
		op := "<"
		if dir == "ASC" {
			op = ">"
		}
		if text {
			where = append(where, fmt.Sprintf("(%s %s ? OR (%s = ? AND id %s ?))", keyExpr, op, keyExpr, op))
			args = append(args, c.T, c.T, c.ID)
		} else {
			where = append(where, fmt.Sprintf("(%s %s ? OR (%s = ? AND id %s ?))", keyExpr, op, keyExpr, op))
			args = append(args, c.N, c.N, c.ID)
		}
	}
	sqlq := `SELECT ` + outputCols + ` FROM outputs`
	if len(where) > 0 {
		sqlq += ` WHERE ` + strings.Join(where, " AND ")
	}
	sqlq += fmt.Sprintf(` ORDER BY %s %s, id %s LIMIT ?`, keyExpr, dir, dir)
	args = append(args, limit+1)
	outs, err := d.queryOutputs(ctx, sqlq, args...)
	if err != nil {
		return core.OutputPage{}, err
	}
	page := core.OutputPage{Items: outs}
	if len(outs) > limit {
		page.Items = outs[:limit]
		last := page.Items[limit-1]
		c := libCursor{S: string(sortName), ID: last.ID}
		switch sortName {
		case core.SortName:
			c.T = strings.ToLower(last.Name)
		case core.SortSize:
			c.N = last.SizeBytes
		default:
			c.N = last.CreatedAt
		}
		b, _ := json.Marshal(c)
		page.NextCursor = base64.RawURLEncoding.EncodeToString(b)
	}
	return page, nil
}

// OutputModulesUnder maps every registered output path inside dir (at any
// depth) to its module ID. The Library's folder tree uses it for counts.
func (d *DB) OutputModulesUnder(ctx context.Context, dir string) (map[string]string, error) {
	prefix := strings.TrimRight(dir, `/\`) + string(os.PathSeparator)
	rows, err := d.sql.QueryContext(ctx, `SELECT path, module_id FROM outputs WHERE lower(substr(path, 1, ?)) = lower(?)`,
		utf8.RuneCountInString(prefix), prefix)
	if err != nil {
		return nil, fmt.Errorf("output paths: %w", err)
	}
	defer rows.Close()
	res := map[string]string{}
	for rows.Next() {
		var p, m string
		if err := rows.Scan(&p, &m); err != nil {
			return nil, fmt.Errorf("scan output path: %w", err)
		}
		res[p] = m
	}
	return res, rows.Err()
}

// OutputByPath returns the output registered at path.
func (d *DB) OutputByPath(ctx context.Context, path string) (core.Output, bool, error) {
	outs, err := d.queryOutputs(ctx, `SELECT `+outputCols+` FROM outputs WHERE path = ?`, path)
	if err != nil || len(outs) == 0 {
		return core.Output{}, false, err
	}
	return outs[0], true, nil
}

// OutputsByPaths returns the outputs registered at any of paths.
func (d *DB) OutputsByPaths(ctx context.Context, paths []string) ([]core.Output, error) {
	res := []core.Output{}
	const chunk = 400
	for i := 0; i < len(paths); i += chunk {
		end := min(i+chunk, len(paths))
		ph := make([]string, 0, end-i)
		args := make([]any, 0, end-i)
		for _, p := range paths[i:end] {
			ph = append(ph, "?")
			args = append(args, p)
		}
		outs, err := d.queryOutputs(ctx, `SELECT `+outputCols+` FROM outputs WHERE path IN (`+strings.Join(ph, ",")+`)`, args...)
		if err != nil {
			return nil, err
		}
		res = append(res, outs...)
	}
	return res, nil
}
