package runner

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
)

const (
	runnerReleaseOwner = "actions"
	runnerReleaseRepo  = "runner"
)

// LatestVersion returns the latest actions/runner release version (without the "v" prefix).
// The release is always read from github.com, so an authenticated github.com client is used
// to avoid the anonymous API rate limit.
func LatestVersion(ctx context.Context) (string, error) {
	client, err := gh.NewGitHubClientForDefaultHost()
	if err != nil {
		return "", err
	}
	release, err := gh.GetLatestRelease(ctx, client, repository.Repository{Owner: runnerReleaseOwner, Name: runnerReleaseRepo})
	if err != nil {
		return "", fmt.Errorf("failed to get latest actions/runner release: %w", err)
	}
	return strings.TrimPrefix(release.GetTagName(), "v"), nil
}

// DownloadURL returns the download URL of the actions/runner release archive for platform and version.
func DownloadURL(platform, version string) string {
	ext := "tar.gz"
	if strings.HasPrefix(platform, "win-") {
		ext = "zip"
	}
	return fmt.Sprintf("https://github.com/%s/%s/releases/download/v%s/actions-runner-%s-%s.%s",
		runnerReleaseOwner, runnerReleaseRepo, version, platform, version, ext)
}

// Download downloads the actions/runner release archive for platform/version and extracts it into dir.
// dir is created if it does not already exist.
func Download(ctx context.Context, dir, platform, version string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	url := DownloadURL(platform, version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download %s: unexpected status %s", url, resp.Status)
	}

	if strings.HasSuffix(url, ".zip") {
		return extractZip(resp.Body, dir)
	}
	return extractTarGz(resp.Body, dir)
}

func extractTarGz(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		target, err := safeJoin(dir, header.Name)
		if err != nil {
			return err
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := extractTarFile(tr, target, header); err != nil {
				return err
			}
		case tar.TypeSymlink:
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				return err
			}
		}
	}
}

func extractTarFile(tr *tar.Reader, target string, header *tar.Header) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode))
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, tr)
	return err
}

func extractZip(r io.Reader, dir string) error {
	// zip.Reader requires io.ReaderAt, so the download is buffered to a temp file first.
	tmp, err := os.CreateTemp("", "actions-runner-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	if _, err := io.Copy(tmp, r); err != nil {
		return err
	}
	info, err := tmp.Stat()
	if err != nil {
		return err
	}

	zr, err := zip.NewReader(tmp, info.Size())
	if err != nil {
		return err
	}

	for _, f := range zr.File {
		if err := extractZipEntry(f, dir); err != nil {
			return err
		}
	}
	return nil
}

func extractZipEntry(f *zip.File, dir string) error {
	target, err := safeJoin(dir, f.Name)
	if err != nil {
		return err
	}

	if f.FileInfo().IsDir() {
		return os.MkdirAll(target, 0o755)
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}

	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode())
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, rc)
	return err
}

// safeJoin joins dir and name, rejecting entries that would escape dir (zip-slip protection).
func safeJoin(dir, name string) (string, error) {
	target := filepath.Join(dir, name)
	cleanDir := filepath.Clean(dir)
	if target != cleanDir && !strings.HasPrefix(target, cleanDir+string(os.PathSeparator)) {
		return "", fmt.Errorf("invalid archive entry path %q", name)
	}
	return target, nil
}
