import os, sys, subprocess, argparse, requests, tempfile, pathlib

DEOBF_MAP = {
    "prometheus": (
        lambda txt: ("prometheus" in txt.lower() or "phrometeus" in txt.lower()),
        "python Phrometeus-Deobfuscator/deobfuscate.py {src}"
    ),
    "luraph": (
        lambda txt: "luraph" in txt.lower(),
        "python Luraph-14.6/deobfuscate.py {src}"
    ),
    "wearedevs": (
        lambda txt: "wearedevs" in txt.lower(),
        "node WeAreDevs-Deobfuscator/deobfuscate.js {src}"
    ),
    "moonsec_v3": (
        lambda txt: ("moonsec" in txt.lower() and "v3" in txt.lower()),
        "python MoonSecV3-Deobfuscator/main.py {src}"
    ),
    "hercules": (
        lambda txt: "hercules" in txt.lower(),
        "python Hercules-Deobfuscator/deobfuscate.py {src}"
    ),
    "clyde": (
        lambda txt: "clyde" in txt.lower(),
        "python Clyde-Deobfuscator/deobfuscate.py {src}"
    ),
    "ironveil": (
        lambda txt: "ironveil" in txt.lower(),
        "python IronVeil-Deobfuscator/ironveil.py {src}"
    ),
    "moonveil2": (
        lambda txt: ("moonveil" in txt.lower() and "2" in txt.lower()),
        "python MoonVeil2-Deobfuscator/deobfuscate.py {src}"
    ),
    "goofyscator": (
        lambda txt: "goofyscator" in txt.lower(),
        "python GoofyScator-Deobfuscator/main.py {src}"
    ),
    "ironbrew2": (
        lambda txt: "ironbrew" in txt.lower(),
        "python IronBrew2-Deobfuscator/deobfuscate.py {src}"
    ),
    "77fuscator": (
        lambda txt: "77fuscator" in txt.lower(),
        "python 77fuscator-Deobfuscator/deobfuscate.py {src}"
    ),
    "luaobfuscator": (
        lambda txt: "luaobfuscator" in txt.lower(),
        "python LuaObfuscator-Deobfuscator/deobfuscate.py {src}"
    ),
}

def fetch_source(path_or_url: str) -> pathlib.Path:
    if path_or_url.startswith(("http://", "https://")):
        r = requests.get(path_or_url)
        r.raise_for_status()
        tmp = pathlib.Path(tempfile.mkdtemp()) / "payload.lua"
        tmp.write_bytes(r.content)
        return tmp
    return pathlib.Path(path_or_url)

def detect_and_run(src_path: pathlib.Path) -> str:
    txt = src_path.read_text(errors="ignore").lower()
    for name, (detect, tmpl) in DEOBF_MAP.items():
        if detect(txt):
            cmd = tmpl.format(src=src_path)
            print(f"Detected {name}, running: {cmd}")
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(f"{name} failed: {result.stderr}")
            return result.stdout
    raise ValueError("Could not detect which obfuscator was used.")

def main():
    parser = argparse.ArgumentParser(description="Run the appropriate de‑obfuscator.")
    parser.add_argument("-i","--input",required=True,help="Path or URL to obfuscated file")
    args = parser.parse_args()
    src = fetch_source(args.input)
    out = detect_and_run(src)
    print("--- DE‑OBFUSCATED OUTPUT START ---")
    print(out)
    print("--- DE‑OBFUSCATED OUTPUT END ---")

if __name__ == "__main__":
    main()
