package kitutil

import "testing"

func TestResolveRunTarget(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		repoFlag    string
		attempt     int
		wantRepo    string
		wantHost    string
		wantAttempt int
		wantErr     bool
	}{
		{name: "run ID with --repo", input: "12", repoFlag: "octo/app", wantRepo: "octo/app"},
		{name: "URL", input: "https://ghe.example.com/octo/app/actions/runs/12", wantRepo: "octo/app", wantHost: "ghe.example.com"},
		{name: "URL with matching --repo", input: "https://ghe.example.com/octo/app/actions/runs/12", repoFlag: "Octo/App", wantRepo: "octo/app", wantHost: "ghe.example.com"},
		{name: "URL with conflicting --repo", input: "https://github.com/octo/app/actions/runs/12", repoFlag: "octo/other", wantErr: true},
		{name: "URL with conflicting host", input: "https://github.com/octo/app/actions/runs/12", repoFlag: "ghe.example.com/octo/app", wantErr: true},
		{name: "--attempt", input: "12", repoFlag: "octo/app", attempt: 2, wantRepo: "octo/app", wantAttempt: 2},
		{name: "matching attempts", input: "https://github.com/octo/app/actions/runs/12/attempts/2", attempt: 2, wantRepo: "octo/app", wantAttempt: 2},
		{name: "conflicting attempts", input: "https://github.com/octo/app/actions/runs/12/attempts/2", attempt: 3, wantErr: true},
		{name: "negative attempt", input: "12", repoFlag: "octo/app", attempt: -1, wantErr: true},
		{name: "invalid reference", input: "abc", repoFlag: "octo/app", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo, ref, err := ResolveRunTarget(tt.input, tt.repoFlag, tt.attempt)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ResolveRunTarget() = %v %+v, want error", repo, ref)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveRunTarget() error = %v", err)
			}
			if got := repo.Owner + "/" + repo.Name; got != tt.wantRepo {
				t.Errorf("repo = %s, want %s", got, tt.wantRepo)
			}
			if tt.wantHost != "" && repo.Host != tt.wantHost {
				t.Errorf("host = %s, want %s", repo.Host, tt.wantHost)
			}
			if ref.Attempt != tt.wantAttempt || ref.RunID != 12 {
				t.Errorf("ref = %+v, want run 12 attempt %d", ref, tt.wantAttempt)
			}
		})
	}
}
