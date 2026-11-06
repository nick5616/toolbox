package documents

import (
	"fmt"
	"os"
	"path/filepath"
)

// runInfo is everything buildArgs needs besides the options.
type runInfo struct {
	Input     string // absolute input path
	Output    string // absolute output path (inside TempDir)
	DataDir   string // empty --data-dir
	Typst     string // typst path (pdf only)
	MetaFile  string // metadata YAML holding the typst margin map; "" = none
	MediaDir  string // --extract-media target (relative to cwd); "" = none
	InputSpec formatSpec
}

// buildArgs is the pandoc argv (without the program) for the options.
func buildArgs(o Options, in runInfo) ([]string, error) {
	out, ok := lookupFormat(o.To)
	if !ok {
		return nil, fmt.Errorf("unknown format %q", o.To)
	}
	writer := out.Writer
	if o.To == FormatPDF {
		writer = "pdf"
	}
	args := []string{
		"+RTS", "-M1024M", "-RTS",
		"--data-dir=" + in.DataDir,
		"--resource-path=" + filepath.Dir(in.Input),
		"-f", in.InputSpec.Reader,
		"-t", writer,
	}
	if out.Standalone {
		args = append(args, "-s")
	}
	switch o.To {
	case FormatPDF:
		args = append(args, "--pdf-engine="+in.Typst)
	case FormatHTML:
		if o.EmbedResources {
			args = append(args, "--embed-resources")
		}
	}
	if o.TOC {
		args = append(args, "--toc")
	}
	if o.NumberSections {
		args = append(args, "--number-sections")
	}
	if (o.To == FormatDOCX || o.To == FormatODT) && o.ReferenceDoc != "" {
		args = append(args, "--reference-doc="+o.ReferenceDoc)
	}
	if o.To == FormatPDF || o.To == FormatTypst {
		args = append(args, "-V", "papersize="+typstPaper(o.PageSize), "-V", fmt.Sprintf("fontsize=%dpt", o.FontSizePt))
		if o.MainFont != "" {
			args = append(args, "-V", "mainfont="+o.MainFont)
		}
		if in.MetaFile != "" {
			args = append(args, "--metadata-file="+in.MetaFile)
		}
	}
	if in.MediaDir != "" && (o.To == FormatMD || o.To == FormatGFM || o.To == FormatHTML) {
		args = append(args, "--extract-media="+in.MediaDir)
	}
	args = append(args, "-o", in.Output, in.Input)
	return args, nil
}

// env is the extra environment for pandoc (and the typst it launches).
// Typst's fonts: media.Fonts() lists family names, not folders, so
// TYPST_FONT_PATHS is not set; Typst uses the system fonts.
func env(packageCache string) []string {
	if packageCache == "" {
		return nil
	}
	return []string{"TYPST_PACKAGE_CACHE_PATH=" + packageCache}
}

func typstPaper(size string) string {
	if size == "letter" {
		return "us-letter"
	}
	return "a4"
}

// marginMeta writes the YAML metadata file holding the margin map (pandoc's
// -V can't build maps) and returns its path.
func marginMeta(dir string, mm int) (string, error) {
	p := filepath.Join(dir, "layout.yaml")
	body := fmt.Sprintf("margin:\n  x: %dmm\n  y: %dmm\n", mm, mm)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		return "", fmt.Errorf("write layout metadata: %w", err)
	}
	return p, nil
}
