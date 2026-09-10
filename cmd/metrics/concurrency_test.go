package metrics

import "testing"

// TestConcurrencyBucketDefault guards the documented --bucket default. time.Duration's
// String() would render time.Hour as "1h0m0s", so the flag must use the "1h" text that
// README and SKILL.md advertise.
func TestConcurrencyBucketDefault(t *testing.T) {
	flag := NewConcurrencyCmd().Flags().Lookup("bucket")
	if flag == nil {
		t.Fatal("--bucket flag is not registered")
	}
	if flag.DefValue != "1h" {
		t.Fatalf("--bucket default = %q, want \"1h\"", flag.DefValue)
	}
}
