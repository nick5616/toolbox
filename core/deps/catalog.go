package deps

import "regexp"

// Catalog returns the Phase 1 dependency catalog.
func Catalog() []Spec {
	return []Spec{
		{
			ID: YtDlp, Name: "yt-dlp", Purpose: "Downloads audio and video from links",
			Binary: "yt-dlp", VersionArgs: []string{"--version"},
			VersionRegex: regexp.MustCompile(`^(\S+)`), Managed: true,
			InstallHint: map[string]string{
				"darwin":  "Install from Settings → Dependencies, or run: brew install yt-dlp",
				"windows": "Install from Settings → Dependencies, or run: winget install yt-dlp.yt-dlp",
				"linux":   "Install from Settings → Dependencies, or use your package manager",
			},
		},
		{
			ID: FFmpeg, Name: "FFmpeg", Purpose: "Converts and merges audio and video",
			Binary: "ffmpeg", VersionArgs: []string{"-version"},
			VersionRegex: regexp.MustCompile(`ffmpeg version (\S+)`),
			InstallHint: map[string]string{
				"darwin":  "brew install ffmpeg",
				"windows": "winget install Gyan.FFmpeg",
				"linux":   "sudo apt install ffmpeg",
			},
		},
		{
			ID: FFprobe, Name: "FFprobe", Purpose: "Reads media file details",
			Binary: "ffprobe", VersionArgs: []string{"-version"},
			VersionRegex: regexp.MustCompile(`ffprobe version (\S+)`),
			InstallHint: map[string]string{
				"darwin":  "Comes with ffmpeg: brew install ffmpeg",
				"windows": "Comes with ffmpeg: winget install Gyan.FFmpeg",
				"linux":   "Comes with ffmpeg: sudo apt install ffmpeg",
			},
		},
		{
			ID: Deno, Name: "Deno", Purpose: "JavaScript runtime that helps yt-dlp with some sites",
			Binary: "deno", VersionArgs: []string{"--version"},
			VersionRegex: regexp.MustCompile(`deno (\S+)`),
			InstallHint: map[string]string{
				"darwin":  "brew install deno",
				"windows": "winget install DenoLand.Deno",
				"linux":   "curl -fsSL https://deno.land/install.sh | sh",
			},
		},
		{
			ID: Node, Name: "Node.js", Purpose: "Fallback JavaScript runtime for yt-dlp",
			Binary: "node", VersionArgs: []string{"--version"},
			VersionRegex: regexp.MustCompile(`v?(\S+)`),
			InstallHint: map[string]string{
				"darwin":  "brew install node",
				"windows": "winget install OpenJS.NodeJS.LTS",
				"linux":   "sudo apt install nodejs",
			},
		},
		{
			ID: ExifTool, Name: "ExifTool", Purpose: "Reads and edits file metadata",
			Binary: "exiftool", VersionArgs: []string{"-ver"},
			VersionRegex: regexp.MustCompile(`^(\S+)`),
			InstallHint: map[string]string{
				"darwin":  "brew install exiftool",
				"windows": "winget install OliverBetz.ExifTool",
				"linux":   "sudo apt install libimage-exiftool-perl",
			},
		},
		{
			ID: UV, Name: "uv", Purpose: "Installs the Python runtime for the audio engine",
			Binary: "uv", VersionArgs: []string{"--version"},
			VersionRegex: regexp.MustCompile(`^uv (\S+)`), Managed: true,
			InstallHint: map[string]string{
				"darwin":  "Installed with the audio engine",
				"windows": "Installed with the audio engine",
				"linux":   "Installed with the audio engine",
			},
		},
	}
}
