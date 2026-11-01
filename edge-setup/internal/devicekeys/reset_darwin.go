//go:build darwin

package devicekeys

import (
	"errors"
	"runtime"
	"strings"
	"unsafe"
)

type darwinResetBindings struct {
	secItemDelete          func(uintptr) int32
	cfGetTypeID            func(uintptr) uintptr
	cfArrayGetTypeID       func() uintptr
	cfDictionaryGetTypeID  func() uintptr
	cfStringGetTypeID      func() uintptr
	cfArrayGetCount        func(uintptr) int
	cfArrayGetValueAtIndex func(uintptr, int) uintptr
	cfDictionaryGetValue   func(uintptr, uintptr) uintptr
	cfStringGetLength      func(uintptr) int
	cfStringGetCString     func(uintptr, unsafe.Pointer, int, uint32) uint8
	secReturnAttributes    uintptr
	secMatchLimitAll       uintptr
}

func (a *darwinSecItemAPI) loadResetBindings(security, coreFoundation uintptr) error {
	b := &a.reset
	for _, symbol := range []struct {
		destination any
		library     uintptr
		name        string
	}{
		{&b.secItemDelete, security, "SecItemDelete"},
		{&b.cfGetTypeID, coreFoundation, "CFGetTypeID"},
		{&b.cfArrayGetTypeID, coreFoundation, "CFArrayGetTypeID"},
		{&b.cfDictionaryGetTypeID, coreFoundation, "CFDictionaryGetTypeID"},
		{&b.cfStringGetTypeID, coreFoundation, "CFStringGetTypeID"},
		{&b.cfArrayGetCount, coreFoundation, "CFArrayGetCount"},
		{&b.cfArrayGetValueAtIndex, coreFoundation, "CFArrayGetValueAtIndex"},
		{&b.cfDictionaryGetValue, coreFoundation, "CFDictionaryGetValue"},
		{&b.cfStringGetLength, coreFoundation, "CFStringGetLength"},
		{&b.cfStringGetCString, coreFoundation, "CFStringGetCString"},
	} {
		if err := registerFunction(symbol.destination, symbol.library, symbol.name); err != nil {
			return err
		}
	}
	for _, constant := range []struct {
		destination *uintptr
		name        string
	}{{&b.secReturnAttributes, "kSecReturnAttributes"}, {&b.secMatchLimitAll, "kSecMatchLimitAll"}} {
		value, err := loadCFReference(security, constant.name)
		if err != nil {
			return err
		}
		*constant.destination = value
	}
	return nil
}

type keychainAccountsResult struct {
	accounts []string
	status   secStatus
}

// accounts requests attributes only for this tool's generic-password service.
// It never requests or copies any item's value data.
func (a *darwinSecItemAPI) accounts(service string) ([]string, secStatus, error) {
	serviceRef, err := a.stringRef(service)
	if err != nil {
		return nil, 0, err
	}
	defer a.release(serviceRef)
	query, err := a.dictionary(
		cfPair{a.secClassKey, a.secClassGenericPassword},
		cfPair{a.secAttrService, serviceRef},
		cfPair{a.reset.secReturnAttributes, a.cfBooleanTrue},
		cfPair{a.secMatchLimit, a.reset.secMatchLimitAll},
	)
	if err != nil {
		return nil, 0, err
	}
	defer a.release(query)
	result, err := withUserInteractionDisabled[keychainAccountsResult](a, func() (keychainAccountsResult, error) {
		var items uintptr
		status := secStatus(a.secItemCopyMatching(query, &items))
		defer a.release(items)
		if status != statusSuccess {
			return keychainAccountsResult{status: status}, nil
		}
		if items == 0 || a.reset.cfGetTypeID(items) != a.reset.cfArrayGetTypeID() {
			return keychainAccountsResult{}, errors.New("macOS reset key inventory did not return an array")
		}
		count := a.reset.cfArrayGetCount(items)
		if count < 0 || count > 256 {
			return keychainAccountsResult{}, errors.New("macOS reset key inventory is too large")
		}
		accounts := make([]string, 0, count)
		for i := 0; i < count; i++ {
			item := a.reset.cfArrayGetValueAtIndex(items, i)
			if item == 0 || a.reset.cfGetTypeID(item) != a.reset.cfDictionaryGetTypeID() {
				return keychainAccountsResult{}, errors.New("macOS reset key attributes have an invalid type")
			}
			account := a.reset.cfDictionaryGetValue(item, a.secAttrAccount)
			if account == 0 || a.reset.cfGetTypeID(account) != a.reset.cfStringGetTypeID() {
				return keychainAccountsResult{}, errors.New("macOS reset key account has an invalid type")
			}
			length := a.reset.cfStringGetLength(account)
			if length <= 0 || length > 128 {
				return keychainAccountsResult{}, errors.New("macOS reset key account has an invalid length")
			}
			var buffer [513]byte
			ok := a.reset.cfStringGetCString(account, unsafe.Pointer(&buffer[0]), len(buffer), cfStringEncodingUTF8)
			runtime.KeepAlive(buffer)
			end := strings.IndexByte(string(buffer[:]), 0)
			// Connector accounts are ASCII. Reject embedded NUL and Unicode
			// rather than truncating a name before an exact deletion query.
			if ok == 0 || end != length {
				return keychainAccountsResult{}, errors.New("macOS reset key account could not be decoded exactly")
			}
			accounts = append(accounts, string(buffer[:end]))
		}
		return keychainAccountsResult{accounts: accounts, status: status}, nil
	}, nil)
	if err != nil {
		return nil, 0, err
	}
	return result.accounts, result.status, nil
}

// remove has the same exact class/service/account scope as read and update.
// SecItemDelete receives no return keys or broad service-only deletion query.
func (a *darwinSecItemAPI) remove(service, account string) (secStatus, error) {
	serviceRef, err := a.stringRef(service)
	if err != nil {
		return 0, err
	}
	defer a.release(serviceRef)
	accountRef, err := a.stringRef(account)
	if err != nil {
		return 0, err
	}
	defer a.release(accountRef)
	query, err := a.dictionary(
		cfPair{a.secClassKey, a.secClassGenericPassword},
		cfPair{a.secAttrService, serviceRef},
		cfPair{a.secAttrAccount, accountRef},
	)
	if err != nil {
		return 0, err
	}
	defer a.release(query)
	return withUserInteractionDisabled[secStatus](a, func() (secStatus, error) {
		return secStatus(a.reset.secItemDelete(query)), nil
	}, nil)
}
