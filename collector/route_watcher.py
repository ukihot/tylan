"""Address/route-change notifications; owns no processes and sends no packets."""

import ctypes as C
import os
import threading
from ctypes import wintypes as W


class RouteWatcher:
    def __init__(self):
        self.changed = threading.Event()
        self.handles = []
        if os.name != "nt":
            raise RuntimeError("Windows route notifications unavailable")
        self.api = C.WinDLL("iphlpapi", use_last_error=True)
        callback_type = C.WINFUNCTYPE(None, W.LPVOID, W.LPVOID, C.c_int)
        self.callback = callback_type(lambda *_: self.changed.set())
        try:
            for name in ("NotifyRouteChange2", "NotifyUnicastIpAddressChange"):
                function = getattr(self.api, name)
                function.argtypes = [W.USHORT, callback_type, W.LPVOID, W.BOOL, C.POINTER(W.HANDLE)]
                function.restype = W.ULONG
                handle = W.HANDLE()
                code = function(2, self.callback, None, False, C.byref(handle))
                if code:
                    raise OSError(code, name)
                self.handles.append(handle)
        except Exception:
            self.close()
            raise

    def close(self):
        self.api.CancelMibChangeNotify2.argtypes = [W.HANDLE]
        self.api.CancelMibChangeNotify2.restype = W.ULONG
        for handle in self.handles:
            self.api.CancelMibChangeNotify2(handle)
        self.handles = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
