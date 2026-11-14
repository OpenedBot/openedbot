package audit

import "runtime"

func runtimeCPUs() int { return runtime.NumCPU() }
