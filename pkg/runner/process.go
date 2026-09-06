package runner

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
)

// ConfigOptions holds the parameters passed to the runner agent's config script.
type ConfigOptions struct {
	URL             string
	Token           string
	Name            string
	Labels          string
	NoDefaultLabels bool
	RunnerGroup     string
	WorkDir         string
	Replace         bool
	Ephemeral       bool
}

// IsConfigured reports whether a runner agent has already been registered in dir.
func IsConfigured(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".runner"))
	return err == nil
}

// scriptPath resolves name in dir to an absolute path, because exec resolves a
// relative program path against Cmd.Dir and would prepend dir twice.
func scriptPath(dir, name string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	return filepath.Join(abs, name), nil
}

func configScript(dir string) (string, error) {
	if runtime.GOOS == "windows" {
		return scriptPath(dir, "config.cmd")
	}
	return scriptPath(dir, "config.sh")
}

func runScript(dir string) (string, error) {
	if runtime.GOOS == "windows" {
		return scriptPath(dir, "run.cmd")
	}
	return scriptPath(dir, "run.sh")
}

// Configure runs the runner agent's config script to register it with GitHub.
func Configure(dir string, opts ConfigOptions) error {
	args := []string{"--url", opts.URL, "--token", opts.Token, "--unattended"}
	if opts.Name != "" {
		args = append(args, "--name", opts.Name)
	}
	if opts.Labels != "" {
		args = append(args, "--labels", opts.Labels)
	}
	if opts.NoDefaultLabels {
		args = append(args, "--no-default-labels")
	}
	if opts.RunnerGroup != "" {
		args = append(args, "--runnergroup", opts.RunnerGroup)
	}
	if opts.WorkDir != "" {
		args = append(args, "--work", opts.WorkDir)
	}
	if opts.Replace {
		args = append(args, "--replace")
	}
	if opts.Ephemeral {
		args = append(args, "--ephemeral")
	}

	script, err := configScript(dir)
	if err != nil {
		return err
	}

	cmd := exec.Command(script, args...)
	cmd.Dir = dir
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Unconfigure runs the runner agent's config script to delete its registration
// from GitHub. It is a no-op when the agent in dir is not registered.
func Unconfigure(dir string, token string) error {
	if !IsConfigured(dir) {
		return nil
	}

	script, err := configScript(dir)
	if err != nil {
		return err
	}

	cmd := exec.Command(script, "remove", "--token", token)
	cmd.Dir = dir
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Run executes the runner agent's run script in the foreground until it exits,
// forwarding interrupt (SIGINT) and termination (SIGTERM) signals so the agent
// can perform its own graceful shutdown. SIGTERM matters for container and
// systemd deployments, where it is the standard stop signal.
func Run(dir string) error {
	script, err := runScript(dir)
	if err != nil {
		return err
	}

	cmd := exec.Command(script)
	cmd.Dir = dir
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return err
	}

	sigCh := make(chan os.Signal, 1)
	// SIGTERM is a no-op on Windows; forwarding it there simply fails silently.
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	for {
		select {
		case sig := <-sigCh:
			// Best effort: forward the signal so the agent can shut down gracefully.
			_ = cmd.Process.Signal(sig)
		case err := <-done:
			return err
		}
	}
}
