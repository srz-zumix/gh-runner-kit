package runner

import (
	"fmt"
	"runtime"
)

// Platform returns the actions/runner release asset platform identifier for the
// current OS/architecture, e.g. "linux-x64", "osx-arm64", "win-x64".
func Platform() (string, error) {
	var osName string
	switch runtime.GOOS {
	case "linux":
		osName = "linux"
	case "darwin":
		osName = "osx"
	case "windows":
		osName = "win"
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}

	var arch string
	switch runtime.GOARCH {
	case "amd64":
		arch = "x64"
	case "arm64":
		arch = "arm64"
	case "arm":
		arch = "arm"
	default:
		return "", fmt.Errorf("unsupported architecture: %s", runtime.GOARCH)
	}

	return osName + "-" + arch, nil
}
