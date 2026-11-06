package documents

import (
	"strings"

	"toolbox/core"
)

// Pandoc exit codes (pandoc's PandocError.exitCode).
const (
	exitPDF        = 43
	exitPDFProgram = 47
	exitParse      = 64
	exitParsec     = 65
	exitMakePDF    = 66
	exitResource   = 99
)

// mapFailure turns a Pandoc failure into an AppError. lines are the stderr
// lines; the message is the last non-empty one.
func mapFailure(exit int, lines []string, to Format) *core.AppError {
	msg := ""
	for i := len(lines) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(lines[i]); s != "" {
			msg = s
			break
		}
	}
	if msg == "" {
		msg = "Pandoc couldn't convert this document"
	}
	all := strings.ToLower(strings.Join(lines, "\n"))
	hint := ""
	switch {
	case exit == exitResource || strings.Contains(all, "could not fetch resource") ||
		strings.Contains(all, "could not find image") || strings.Contains(all, "file not found in resource path"):
		hint = "An image the document links to wasn't found. Put the images next to the document, or remove the link."
	case strings.Contains(all, "unknown font family") || strings.Contains(all, "font family"):
		hint = "Pick another main font."
	case to == FormatPDF && (exit == exitPDF || exit == exitMakePDF || exit == exitPDFProgram || strings.Contains(all, "typst") || strings.Contains(all, "pdf")):
		hint = "The PDF engine couldn't lay out the document; try HTML or docx."
	case exit == exitParse || exit == exitParsec:
		hint = "The file may be damaged or not really in this format."
	}
	e := core.Errorf(core.CodeToolFailed, "%s", msg)
	if hint != "" {
		e = e.WithHint(hint)
	}
	return e
}
