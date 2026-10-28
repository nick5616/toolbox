package exif

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// TestMain turns the test binary into a fake exiftool when FAKE_EXIFTOOL=1
// (the re-exec pattern). The fake speaks the `-stay_open True -@ -` framing:
// arguments one per line, `-execute<N>` runs the command, `{ready<N>}` goes
// to stdout and the `-echo4` text to stderr when it is done.
//
// Behaviour is driven by the command's arguments and env:
//
//	CRASH   exit without answering        HANG    never answer
//	STDERR  print an Error and a Warning  -ver    print 13.59
//	-j      print the JSON file named by FAKE_EXIF_JSON (FAKE_EXIF_JSON_NUM for
//	        -n, FAKE_EXIF_JSON_AFTER when the last arg is a "(…)" output file)
//	-o OUT  copy the last arg to OUT (error if OUT exists; FAKE_EXIF_FAIL=1 fails)
//	FAKE_EXIF_LOG appends every command; FAKE_EXIF_PIDLOG one line per start.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_EXIFTOOL") == "1" {
		os.Exit(fakeExifTool())
	}
	os.Exit(m.Run())
}

func fakeExifTool() int {
	if p := os.Getenv("FAKE_EXIF_PIDLOG"); p != "" {
		appendLine(p, fmt.Sprint(os.Getpid()))
	}
	rd := bufio.NewReader(os.Stdin)
	var args []string
	for {
		line, err := rd.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if line != "" {
			if line == "False" && len(args) > 0 && args[len(args)-1] == "-stay_open" {
				return 0
			}
			if n, ok := strings.CutPrefix(line, "-execute"); ok {
				fakeCommand(args, n)
				args = nil
			} else {
				args = append(args, line)
			}
		}
		if err != nil {
			if err == io.EOF {
				return 0
			}
			return 1
		}
	}
}

func appendLine(path, line string) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintln(f, line)
}

func fakeCommand(args []string, n string) {
	echo := ""
	if l := len(args); l >= 2 && args[l-2] == "-echo4" {
		echo, args = args[l-1], args[:l-2]
	}
	if p := os.Getenv("FAKE_EXIF_LOG"); p != "" {
		appendLine(p, strings.Join(args, "\x1f"))
	}
	has := func(a string) bool {
		for _, x := range args {
			if x == a {
				return true
			}
		}
		return false
	}
	after := func(a string) string {
		for i, x := range args {
			if x == a && i+1 < len(args) {
				return args[i+1]
			}
		}
		return ""
	}
	if has("CRASH") {
		os.Exit(3)
	}
	if has("HANG") {
		time.Sleep(time.Hour)
	}
	last := ""
	if len(args) > 0 {
		last = args[len(args)-1]
	}
	switch {
	case has("STDERR"):
		fmt.Fprintln(os.Stderr, "Warning: minor thing")
		fmt.Fprintln(os.Stderr, "Error: bad thing")
		fmt.Println("partial")
	case has("-ver"):
		fmt.Println("13.59")
	case has("-j"):
		env := "FAKE_EXIF_JSON"
		switch {
		case strings.Contains(last, "("):
			env = "FAKE_EXIF_JSON_AFTER"
		case has("-n") && os.Getenv("FAKE_EXIF_JSON_NUM") != "":
			env = "FAKE_EXIF_JSON_NUM"
		}
		if b, err := os.ReadFile(os.Getenv(env)); err == nil {
			fmt.Print(string(b))
		} else {
			fmt.Fprintln(os.Stderr, "Error: File not found - "+last)
		}
	case has("-o"):
		out := after("-o")
		if os.Getenv("FAKE_EXIF_FAIL") == "1" {
			fmt.Fprintln(os.Stderr, "Error: Can't write this")
			fmt.Println("    0 image files created")
		} else if _, err := os.Stat(out); err == nil {
			fmt.Fprintf(os.Stderr, "Error: '%s' already exists - %s\n", out, last)
		} else if b, err := os.ReadFile(last); err == nil {
			_ = os.WriteFile(out, b, 0o644)
			fmt.Println("    1 image files created")
		}
	}
	fmt.Printf("{ready%s}\n", n)
	if echo != "" {
		fmt.Fprintln(os.Stderr, echo)
	}
}
