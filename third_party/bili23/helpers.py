"""Minimal helper functions adapted from Bili23 Downloader.

Source project:
- https://github.com/ScottSloan/Bili23-Downloader
- upstream commit: 11bc6e6de2ca2c9eb9eee4ed8b82a235dfe285a9

This file keeps only the small, non-GUI helpers needed by the harness:
- AV -> BV conversion
- WBI signing
"""

from __future__ import annotations

from functools import reduce
from hashlib import md5
import time
import urllib.parse

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]


def aid_to_bvid(aid: int) -> str:
    xor_code = 23442827791579
    max_aid = 1 << 51
    alphabet = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf"
    encode_map = (8, 7, 0, 5, 1, 3, 2, 4, 6)

    bvid = [""] * 9
    tmp = (max_aid | aid) ^ xor_code

    for index in range(len(encode_map)):
        bvid[encode_map[index]] = alphabet[tmp % len(alphabet)]
        tmp //= len(alphabet)

    return "BV1" + "".join(bvid)


def build_wbi_query(params: dict[str, object], *, img_key: str, sub_key: str) -> str:
    def get_mixin_key(orig: str) -> str:
        return reduce(lambda s, i: s + orig[i], MIXIN_KEY_ENC_TAB, "")[:32]

    mixin_key = get_mixin_key(img_key + sub_key)
    signed_params = dict(params)
    signed_params["wts"] = round(time.time())
    signed_params = dict(sorted(signed_params.items()))
    signed_params = {
        key: "".join(ch for ch in str(value) if ch not in "!'()*")
        for key, value in signed_params.items()
    }

    query = urllib.parse.urlencode(signed_params)
    signed_params["w_rid"] = md5((query + mixin_key).encode()).hexdigest()
    return urllib.parse.urlencode(signed_params)
