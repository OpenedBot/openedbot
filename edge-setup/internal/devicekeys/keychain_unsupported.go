//go:build !darwin

package devicekeys

func newNativeSecItemAPI() (secItemAPI, error) {
	return nil, ErrUnsupported
}
