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
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download %s: unexpected status %s", url, resp.Status)
	}

	if strings.HasSuffix(url, ".zip") {
		return extractZip(resp.Body, dir)
	}
	return extractTarGz(resp.Body, dir)
}

func extractTarGz(r io.Reader, dir string) error {
	root, err := openExtractRoot(dir)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()

	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer func() { _ = gz.Close() }()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		name := filepath.Clean(header.Name)
		if name == "." {
			continue
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := extractTarFile(root, tr, name, header); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := extractSymlink(root, name, header.Linkname); err != nil {
				return err
			}
		}
	}
}

func extractTarFile(root *os.Root, tr *tar.Reader, name string, header *tar.Header) error {
	if err := mkdirParent(root, name); err != nil {
		return err
	}
	out, err := root.OpenFile(name, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, os.FileMode(header.Mode))
	if err != nil {
		return err
	}
	// Preserve the copy error, but still surface a close error that may signal
	// an incomplete write.
	if _, err := io.Copy(out, tr); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// extractSymlink creates a symlink entry, rejecting targets that are absolute or
// resolve outside the extraction root to prevent symlink-traversal attacks.
func extractSymlink(root *os.Root, name, linkname string) error {
	if err := validateSymlinkTarget(name, linkname); err != nil {
		return err
	}
	if err := mkdirParent(root, name); err != nil {
		return err
	}
	_ = root.Remove(name)
	return root.Symlink(linkname, name)
}

func extractZip(r io.Reader, dir string) error {
	root, err := openExtractRoot(dir)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()

	// zip.Reader requires io.ReaderAt, so the download is buffered to a temp file first.
	tmp, err := os.CreateTemp("", "actions-runner-*.zip")
	if err != nil {
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()

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
		if err := extractZipEntry(root, f); err != nil {
			return err
		}
	}
	return nil
}

func extractZipEntry(root *os.Root, f *zip.File) error {
	name := filepath.Clean(f.Name)
	if name == "." {
		return nil
	}

	if f.FileInfo().IsDir() {
		return root.MkdirAll(name, 0o755)
	}

	if err := mkdirParent(root, name); err != nil {
		return err
	}

	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer func() { _ = rc.Close() }()

	out, err := root.OpenFile(name, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, f.Mode())
	if err != nil {
		return err
	}
	// Preserve the copy error, but still surface a close error that may signal
	// an incomplete write.
	if _, err := io.Copy(out, rc); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// openExtractRoot creates dir if needed and opens it as an os.Root so that every
// extraction operation is confined to dir, even across pre-existing or archive
// symlinks.
func openExtractRoot(dir string) (*os.Root, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return os.OpenRoot(dir)
}

// mkdirParent creates the parent directory of name within root, if any.
func mkdirParent(root *os.Root, name string) error {
	if parent := filepath.Dir(name); parent != "." {
		return root.MkdirAll(parent, 0o755)
	}
	return nil
}

// validateSymlinkTarget rejects symlink targets that are absolute or resolve
// outside the extraction root.
func validateSymlinkTarget(name, linkname string) error {
	if filepath.IsAbs(linkname) {
		return fmt.Errorf("refusing to extract symlink %q with absolute target %q", name, linkname)
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(name), linkname))
	if resolved == ".." || strings.HasPrefix(resolved, ".."+string(os.PathSeparator)) {
		return fmt.Errorf("refusing to extract symlink %q with target %q escaping the archive root", name, linkname)
	}
	return nil
}
