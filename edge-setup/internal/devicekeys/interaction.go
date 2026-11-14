package devicekeys

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
)

type userInteractionPolicy interface {
	getUserInteractionAllowed() (bool, error)
	setUserInteractionAllowed(bool) error
}

var userInteractionScopeMu sync.Mutex

// withUserInteractionDisabled prevents file-keychain UI for one operation,
// then restores the previous Security.framework policy on the same OS thread.
func withUserInteractionDisabled[T any](
	policy userInteractionPolicy,
	operation func() (T, error),
	wipeResult func(T),
) (result T, err error) {
	userInteractionScopeMu.Lock()
	defer userInteractionScopeMu.Unlock()
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	previous, err := policy.getUserInteractionAllowed()
	if err != nil {
		return result, fmt.Errorf("read keychain user interaction policy: %w", err)
	}
	if err := policy.setUserInteractionAllowed(false); err != nil {
		restoreErr := policy.setUserInteractionAllowed(previous)
		if restoreErr != nil {
			return result, errors.Join(
				fmt.Errorf("disable keychain user interaction: %w", err),
				fmt.Errorf("restore keychain user interaction policy: %w", restoreErr),
			)
		}
		return result, fmt.Errorf("disable keychain user interaction: %w", err)
	}

	defer func() {
		restoreErr := policy.setUserInteractionAllowed(previous)
		if restoreErr != nil {
			if wipeResult != nil {
				wipeResult(result)
			}
			var zero T
			result = zero
			restoreErr = fmt.Errorf("restore keychain user interaction policy: %w", restoreErr)
			if err != nil {
				err = errors.Join(err, restoreErr)
			} else {
				err = restoreErr
			}
			return
		}
		if err != nil {
			if wipeResult != nil {
				wipeResult(result)
			}
			var zero T
			result = zero
		}
	}()

	result, err = operation()
	return result, err
}
