import pytest

from app.transfers import (
    chunk_len,
    clean_mime,
    clean_name,
    clean_relative_path,
    num_chunks,
    read_capped,
    recipient_key,
)


def test_chunk_math():
    assert num_chunks(0, 4) == 0 and num_chunks(4, 4) == 1 and num_chunks(5, 4) == 2
    assert [chunk_len(10, 4, n) for n in range(3)] == [4, 4, 2]


@pytest.mark.parametrize("bad", ["../x", "/x", "a//b", "a/./b", "C:\\x", "C:/x", "", "a/..",
                                 "x\\y", "a/" + "b" * 256])
def test_bad_paths(bad):
    with pytest.raises(ValueError):
        clean_relative_path(bad)


def test_paths_are_cleaned():
    assert clean_relative_path("config/gw.json") == "config/gw.json"
    assert clean_relative_path("\u0995\u09cd\u09b7/a.txt") == "\u0995\u09cd\u09b7/a.txt"
    assert clean_relative_path("Cafe\u0301/x") == "Caf\u00e9/x"
    assert clean_relative_path("a\u202Eb/c\u0007d") == "ab/cd"
    # ZWJ/ZWNJ are part of Bangla spelling and must survive
    assert clean_relative_path("\u0995\u200d\u09b7") == "\u0995\u200d\u09b7"


def test_clean_name():
    assert clean_name("  report.pdf ") == "report.pdf"
    assert clean_name("evil\u202Etxt.exe") == "eviltxt.exe"
    for bad in ("", "   ", "a/b", "a\\b", ".", "..", "x" * 300):
        with pytest.raises(ValueError):
            clean_name(bad)


def test_clean_mime():
    assert clean_mime("image/png") == "image/png"
    assert clean_mime("text/html; charset=x") == "application/octet-stream"
    assert clean_mime("") == "application/octet-stream"
    assert clean_mime("a" * 300 + "/b") == "application/octet-stream"


def test_recipient_key():
    assert recipient_key([3, 1, 3], False) == [1, 3]
    assert recipient_key([3, 1], True) == []


class _Req:
    def __init__(self, parts):
        self.parts = parts

    async def stream(self):
        for p in self.parts:
            yield p


@pytest.mark.anyio
async def test_read_capped_stops_past_limit():
    assert await read_capped(_Req([b"ab", b"cd"]), 4) == b"abcd"
    with pytest.raises(ValueError):
        await read_capped(_Req([b"ab", b"cde"]), 4)


@pytest.fixture
def anyio_backend():
    return "asyncio"
