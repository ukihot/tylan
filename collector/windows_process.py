"""Windows process containment. The only module that owns Job Object handles."""

from __future__ import annotations

import ctypes as C
import os
import subprocess
import time
from ctypes import wintypes as W

if os.name == "nt":
    kernel = C.WinDLL("kernel32", use_last_error=True)


class Security(C.Structure):
    _fields_ = [("length", W.DWORD), ("descriptor", W.LPVOID), ("inherit", W.BOOL)]


class Startup(C.Structure):
    _fields_ = [
        ("cb", W.DWORD),
        ("reserved", W.LPWSTR),
        ("desktop", W.LPWSTR),
        ("title", W.LPWSTR),
        ("x", W.DWORD),
        ("y", W.DWORD),
        ("xSize", W.DWORD),
        ("ySize", W.DWORD),
        ("xChars", W.DWORD),
        ("yChars", W.DWORD),
        ("fill", W.DWORD),
        ("flags", W.DWORD),
        ("show", W.WORD),
        ("reserved2", W.WORD),
        ("reservedPtr", C.POINTER(C.c_byte)),
        ("stdin", W.HANDLE),
        ("stdout", W.HANDLE),
        ("stderr", W.HANDLE),
    ]


class ProcessInfo(C.Structure):
    _fields_ = [("process", W.HANDLE), ("thread", W.HANDLE), ("pid", W.DWORD), ("tid", W.DWORD)]


class BasicLimit(C.Structure):
    _fields_ = [
        ("processTime", C.c_longlong),
        ("jobTime", C.c_longlong),
        ("flags", W.DWORD),
        ("minWorking", C.c_size_t),
        ("maxWorking", C.c_size_t),
        ("activeLimit", W.DWORD),
        ("affinity", C.c_size_t),
        ("priority", W.DWORD),
        ("scheduling", W.DWORD),
    ]


class IoCounters(C.Structure):
    _fields_ = [
        (name, C.c_ulonglong)
        for name in ("readOps", "writeOps", "otherOps", "readBytes", "writeBytes", "otherBytes")
    ]


class ExtendedLimit(C.Structure):
    _fields_ = [
        ("basic", BasicLimit),
        ("io", IoCounters),
        ("processMemory", C.c_size_t),
        ("jobMemory", C.c_size_t),
        ("peakProcess", C.c_size_t),
        ("peakJob", C.c_size_t),
    ]


class Accounting(C.Structure):
    _fields_ = [
        ("user", C.c_longlong),
        ("kernel", C.c_longlong),
        ("periodUser", C.c_longlong),
        ("periodKernel", C.c_longlong),
        ("pageFault", W.DWORD),
        ("total", W.DWORD),
        ("active", W.DWORD),
        ("terminated", W.DWORD),
    ]


def checked(result):
    if not result:
        raise C.WinError(C.get_last_error())
    return result


def configure():
    signatures = {
        "CreateJobObjectW": ([W.LPVOID, W.LPCWSTR], W.HANDLE),
        "SetInformationJobObject": ([W.HANDLE, C.c_int, W.LPVOID, W.DWORD], W.BOOL),
        "AssignProcessToJobObject": ([W.HANDLE, W.HANDLE], W.BOOL),
        "TerminateJobObject": ([W.HANDLE, W.UINT], W.BOOL),
        "QueryInformationJobObject": ([W.HANDLE, C.c_int, W.LPVOID, W.DWORD, W.LPVOID], W.BOOL),
        "CreateFileW": (
            [W.LPCWSTR, W.DWORD, W.DWORD, W.LPVOID, W.DWORD, W.DWORD, W.HANDLE],
            W.HANDLE,
        ),
        "CreateProcessW": (
            [
                W.LPCWSTR,
                W.LPWSTR,
                W.LPVOID,
                W.LPVOID,
                W.BOOL,
                W.DWORD,
                W.LPVOID,
                W.LPCWSTR,
                C.POINTER(Startup),
                C.POINTER(ProcessInfo),
            ],
            W.BOOL,
        ),
        "ResumeThread": ([W.HANDLE], W.DWORD),
        "CloseHandle": ([W.HANDLE], W.BOOL),
        "GetExitCodeProcess": ([W.HANDLE, C.POINTER(W.DWORD)], W.BOOL),
        "TerminateProcess": ([W.HANDLE, W.UINT], W.BOOL),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = arguments, result


class WindowsRun:
    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("Windows containment is required; active collection disabled")
        configure()
        self.job = checked(kernel.CreateJobObjectW(None, None))
        self.handles = []
        limits = ExtendedLimit()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        try:
            checked(kernel.SetInformationJobObject(self.job, 9, C.byref(limits), C.sizeof(limits)))
        except Exception:
            self.close()
            raise

    def spawn(self, arguments, stdout, stderr):
        outputs = []
        security = Security(C.sizeof(Security), None, True)
        try:
            for name, access in (
                ("NUL", 0x80000000),
                (str(stdout), 0x40000000),
                (str(stderr), 0x40000000),
            ):
                handle = kernel.CreateFileW(
                    name, access, 3, C.byref(security), 3 if name == "NUL" else 2, 0x80, None
                )
                if handle == W.HANDLE(-1).value:
                    raise C.WinError(C.get_last_error())
                outputs.append(handle)
            startup, info = Startup(), ProcessInfo()
            startup.cb, startup.flags = C.sizeof(Startup), 0x100 | 1
            startup.stdin, startup.stdout, startup.stderr = outputs
            command = C.create_unicode_buffer(subprocess.list2cmdline(list(map(str, arguments))))
            checked(
                kernel.CreateProcessW(
                    None,
                    command,
                    None,
                    None,
                    True,
                    0x4 | 0x08000000 | 0x200,
                    None,
                    None,
                    C.byref(startup),
                    C.byref(info),
                )
            )
            try:
                checked(kernel.AssignProcessToJobObject(self.job, info.process))
                if kernel.ResumeThread(info.thread) == 0xFFFFFFFF:
                    raise C.WinError(C.get_last_error())
                self.handles.append(info.process)
                return info.process
            except Exception:
                kernel.TerminateProcess(info.process, 1)
                kernel.CloseHandle(info.process)
                raise
            finally:
                kernel.CloseHandle(info.thread)
        finally:
            for handle in outputs:
                kernel.CloseHandle(handle)

    def poll(self, handle):
        code = W.DWORD()
        checked(kernel.GetExitCodeProcess(handle, C.byref(code)))
        return None if code.value == 259 else code.value

    def stop(self):
        if self.job:
            checked(kernel.TerminateJobObject(self.job, 1))
            limit = time.monotonic() + 5
            while time.monotonic() < limit:
                account = Accounting()
                checked(
                    kernel.QueryInformationJobObject(
                        self.job, 1, C.byref(account), C.sizeof(account), None
                    )
                )
                if not account.active:
                    return
                time.sleep(0.01)
            raise RuntimeError("owned descendants did not exit")

    def active_count(self):
        account = Accounting()
        checked(
            kernel.QueryInformationJobObject(self.job, 1, C.byref(account), C.sizeof(account), None)
        )
        return account.active

    def close(self):
        if getattr(self, "job", None):
            kernel.CloseHandle(self.job)
            self.job = None
        for handle in getattr(self, "handles", []):
            kernel.CloseHandle(handle)
        self.handles = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.stop()
        self.close()
