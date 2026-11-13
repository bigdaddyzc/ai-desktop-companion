"""Install the pinned Windows native-test compiler locally, never on PATH."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".tools"
NAME = "zig-windows-x86_64-0.13.0"
SHA256 = "d859994725ef9402381e557c60bb57497215682e355204d754ee3df75ee3c158"
URL = f"https://ziglang.org/download/0.13.0/{NAME}.zip"


def main():
    TOOLS.mkdir(exist_ok=True)
    archive = TOOLS / f"{NAME}.zip"
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        print("Downloading pinned native C++ test compiler (Zig 0.13.0)...", flush=True)
        # Bounded range downloads avoid a single very slow CDN connection. Every
        # response range/length and the final pinned digest are checked.
        size, step = 79163968, 1024 * 1024
        def part(index):
            start, end = index * step, min(size, (index + 1) * step) - 1
            for attempt in range(3):
                try:
                    request = urllib.request.Request(URL, headers={"Range": f"bytes={start}-{end}"})
                    with urllib.request.urlopen(request, timeout=60) as response:
                        if response.headers.get("Content-Range") != f"bytes {start}-{end}/{size}":
                            raise RuntimeError("Unexpected compiler download range")
                        data = response.read()
                        if len(data) != end - start + 1:
                            raise RuntimeError("Incomplete compiler download range")
                        return data
                except Exception:
                    if attempt == 2:
                        raise
        with ThreadPoolExecutor(max_workers=8) as workers, archive.open("wb") as dest:
            for data in workers.map(part, range((size + step - 1) // step)):
                dest.write(data)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise RuntimeError("Compiler archive checksum mismatch; refusing to extract")
    if (TOOLS / NAME / "zig.exe").exists():
        return
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            target = (TOOLS / member.filename).resolve()
            if not target.is_relative_to((TOOLS / NAME).resolve()):
                raise RuntimeError("Archive member outside compiler directory")
        z.extractall(TOOLS)
    print("Native test compiler ready (local .tools only).", flush=True)


if __name__ == "__main__":
    main()
