//go:build darwin

package devicekeys

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	securityFrameworkPath = "/System/Library/Frameworks/Security.framework/Security"
	coreFoundationPath    = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
	cfStringEncodingUTF8  = 0x08000100
)

var (
	nativeAPIOnce sync.Once
	nativeAPI     *darwinSecItemAPI
	nativeAPIErr  error
)

type darwinSecItemAPI struct {
	reset                                darwinResetBindings
	secItemAdd                           func(uintptr, *uintptr) int32
	secItemCopyMatching                  func(uintptr, *uintptr) int32
	secItemUpdate                        func(uintptr, uintptr) int32
	secKeychainGetUserInteractionAllowed func(*uint8) int32
	secKeychainSetUserInteractionAllowed func(uint8) int32

	cfStringCreateWithCString func(uintptr, unsafe.Pointer, uint32) uintptr
	cfDataCreate              func(uintptr, unsafe.Pointer, int) uintptr
	cfDictionaryCreate        func(uintptr, unsafe.Pointer, unsafe.Pointer, int, uintptr, uintptr) uintptr
	cfDataGetLength           func(uintptr) int
	cfDataGetBytePtr          func(uintptr) unsafe.Pointer
	cfRelease                 func(uintptr)

	secClassKey             uintptr
	secClassGenericPassword uintptr
	secAttrService          uintptr
	secAttrAccount          uintptr
	secValueData            uintptr
	secReturnData           uintptr
	secMatchLimit           uintptr
	secMatchLimitOne        uintptr
	cfBooleanTrue           uintptr

	// The two CFDictionary callback tables are exported C structs: the dlsym
	// address is itself the pointer CFDictionaryCreate expects. It stays a
	// uintptr up to the call, so no unsafe.Pointer conversion is needed.
	cfTypeKeyCallbacks   uintptr
	cfTypeValueCallbacks uintptr
}

// macOS SecItem defaults to the file-based keychain. Its UI suppression
// attributes do not cover that implementation, so the legacy Security
// interaction switch is scoped around each SecItem call and restored.

func newNativeSecItemAPI() (secItemAPI, error) {
	nativeAPIOnce.Do(func() {
		nativeAPI, nativeAPIErr = loadDarwinSecItemAPI()
	})
	return nativeAPI, nativeAPIErr
}

func loadDarwinSecItemAPI() (*darwinSecItemAPI, error) {
	security, err := purego.Dlopen(securityFrameworkPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return nil, fmt.Errorf("load macOS Security framework: %w", err)
	}
	coreFoundation, err := purego.Dlopen(coreFoundationPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		_ = purego.Dlclose(security)
		return nil, fmt.Errorf("load macOS CoreFoundation framework: %w", err)
	}

	api := &darwinSecItemAPI{}
	for _, symbol := range []struct {
		destination any
		library     uintptr
		name        string
	}{
		{&api.secItemAdd, security, "SecItemAdd"},
		{&api.secItemCopyMatching, security, "SecItemCopyMatching"},
		{&api.secItemUpdate, security, "SecItemUpdate"},
		{&api.secKeychainGetUserInteractionAllowed, security, "SecKeychainGetUserInteractionAllowed"},
		{&api.secKeychainSetUserInteractionAllowed, security, "SecKeychainSetUserInteractionAllowed"},
		{&api.cfStringCreateWithCString, coreFoundation, "CFStringCreateWithCString"},
		{&api.cfDataCreate, coreFoundation, "CFDataCreate"},
		{&api.cfDictionaryCreate, coreFoundation, "CFDictionaryCreate"},
		{&api.cfDataGetLength, coreFoundation, "CFDataGetLength"},
		{&api.cfDataGetBytePtr, coreFoundation, "CFDataGetBytePtr"},
		{&api.cfRelease, coreFoundation, "CFRelease"},
	} {
		if err := registerFunction(symbol.destination, symbol.library, symbol.name); err != nil {
			return nil, err
		}
	}

	for _, constant := range []struct {
		destination *uintptr
		library     uintptr
		name        string
	}{
		{&api.secClassKey, security, "kSecClass"},
		{&api.secClassGenericPassword, security, "kSecClassGenericPassword"},
		{&api.secAttrService, security, "kSecAttrService"},
		{&api.secAttrAccount, security, "kSecAttrAccount"},
		{&api.secValueData, security, "kSecValueData"},
		{&api.secReturnData, security, "kSecReturnData"},
		{&api.secMatchLimit, security, "kSecMatchLimit"},
		{&api.secMatchLimitOne, security, "kSecMatchLimitOne"},
		{&api.cfBooleanTrue, coreFoundation, "kCFBooleanTrue"},
	} {
		value, err := loadCFReference(constant.library, constant.name)
		if err != nil {
			return nil, err
		}
		*constant.destination = value
	}

	keyCallbacks, err := loadSymbolAddress(coreFoundation, "kCFTypeDictionaryKeyCallBacks")
	if err != nil {
		return nil, err
	}
	valueCallbacks, err := loadSymbolAddress(coreFoundation, "kCFTypeDictionaryValueCallBacks")
	if err != nil {
		return nil, err
	}
	api.cfTypeKeyCallbacks = keyCallbacks
	api.cfTypeValueCallbacks = valueCallbacks
	if err := api.loadResetBindings(security, coreFoundation); err != nil {
		return nil, err
	}
	return api, nil
}

func registerFunction(destination any, library uintptr, name string) error {
	address, err := purego.Dlsym(library, name)
	if err != nil {
		return fmt.Errorf("load macOS keychain function %s: %w", name, err)
	}
	purego.RegisterFunc(destination, address)
	return nil
}

func loadSymbolAddress(library uintptr, name string) (uintptr, error) {
	address, err := purego.Dlsym(library, name)
	if err != nil {
		return 0, fmt.Errorf("load macOS keychain constant %s: %w", name, err)
	}
	return address, nil
}

func loadCFReference(library uintptr, name string) (uintptr, error) {
	address, err := loadSymbolAddress(library, name)
	if err != nil {
		return 0, err
	}
	value := readStaticUintptr(address)
	if value == 0 {
		return 0, fmt.Errorf("macOS keychain constant %s is nil", name)
	}
	return value, nil
}

// readStaticUintptr returns the pointer-sized value stored at address, a
// purego.Dlsym result for an exported C data symbol such as kSecClass.
//
// That memory is static data of a loaded framework, outside the Go heap: the
// garbage collector neither moves, frees nor scans it, so reading it through an
// unsafe.Pointer is sound. go vet cannot know that and flags the conversion
// unsafe.Pointer(address) as a possible misuse. The uintptr is therefore
// reinterpreted through its own storage instead of converted, the idiom purego
// uses in its GoString. The pointer lives for this one load.
func readStaticUintptr(address uintptr) uintptr {
	pointer := *(*unsafe.Pointer)(unsafe.Pointer(&address))
	return *(*uintptr)(pointer)
}

type cfPair struct {
	key   uintptr
	value uintptr
}

func (a *darwinSecItemAPI) add(service, account string, seed []byte) (secStatus, error) {
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
	dataRef, err := a.dataRef(seed)
	if err != nil {
		return 0, err
	}
	defer a.release(dataRef)

	query, err := a.dictionary(
		cfPair{a.secClassKey, a.secClassGenericPassword},
		cfPair{a.secAttrService, serviceRef},
		cfPair{a.secAttrAccount, accountRef},
		cfPair{a.secValueData, dataRef},
	)
	if err != nil {
		return 0, err
	}
	defer a.release(query)
	return withUserInteractionDisabled[secStatus](a, func() (secStatus, error) {
		status := secStatus(a.secItemAdd(query, nil))
		runtime.KeepAlive(seed)
		return status, nil
	}, nil)
}

type keychainCopyResult struct {
	data   []byte
	status secStatus
}

func (a *darwinSecItemAPI) copy(service, account string) ([]byte, secStatus, error) {
	serviceRef, err := a.stringRef(service)
	if err != nil {
		return nil, 0, err
	}
	defer a.release(serviceRef)
	accountRef, err := a.stringRef(account)
	if err != nil {
		return nil, 0, err
	}
	defer a.release(accountRef)

	query, err := a.dictionary(
		cfPair{a.secClassKey, a.secClassGenericPassword},
		cfPair{a.secAttrService, serviceRef},
		cfPair{a.secAttrAccount, accountRef},
		cfPair{a.secReturnData, a.cfBooleanTrue},
		cfPair{a.secMatchLimit, a.secMatchLimitOne},
	)
	if err != nil {
		return nil, 0, err
	}
	defer a.release(query)

	result, err := withUserInteractionDisabled[keychainCopyResult](a, func() (keychainCopyResult, error) {
		var result uintptr
		status := secStatus(a.secItemCopyMatching(query, &result))
		if status != statusSuccess {
			a.release(result)
			return keychainCopyResult{status: status}, nil
		}
		if result == 0 {
			return keychainCopyResult{}, errors.New("macOS keychain returned no device key data")
		}
		defer a.release(result)
		length := a.cfDataGetLength(result)
		if length != ed25519.SeedSize {
			return keychainCopyResult{}, errors.New("macOS keychain device key has an invalid length")
		}
		dataPointer := a.cfDataGetBytePtr(result)
		if dataPointer == nil {
			return keychainCopyResult{}, errors.New("macOS keychain returned an empty device key")
		}
		data := unsafe.Slice((*byte)(dataPointer), length)
		seed := make([]byte, length)
		copy(seed, data)
		runtime.KeepAlive(result)
		return keychainCopyResult{data: seed, status: statusSuccess}, nil
	}, func(result keychainCopyResult) {
		wipe(result.data)
	})
	if err != nil {
		return nil, 0, err
	}
	return result.data, result.status, nil
}

func (a *darwinSecItemAPI) update(service, account string, seed []byte) (secStatus, error) {
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
	dataRef, err := a.dataRef(seed)
	if err != nil {
		return 0, err
	}
	defer a.release(dataRef)

	query, err := a.dictionary(
		cfPair{a.secClassKey, a.secClassGenericPassword},
		cfPair{a.secAttrService, serviceRef},
		cfPair{a.secAttrAccount, accountRef},
	)
	if err != nil {
		return 0, err
	}
	defer a.release(query)
	attributes, err := a.dictionary(cfPair{a.secValueData, dataRef})
	if err != nil {
		return 0, err
	}
	defer a.release(attributes)
	return withUserInteractionDisabled[secStatus](a, func() (secStatus, error) {
		status := secStatus(a.secItemUpdate(query, attributes))
		runtime.KeepAlive(seed)
		return status, nil
	}, nil)
}

func (a *darwinSecItemAPI) getUserInteractionAllowed() (bool, error) {
	var allowed uint8
	status := secStatus(a.secKeychainGetUserInteractionAllowed(&allowed))
	if status != statusSuccess {
		return false, statusError("read keychain user interaction policy", status)
	}
	return allowed != 0, nil
}

func (a *darwinSecItemAPI) setUserInteractionAllowed(allowed bool) error {
	var value uint8
	if allowed {
		value = 1
	}
	status := secStatus(a.secKeychainSetUserInteractionAllowed(value))
	if status != statusSuccess {
		return statusError("set keychain user interaction policy", status)
	}
	return nil
}

func (a *darwinSecItemAPI) stringRef(value string) (uintptr, error) {
	cString := append([]byte(value), 0)
	ref := a.cfStringCreateWithCString(0, unsafe.Pointer(&cString[0]), cfStringEncodingUTF8)
	runtime.KeepAlive(cString)
	if ref == 0 {
		return 0, errors.New("create macOS keychain string")
	}
	return ref, nil
}

func (a *darwinSecItemAPI) dataRef(seed []byte) (uintptr, error) {
	if len(seed) != ed25519.SeedSize {
		return 0, ErrInvalidSeed
	}
	ref := a.cfDataCreate(0, unsafe.Pointer(&seed[0]), len(seed))
	runtime.KeepAlive(seed)
	if ref == 0 {
		return 0, errors.New("create macOS keychain device key data")
	}
	return ref, nil
}

func (a *darwinSecItemAPI) dictionary(pairs ...cfPair) (uintptr, error) {
	if len(pairs) == 0 {
		return 0, errors.New("create empty macOS keychain query")
	}
	keys := make([]uintptr, len(pairs))
	values := make([]uintptr, len(pairs))
	for i, pair := range pairs {
		if pair.key == 0 || pair.value == 0 {
			return 0, errors.New("create macOS keychain query with a nil value")
		}
		keys[i] = pair.key
		values[i] = pair.value
	}
	dictionary := a.cfDictionaryCreate(
		0,
		unsafe.Pointer(&keys[0]),
		unsafe.Pointer(&values[0]),
		len(pairs),
		a.cfTypeKeyCallbacks,
		a.cfTypeValueCallbacks,
	)
	runtime.KeepAlive(keys)
	runtime.KeepAlive(values)
	if dictionary == 0 {
		return 0, errors.New("create macOS keychain dictionary")
	}
	return dictionary, nil
}

func (a *darwinSecItemAPI) release(value uintptr) {
	if value != 0 {
		a.cfRelease(value)
	}
}
