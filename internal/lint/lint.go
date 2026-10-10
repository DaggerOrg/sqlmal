// Package lint finds migration statements that are risky on a live database.
//
// It works on the statement text, not a full SQL parser, so every rule is
// conservative: it names the pattern it saw and why that is risky.
package lint

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/Stephen-SMH/migrate-studio/internal/migration"
	"github.com/Stephen-SMH/migrate-studio/internal/sqlsplit"
)

type Severity string

const (
	Error   Severity = "error"
	Warning Severity = "warning"
	Info    Severity = "info"
)

type Finding struct {
	Rule     string   `json:"rule"`
	Severity Severity `json:"severity"`
	File     string   `json:"file"` // "up" or "down"
	Line     int      `json:"line"`
	Message  string   `json:"message"`
	Hint     string   `json:"hint,omitempty"`
}

var (
	createTableRe = regexp.MustCompile(`^CREATE (?:UNLOGGED |TEMP(?:ORARY)? )?TABLE (?:IF NOT EXISTS )?([^ (]+)`)
	alterTableRe  = regexp.MustCompile(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([^ ]+)`)
	createIdxRe   = regexp.MustCompile(`^CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?(?:[^ ]+ )?ON (?:ONLY )?([^ (]+)`)
	addColumnRe   = regexp.MustCompile(`\bADD (?:COLUMN )?(?:IF NOT EXISTS )?("?[A-Z_][A-Z0-9_$]*"?) ([^,]*)`)
)

// Migration lints one migration's up and down files.
func Migration(m migration.Migration) []Finding {
	var out []Finding
	out = append(out, file(m, "up", m.UpSQL, m.NoTx)...)
	if m.HasDown {
		out = append(out, file(m, "down", m.DownSQL, m.DownNoTx)...)
	} else if !m.OneWay {
		out = append(out, Finding{Rule: "L007", Severity: Warning, File: "down", Line: 1,
			Message: "There is no down migration, so this change cannot be rolled back.",
			Hint:    "Write the reverse of the up file, or put '-- migrate:irreversible' in the down file to say it is one-way on purpose."})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File == "up"
		}
		return out[i].Line < out[j].Line
	})
	return out
}

func file(m migration.Migration, which, sql string, noTx bool) []Finding {
	var out []Finding
	add := func(rule string, sev Severity, line int, msg, hint string) {
		out = append(out, Finding{Rule: rule, Severity: sev, File: which, Line: line, Message: msg, Hint: hint})
	}
	created := map[string]bool{} // tables created earlier in this same file are empty, so most lock risks do not apply
	for _, st := range sqlsplit.Split(sql) {
		n := sqlsplit.Normalize(st.SQL)
		if m := createTableRe.FindStringSubmatch(n); m != nil {
			created[strings.Trim(m[1], `"`)] = true
		}
		alter := alterTableRe.FindStringSubmatch(n)
		table := ""
		if alter != nil {
			table = strings.Trim(alter[1], `"`)
		}
		fresh := created[table]

		// A down file is expected to drop what its up created, so L001 is for up files only.
		destructiveOK := which == "up"
		if destructiveOK && strings.HasPrefix(n, "DROP TABLE") {
			add("L001", Warning, st.Line, "DROP TABLE permanently deletes the table and its data.", "Make sure a backup exists and nothing still reads this table. Consider renaming it first and dropping it in a later release.")
		}
		if destructiveOK && alter != nil && strings.Contains(n, " DROP COLUMN ") {
			add("L001", Warning, st.Line, "DROP COLUMN permanently deletes the column's data and breaks code that still reads it.", "Deploy code that stops using the column first, then drop it.")
		}
		if alter != nil && (strings.Contains(n, " SET DATA TYPE ") || regexp.MustCompile(` ALTER (?:COLUMN )?\S+ TYPE `).MatchString(n)) && !fresh {
			add("L002", Warning, st.Line, "Changing a column's type can rewrite the whole table while holding a lock that blocks reads and writes.", "Add a new column, backfill in batches, then swap. Some widenings (for example varchar to text) do not rewrite.")
		}
		if alter != nil && !fresh {
			for _, c := range addColumnRe.FindAllStringSubmatch(n, -1) {
				def := c[2]
				if strings.Contains(def, "NOT NULL") && !strings.Contains(def, "DEFAULT") && !strings.Contains(def, "GENERATED") && !strings.Contains(def, "SERIAL") {
					add("L003", Error, st.Line, fmt.Sprintf("Adding NOT NULL column %s with no default fails when the table already has rows.", strings.ToLower(c[1])), "Add the column as nullable (or with a DEFAULT), backfill, then SET NOT NULL.")
				}
			}
			if strings.Contains(n, " SET NOT NULL") {
				add("L010", Warning, st.Line, "SET NOT NULL scans the whole table while holding a lock.", "On large tables add a CHECK (col IS NOT NULL) NOT VALID, validate it, then SET NOT NULL.")
			}
			if strings.Contains(n, "FOREIGN KEY") && !strings.Contains(n, "NOT VALID") {
				add("L005", Warning, st.Line, "Adding a foreign key validates every existing row while holding a lock.", "Add it NOT VALID, then run ALTER TABLE ... VALIDATE CONSTRAINT in a separate step.")
			}
		}
		if m := createIdxRe.FindStringSubmatch(n); m != nil {
			concurrently := m[1] != ""
			if !concurrently && !created[strings.Trim(m[2], `"`)] {
				add("L004", Warning, st.Line, "CREATE INDEX without CONCURRENTLY blocks writes to the table until it finishes.", "Use CREATE INDEX CONCURRENTLY and put '-- migrate:no-transaction' at the top of the file.")
			}
			if concurrently && !noTx {
				add("L009", Error, st.Line, "CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this migration will fail.", "Add '-- migrate:no-transaction' as the first line of this file.")
			}
		}
		if strings.HasPrefix(n, "TRUNCATE") {
			add("L006", Warning, st.Line, "TRUNCATE removes every row in the table.", "Confirm this is a development or reference table.")
		}
		if (strings.HasPrefix(n, "DELETE FROM") || strings.HasPrefix(n, "UPDATE ")) && !strings.Contains(n, " WHERE ") {
			verb := strings.Fields(n)[0]
			add("L006", Warning, st.Line, verb+" with no WHERE clause changes every row.", "Add a WHERE clause, or confirm this is intentional.")
		}
		if alter != nil && (strings.Contains(n, " RENAME COLUMN ") || strings.Contains(n, " RENAME TO ")) || strings.HasPrefix(n, "ALTER TABLE") && strings.Contains(n, " RENAME ") {
			add("L008", Info, st.Line, "Renaming breaks any running code that uses the old name.", "Deploy a compatibility view or column first, or accept brief downtime.")
		}
	}
	return out
}

// Counts summarises findings by severity.
func Counts(f []Finding) (errs, warns, infos int) {
	for _, x := range f {
		switch x.Severity {
		case Error:
			errs++
		case Warning:
			warns++
		default:
			infos++
		}
	}
	return
}
