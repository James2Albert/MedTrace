"""Decodes QR matrices (JSON on stdin) with the system libzbar to verify server/qr.js.
Usage: node -e "..." | python3 test/tools/qr-zbar-check.py"""
import ctypes, ctypes.util, json, sys

lib = ctypes.CDLL(ctypes.util.find_library('zbar') or 'libzbar.so.0')
lib.zbar_image_scanner_create.restype = ctypes.c_void_p
lib.zbar_image_scanner_set_config.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
lib.zbar_image_create.restype = ctypes.c_void_p
lib.zbar_image_set_format.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
lib.zbar_image_set_size.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]
lib.zbar_image_set_data.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
lib.zbar_scan_image.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
lib.zbar_image_first_symbol.argtypes = [ctypes.c_void_p]
lib.zbar_image_first_symbol.restype = ctypes.c_void_p
lib.zbar_symbol_get_data.argtypes = [ctypes.c_void_p]
lib.zbar_symbol_get_data.restype = ctypes.c_char_p

def decode(matrix, scale=6, border=4):
    n = len(matrix); dim = (n + 2 * border) * scale
    pixels = bytearray([255]) * (dim * dim)
    for y, row in enumerate(matrix):
        for x, dark in enumerate(row):
            if dark:
                for dy in range(scale):
                    start = ((y + border) * scale + dy) * dim + (x + border) * scale
                    pixels[start:start + scale] = bytes(scale)
    scanner = lib.zbar_image_scanner_create()
    lib.zbar_image_scanner_set_config(scanner, 0, 0, 1)
    img = lib.zbar_image_create()
    lib.zbar_image_set_format(img, int.from_bytes(b'Y800', 'little'))
    lib.zbar_image_set_size(img, dim, dim)
    buf = ctypes.create_string_buffer(bytes(pixels), len(pixels))
    lib.zbar_image_set_data(img, buf, len(pixels), None)
    if lib.zbar_scan_image(scanner, img) <= 0:
        return None
    return lib.zbar_symbol_get_data(lib.zbar_image_first_symbol(img)).decode()

cases = json.load(sys.stdin)
failed = 0
for case in cases:
    got = decode(case['matrix'])
    ok = got == case['text']
    failed += not ok
    print(('OK  ' if ok else 'FAIL') + f" v{(len(case['matrix']) - 17) // 4} {case['text'][:60]!r} -> {got!r}")
sys.exit(1 if failed else 0)
