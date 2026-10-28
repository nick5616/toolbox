package pdf

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"toolbox/core"
)

// enqueue validates against the documents (page counts, passwords), stores
// passwords in memory and submits the jobs: one for merge and images-to-pdf,
// one per input otherwise.
func (m *Module) enqueue(ctx context.Context, jobs *core.Jobs, paths []string, opts Options, password, newPassword string) ([]core.Job, error) {
	opts = withDefaults(opts)
	opts.PasswordRef = "" // never trust a caller-supplied ref
	if !validAction(opts.Action) {
		return nil, fieldErr("action", fmt.Sprintf("Unknown action %q", opts.Action))
	}
	// Syntax-only option checks first (secrets are checked below).
	probe := opts
	if err := m.checkOptions(probe); err != nil && !isSecretField(err) {
		return nil, err
	}
	if err := checkInputs(opts.Action, paths); err != nil {
		return nil, err
	}
	if opts.Action == ActionProtect && newPassword == "" {
		return nil, fieldErr("newPassword", "Enter a password to protect the PDF with")
	}
	if opts.Action == ActionUnlock && password == "" {
		return nil, fieldErr("password", "Enter the PDF's password")
	}
	if err := m.checkDocuments(ctx, paths, opts, password); err != nil {
		return nil, err
	}

	ref := ""
	if password != "" || newPassword != "" {
		ref = m.state.sec.put(password, newPassword)
		opts.PasswordRef = ref
	}
	raw, err := json.Marshal(opts)
	if err != nil {
		m.state.sec.drop(ref)
		return nil, fmt.Errorf("marshal pdf options: %w", err)
	}

	var groups [][]string
	if opts.Action == ActionMerge || opts.Action == ActionImagesToPDF {
		groups = [][]string{paths}
	} else {
		for _, p := range paths {
			groups = append(groups, []string{p})
		}
	}
	var out []core.Job
	for _, g := range groups {
		js, err := jobs.Submit(ctx, ModuleID, g, string(raw))
		if err != nil {
			if len(out) == 0 {
				m.state.sec.drop(ref)
			} else if ref != "" {
				m.state.sec.setJobs(ref, len(out))
			}
			return out, err
		}
		out = append(out, js...)
	}
	if ref != "" {
		m.state.sec.setJobs(ref, len(out))
	}
	return out, nil
}

func isSecretField(err error) bool {
	ae := core.AsAppError(err)
	if ae == nil {
		return false
	}
	_, a := ae.Fields["newPassword"]
	_, b := ae.Fields["password"]
	return a || b
}

// checkDocuments opens every PDF input to check passwords, permissions and
// page references.
func (m *Module) checkDocuments(ctx context.Context, paths []string, o Options, password string) error {
	if o.Action == ActionImagesToPDF {
		for _, p := range paths {
			if _, err := readImgInfo(p); err != nil {
				return err
			}
		}
		return nil
	}
	for _, p := range paths {
		name := filepath.Base(p)
		in, err := m.info(ctx, p, password)
		if err != nil {
			if ae := core.AsAppError(err); ae != nil && ae.Code == core.CodeValidation {
				return core.ValidationError(name+": "+lowerFirst(ae.Message), ae.Fields).WithHint(ae.Hint)
			}
			return err
		}
		if in.NeedsPassword {
			if o.Action == ActionUnlock {
				return core.ValidationError(name+": "+msgWrongPassword, map[string]string{"password": msgWrongPassword})
			}
			return core.ValidationError(name+" needs a password", map[string]string{"password": msgNeedPassword})
		}
		if in.Restricted && o.Action != ActionPDFToImages {
			return core.ValidationError(name+": "+lowerFirst(msgRestricted)+" — enter its owner password", map[string]string{"password": hintRestricted})
		}
		switch o.Action {
		case ActionUnlock:
			if !in.Encrypted {
				return core.ValidationError(name+" isn't password-protected", nil)
			}
		case ActionSplit:
			if o.SplitMode == SplitRanges {
				if _, err := parseRanges(o.Ranges, in.Pages); err != nil {
					return core.ValidationError(name+": "+err.Error(), map[string]string{"ranges": capitalize(err.Error())})
				}
			}
		case ActionOrganize:
			for _, pe := range o.Pages {
				if pe.Page > in.Pages {
					msg := fmt.Sprintf("Page %d doesn't exist (the document has %d)", pe.Page, in.Pages)
					return core.ValidationError(msg, map[string]string{"pages": msg})
				}
			}
		case ActionPDFToImages:
			if strings.TrimSpace(o.PageRange) != "" {
				if _, err := parseRanges(o.PageRange, in.Pages); err != nil {
					return core.ValidationError(name+": "+err.Error(), map[string]string{"pageRange": capitalize(err.Error())})
				}
			}
		}
	}
	return nil
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}
