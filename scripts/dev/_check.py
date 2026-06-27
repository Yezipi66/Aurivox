import sys
import os
print("PYTHONPATH:", os.environ.get("PYTHONPATH", "NOT SET"))
print("sys.path entries with tts_broker or gsv_code:")
for p in sys.path:
    if "tts_broker" in p or "gsv_code" in p:
        print(" ", p, "exists:", os.path.isdir(p))
import importlib
try:
    m = importlib.import_module("gsv_code")
    print("import gsv_code OK, file:", m.__file__)
except Exception as e:
    print("import gsv_code FAIL:", e)
