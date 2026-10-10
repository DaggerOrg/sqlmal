// Package sqlsplit cuts a SQL script into statements without a full parser.
//
// It understands the parts of PostgreSQL syntax that hide semicolons and
// keywords: single-quoted strings (including E” escapes), double-quoted
// identifiers, $tag$ dollar quotes, line comments, and nested block comments.
package sqlsplit

import "strings"

// Stmt is one statement with comments removed.
type Stmt struct {
	// SQL is the statement text, comments stripped, no trailing semicolon.
	SQL string
	// Line is the 1-based line where the statement starts.
	Line int
}

// Split returns the statements in script order. Empty statements are dropped.
func Split(src string) []Stmt {
	var out []Stmt
	var cur strings.Builder
	line, startLine := 1, 0
	flush := func() {
		s := strings.TrimSpace(cur.String())
		if s != "" {
			out = append(out, Stmt{SQL: s, Line: startLine})
		}
		cur.Reset()
		startLine = 0
	}
	mark := func() {
		if startLine == 0 {
			startLine = line
		}
	}
	i, n := 0, len(src)
	for i < n {
		c := src[i]
		switch {
		case c == '\n':
			line++
			cur.WriteByte(c)
			i++
		case c == '-' && i+1 < n && src[i+1] == '-': // line comment
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && src[i+1] == '*': // block comment, nests in PostgreSQL
			depth := 1
			i += 2
			for i < n && depth > 0 {
				switch {
				case src[i] == '\n':
					line++
					i++
				case src[i] == '/' && i+1 < n && src[i+1] == '*':
					depth++
					i += 2
				case src[i] == '*' && i+1 < n && src[i+1] == '/':
					depth--
					i += 2
				default:
					i++
				}
			}
			cur.WriteByte(' ')
		case c == '\'':
			mark()
			escapes := i > 0 && (src[i-1] == 'E' || src[i-1] == 'e') // E'..\'..'
			j := i + 1
			for j < n {
				if escapes && src[j] == '\\' && j+1 < n {
					j += 2
					continue
				}
				if src[j] == '\'' {
					if j+1 < n && src[j+1] == '\'' { // '' is an escaped quote
						j += 2
						continue
					}
					break
				}
				if src[j] == '\n' {
					line++
				}
				j++
			}
			end := min(j+1, n)
			cur.WriteString(src[i:end])
			i = end
		case c == '"':
			mark()
			j := i + 1
			for j < n && !(src[j] == '"' && !(j+1 < n && src[j+1] == '"')) {
				if src[j] == '"' { // "" inside an identifier
					j += 2
					continue
				}
				j++
			}
			end := min(j+1, n)
			cur.WriteString(src[i:end])
			i = end
		case c == '$':
			if tag, ok := dollarTag(src, i); ok {
				mark()
				end := strings.Index(src[i+len(tag):], tag)
				stop := n
				if end >= 0 {
					stop = i + len(tag) + end + len(tag)
				}
				body := src[i:stop]
				line += strings.Count(body, "\n")
				cur.WriteString(body)
				i = stop
				continue
			}
			mark()
			cur.WriteByte(c)
			i++
		case c == ';':
			flush()
			i++
		default:
			if c != ' ' && c != '\t' && c != '\r' {
				mark()
			}
			cur.WriteByte(c)
			i++
		}
	}
	flush()
	return out
}

// dollarTag reports whether a dollar-quote opener such as $$ or $body$ starts at i.
func dollarTag(src string, i int) (string, bool) {
	j := i + 1
	for j < len(src) {
		c := src[j]
		if c == '$' {
			return src[i : j+1], true
		}
		if !(c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (j > i+1 && c >= '0' && c <= '9')) {
			return "", false
		}
		j++
	}
	return "", false
}

// Normalize uppercases a statement, collapses whitespace, and blanks string
// literals, so keyword rules cannot be fooled by text inside a string.
func Normalize(sql string) string {
	var b strings.Builder
	inStr := false
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		if c == '\'' {
			if inStr && i+1 < len(sql) && sql[i+1] == '\'' {
				i++
				continue
			}
			if inStr {
				b.WriteString("''") // one placeholder per literal, written when it closes
			}
			inStr = !inStr
			continue
		}
		if inStr {
			continue
		}
		b.WriteByte(c)
	}
	return strings.Join(strings.Fields(strings.ToUpper(b.String())), " ")
}
