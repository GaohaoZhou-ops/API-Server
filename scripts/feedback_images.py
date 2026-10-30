"""Bounded, opaque screenshot attachments; no upload is executed or published."""
import base64
import binascii
import hashlib
import struct
import unicodedata
import zlib

MAX_FILES = 5
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 15 * 1024 * 1024
MAX_REQUEST_BYTES = 21 * 1024 * 1024
TYPES = {'image/png': ('.png',), 'image/jpeg': ('.jpg', '.jpeg'), 'image/webp': ('.webp',)}


class ImageError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def dimensions(data, mime):
    # Inspect container signatures, boundaries and dimensions without decoding pixels.
    if mime == 'image/png':
        if data[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError()
        offset, size, pixels = 8, None, False
        while offset + 12 <= len(data):
            length = int.from_bytes(data[offset:offset+4], 'big')
            kind = data[offset+4:offset+8]; end = offset+12+length
            if end > len(data): raise ValueError()
            body = data[offset+8:end-4]
            if zlib.crc32(data[offset+4:end-4]) != int.from_bytes(data[end-4:end], 'big'): raise ValueError()
            if offset == 8:
                if kind != b'IHDR' or length != 13: raise ValueError()
                size = struct.unpack('>II', body[:8])
            elif kind == b'IHDR': raise ValueError()
            if kind == b'IDAT' and length: pixels = True
            if kind == b'IEND':
                if length or end != len(data) or not pixels: raise ValueError()
                return size
            offset = end
    elif mime == 'image/jpeg':
        if data[:2] != b'\xff\xd8' or data[-2:] != b'\xff\xd9': raise ValueError()
        offset, size = 2, None
        while offset+4 <= len(data):
            if data[offset] != 255: raise ValueError()
            while offset < len(data) and data[offset] == 255: offset += 1
            if offset >= len(data): raise ValueError()
            marker = data[offset]; offset += 1
            length = int.from_bytes(data[offset:offset+2], 'big')
            if length < 2 or offset+length > len(data)-2: raise ValueError()
            if marker in (0xc0, 0xc1, 0xc2):
                if length < 8: raise ValueError()
                height, width = struct.unpack('>HH', data[offset+3:offset+7]); size = (width, height)
            if marker == 0xda and size: return size
            offset += length
    elif mime == 'image/webp':
        if data[:4] != b'RIFF' or data[8:12] != b'WEBP' or int.from_bytes(data[4:8], 'little')+8 != len(data): raise ValueError()
        offset, size, extended = 12, None, None
        while offset+8 <= len(data):
            kind = data[offset:offset+4]; length = int.from_bytes(data[offset+4:offset+8], 'little')
            body = data[offset+8:offset+8+length]; offset += 8+length+(length%2)
            if offset > len(data) or len(body) != length: raise ValueError()
            if kind in (b'ANIM', b'ANMF'): raise ValueError()
            if kind == b'VP8X':
                if length != 10 or body[0] & 2: raise ValueError()
                extended = (int.from_bytes(body[4:7], 'little')+1, int.from_bytes(body[7:10], 'little')+1)
            if kind == b'VP8 ':
                if length < 11 or body[3:6] != b'\x9d\x01\x2a' or body[0] & 1: raise ValueError()
                size = tuple(x & 0x3fff for x in struct.unpack('<HH', body[6:10]))
            if kind == b'VP8L':
                if length < 6 or body[0] != 0x2f: raise ValueError()
                bits = int.from_bytes(body[1:5], 'little')
                if bits >> 29: raise ValueError()
                size = ((bits & 0x3fff)+1, ((bits >> 14) & 0x3fff)+1)
        if offset == len(data) and size and (not extended or extended == size): return size
    raise ValueError()


def validate(items):
    if not isinstance(items, list) or len(items) > MAX_FILES:
        raise ImageError(400, '一次最多上传 5 张截图。')
    result, total = [], 0
    for item in items:
        if not isinstance(item, dict) or set(item) != {'name', 'type', 'data'}:
            raise ImageError(400, '截图信息不完整，请重新选择图片。')
        name, mime, encoded = item['name'], item['type'], item['data']
        if not isinstance(name, str) or not 1 <= len(name) <= 200 or any(c in '/\\' or unicodedata.category(c).startswith('C') for c in name):
            raise ImageError(400, '截图文件名无效。')
        if not isinstance(mime, str) or mime not in TYPES or not name.lower().endswith(TYPES[mime]):
            raise ImageError(400, '截图仅支持 PNG、JPG 和 WebP 图片。')
        if not isinstance(encoded, str): raise ImageError(400, '截图数据无效。')
        if len(encoded) > 4*((MAX_FILE_BYTES+2)//3): raise ImageError(413, '每张截图不能超过 5 MB。')
        try: data = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error): raise ImageError(400, '截图数据无效，请重新选择图片。') from None
        if len(data) > MAX_FILE_BYTES: raise ImageError(413, '每张截图不能超过 5 MB。')
        total += len(data)
        if total > MAX_TOTAL_BYTES: raise ImageError(413, '截图总大小不能超过 15 MB。')
        try:
            width, height = dimensions(data, mime)
            if not 1 <= width <= 16384 or not 1 <= height <= 16384 or width*height > 40000000: raise ValueError()
        except (ValueError, IndexError, struct.error):
            raise ImageError(400, '截图格式无效、文件损坏或尺寸过大，请重新选择 PNG、JPG 或 WebP 图片。') from None
        result.append({'name': name, 'mime': mime, 'data': data, 'sha256': hashlib.sha256(data).hexdigest()})
    return result
