#!/usr/bin/env python3
# Sends WM_DELETE_WINDOW to an X window, as a window manager does when the
# user clicks the close button (Xvfb has no window manager). Used by
# scripts/linux-e2e.ts.  wm-close.py <window id>
#
# Every libX11 call has its argument and return types declared: ctypes would
# otherwise pass the Display pointer as a 32-bit int and truncate it.
import ctypes
import sys

x = ctypes.cdll.LoadLibrary("libX11.so.6")
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XInternAtom.restype = ctypes.c_ulong


class ClientMessage(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]


class XEvent(ctypes.Union):
    _fields_ = [("xclient", ClientMessage), ("pad", ctypes.c_long * 24)]


x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
x.XSendEvent.restype = ctypes.c_int
x.XFlush.argtypes = [ctypes.c_void_p]
x.XFlush.restype = ctypes.c_int
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
x.XCloseDisplay.restype = ctypes.c_int

display = x.XOpenDisplay(None)
if not display:
    sys.exit("wm-close.py: cannot open the X display")
window = int(sys.argv[1])
event = XEvent()
event.xclient.type = 33  # ClientMessage
event.xclient.window = window
event.xclient.message_type = x.XInternAtom(display, b"WM_PROTOCOLS", 0)
event.xclient.format = 32
event.xclient.data[0] = x.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
if not x.XSendEvent(display, window, 0, 0, ctypes.byref(event)):
    sys.exit("wm-close.py: XSendEvent failed")
x.XFlush(display)
x.XCloseDisplay(display)
